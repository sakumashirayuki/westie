import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

import type { ExecutionMode } from "../domain/conversation.js";
import type { ServiceProcessManager } from "../application/service-process-manager.js";
import {
  defineTool,
  toJsonValue,
  ToolExecutionError,
  type Tool,
} from "../tools.js";
import type { JsonValue } from "../protocol.js";

const MAX_COMMAND_LENGTH = 4096;
const MAX_NAME_LENGTH = 64;
const MAX_CWD_LENGTH = 4096;
const MAX_TAIL_BYTES = 32_768;
const MIN_TAIL_BYTES = 1024;
const DEFAULT_TAIL_BYTES = 8_192;

const startSchema = z.strictObject({
  action: z.literal("start"),
  command: z.string().min(1).max(MAX_COMMAND_LENGTH),
  name: z.string().max(MAX_NAME_LENGTH).optional(),
  cwd: z.string().max(MAX_CWD_LENGTH).optional(),
});

const listSchema = z.strictObject({
  action: z.literal("list"),
});

const statusSchema = z.strictObject({
  action: z.literal("status"),
  id: z.string().min(1),
});

const logsSchema = z.strictObject({
  action: z.literal("logs"),
  id: z.string().min(1),
  tailBytes: z.number().int().min(MIN_TAIL_BYTES).max(MAX_TAIL_BYTES).optional(),
});

const stopSchema = z.strictObject({
  action: z.literal("stop"),
  id: z.string().min(1),
  force: z.boolean().optional(),
});

const serviceToolInputSchema = z.discriminatedUnion("action", [
  startSchema,
  listSchema,
  statusSchema,
  logsSchema,
  stopSchema,
]);

type ServiceToolInput = z.infer<typeof serviceToolInputSchema>;

export function createServiceTool(
  workspaceRoot: string,
  executionMode: ExecutionMode,
  manager: ServiceProcessManager,
): Tool {
  return defineTool({
    name: "service",
    description:
      "Start and manage a persistent workspace service that outlives the current run " +
      "and can bind network ports. Use for long-running dev servers; query with list, " +
      "status and logs, and stop it explicitly with stop.",
    impact:
      "Starts a process that outlives the run and can bind network ports.",
    looseInputSchema: true,
    inputSchema: serviceToolInputSchema,
    summarizeInput(input: unknown) {
      const parsed = serviceToolInputSchema.safeParse(input);
      if (!parsed.success) return toJsonValue(input);
      return summarizeServiceInput(parsed.data);
    },
    async execute(input, context): Promise<JsonValue> {
      const parsed = serviceToolInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new ToolExecutionError(
          "INVALID_TOOL_INPUT",
          "Invalid service tool input.",
        );
      }
      const data = parsed.data;
      switch (data.action) {
        case "start":
          return startService(workspaceRoot, executionMode, manager, data, context);
        case "list":
          return {
            action: "list",
            services: manager.list(workspaceRoot).map(toJsonValue),
          };
        case "status":
          return {
            action: "status",
            service: toJsonValue(
              await withServiceNotFoundError(
                () => manager.status(data.id, workspaceRoot),
              ),
            ),
          };
        case "logs":
          return toJsonValue(
            await withServiceNotFoundError(
              () => manager.logs(
                data.id,
                workspaceRoot,
                data.tailBytes ?? DEFAULT_TAIL_BYTES,
              ),
            ),
          );
        case "stop":
          return {
            action: "stop",
            service: toJsonValue(
              await withServiceNotFoundError(
                () => manager.stop(data.id, workspaceRoot, data.force ?? false),
              ),
            ),
          };
      }
    },
  });
}

async function startService(
  workspaceRoot: string,
  executionMode: ExecutionMode,
  manager: ServiceProcessManager,
  input: z.infer<typeof startSchema>,
  context: Parameters<Tool["execute"]>[1],
): Promise<JsonValue> {
  const cwd = await resolveServiceCwd(workspaceRoot, input.cwd ?? ".");
  const name = input.name?.trim() || null;
  try {
    const service = await manager.start({
      command: input.command,
      name,
      cwd,
      workspaceRoot,
      executionMode,
      createdByConversationId: context?.conversationId ?? null,
      createdByToolCallId: context?.toolCallId ?? null,
    });
    return { action: "start", service: toJsonValue(service) };
  } catch (error) {
    throw serviceStartError(error);
  }
}

async function resolveServiceCwd(
  workspaceRoot: string,
  inputCwd: string,
): Promise<string> {
  const candidate = isAbsolute(inputCwd)
    ? resolve(inputCwd)
    : resolve(workspaceRoot, inputCwd);
  if (!isInsideWorkspace(workspaceRoot, candidate)) {
    throw new ToolExecutionError(
      "PATH_OUTSIDE_WORKSPACE",
      `Service cwd is outside the workspace: ${inputCwd}`,
    );
  }
  const canonicalWorkspaceRoot = await realpath(workspaceRoot);
  const canonicalCwd = await realpath(candidate);
  if (!isInsideWorkspace(canonicalWorkspaceRoot, canonicalCwd)) {
    throw new ToolExecutionError(
      "PATH_OUTSIDE_WORKSPACE",
      `Service cwd is outside the workspace: ${inputCwd}`,
    );
  }
  return canonicalCwd;
}

function isInsideWorkspace(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return !(
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

function serviceStartError(error: unknown): never {
  if (error instanceof Error && error.message === "SERVICE_LIMIT_REACHED") {
    throw new ToolExecutionError(
      "SERVICE_LIMIT_REACHED",
      "This workspace already has the maximum number of live services.",
    );
  }
  throw new ToolExecutionError(
    "SERVICE_START_FAILED",
    "The service failed to start.",
  );
}

async function withServiceNotFoundError<T>(
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && error.message === "SERVICE_NOT_FOUND") {
      throw new ToolExecutionError(
        "SERVICE_NOT_FOUND",
        "Service not found in this workspace.",
      );
    }
    throw error;
  }
}

function summarizeServiceInput(input: ServiceToolInput): JsonValue {
  switch (input.action) {
    case "start":
      return {
        action: "start",
        command: input.command,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      };
    case "list":
      return { action: "list" };
    case "status":
      return { action: "status", id: input.id };
    case "logs":
      return {
        action: "logs",
        id: input.id,
        ...(input.tailBytes === undefined
          ? {}
          : { tailBytes: input.tailBytes }),
      };
    case "stop":
      return {
        action: "stop",
        id: input.id,
        ...(input.force === undefined ? {} : { force: input.force }),
      };
  }
}
