import { z } from "zod";

import type {
  JsonValue,
  ToolErrorCode,
  ToolResult,
} from "./protocol.js";

const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly impact: string;
  readonly maxOutputBytes?: number;
  readonly inputSchema: z.ZodObject;
  /**
   * 为 true 时 OpenAI provider 对该工具关掉 `strict` 模式（用裸 JSON Schema
   * 而非 strict schema）。外来 MCP 工具的 schema 常含可选字段 / anyOf，strict
   * 会拒绝。DeepSeek 路径始终 strict: false，不受影响。
   */
  readonly looseInputSchema?: true;
  summarizeInput(input: unknown): JsonValue;
  preflight?(
    input: unknown,
    context?: ToolExecutionContext,
  ): Promise<ResourceAccessRequirement | undefined>;
  execute(input: unknown, context?: ToolExecutionContext): Promise<JsonValue>;
}

export interface ToolExecutionContext {
  readonly signal?: AbortSignal;
  readonly conversationId?: string;
  readonly toolCallId?: string;
}

export interface WorkspaceGrantRequirement {
  readonly kind: "workspace_grant";
  readonly reason: "outside_workspace" | "sensitive_workspace_file";
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly access: "read";
  readonly scope: "once";
}

export type ResourceAccessRequirement = WorkspaceGrantRequirement;

export interface PreparedToolCall {
  readonly name: string;
  readonly impact: string;
  readonly input: unknown;
  readonly argumentsSummary: JsonValue;
  preflight(
    context?: ToolExecutionContext,
  ): Promise<ResourceAccessRequirement | undefined>;
  execute(context?: ToolExecutionContext): Promise<ToolResult>;
}

export function defineTool<Schema extends z.ZodObject>(config: {
  name: string;
  description: string;
  impact?: string;
  maxOutputBytes?: number;
  inputSchema: Schema;
  looseInputSchema?: true;
  summarizeInput?(input: z.infer<Schema>): JsonValue;
  preflight?(
    input: z.infer<Schema>,
    context: ToolExecutionContext,
  ):
    | ResourceAccessRequirement
    | undefined
    | Promise<ResourceAccessRequirement | undefined>;
  execute(
    input: z.infer<Schema>,
    context: ToolExecutionContext,
  ): JsonValue | Promise<JsonValue>;
}): Tool {
  return {
    name: config.name,
    description: config.description,
    impact: config.impact ?? `Executes the ${config.name} tool once.`,
    ...(config.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: config.maxOutputBytes }),
    ...(config.looseInputSchema === true ? { looseInputSchema: true } : {}),
    inputSchema: config.inputSchema,
    summarizeInput(input: unknown) {
      return config.summarizeInput?.(input as z.infer<Schema>) ??
        toJsonValue(input);
    },
    async preflight(input: unknown, context: ToolExecutionContext = {}) {
      return config.preflight?.(input as z.infer<Schema>, context);
    },
    async execute(input: unknown, context: ToolExecutionContext = {}) {
      return config.execute(input as z.infer<Schema>, context);
    },
  };
}

export class ToolExecutionError extends Error {
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
  }
}

export class ToolRegistry {
  readonly tools: readonly Tool[];
  readonly #toolsByName: Map<string, Tool>;

  constructor(tools: readonly Tool[]) {
    this.#toolsByName = new Map();
    for (const tool of tools) {
      if (this.#toolsByName.has(tool.name)) {
        throw new Error(`Duplicate tool name: ${tool.name}`);
      }
      this.#toolsByName.set(tool.name, tool);
    }
    this.tools = [...tools];
  }

  prepare(name: string, input: unknown): PreparedToolCall | ToolResult {
    const tool = this.#toolsByName.get(name);
    if (tool === undefined) {
      return toolError(name, "UNKNOWN_TOOL", `Unknown tool: ${name}`);
    }

    const parsedInput = tool.inputSchema.safeParse(input);
    if (!parsedInput.success) {
      return toolError(
        name,
        "INVALID_TOOL_INPUT",
        describeInvalidInput(name, input, parsedInput.error),
      );
    }

    return {
      name,
      impact: tool.impact,
      input: parsedInput.data,
      argumentsSummary: tool.summarizeInput(parsedInput.data),
      async preflight(context = {}) {
        context.signal?.throwIfAborted();
        const requirement = await tool.preflight?.(parsedInput.data, context);
        context.signal?.throwIfAborted();
        return requirement;
      },
      async execute(context = {}) {
        try {
          context.signal?.throwIfAborted();
          const output = await tool.execute(parsedInput.data, context);
          const serializedOutput = JSON.stringify(output);
          if (
            serializedOutput === undefined ||
            Buffer.byteLength(serializedOutput, "utf8") >
              (tool.maxOutputBytes ?? MAX_TOOL_OUTPUT_BYTES)
          ) {
            return toolError(
              name,
              "TOOL_OUTPUT_TOO_LARGE",
              "Tool output exceeded the maximum size.",
            );
          }
          return {
            type: "tool_result",
            tool: name,
            status: "success",
            output,
          };
        } catch (error) {
          if (context.signal?.aborted) {
            throw context.signal.reason ?? error;
          }
          if (error instanceof ToolExecutionError) {
            return toolError(name, error.code, error.message);
          }
          return toolError(
            name,
            "TOOL_EXECUTION_FAILED",
            "Tool execution failed.",
          );
        }
      },
    };
  }

  async execute(
    name: string,
    input: unknown,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const prepared = this.prepare(name, input);
    if ("type" in prepared) {
      return prepared;
    }
    return prepared.execute(context);
  }
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, toJsonValue(child)]),
    );
  }
  return String(value);
}

function describeInvalidInput(
  name: string,
  input: unknown,
  error: z.ZodError,
): string {
  const missing = missingRequiredFields(input, error);
  const prettified = z.prettifyError(error);
  if (missing.length === 0) return prettified;
  return [
    `${name} is missing required field(s): ${missing.join(", ")}.`,
    "Send every required field in a single call.",
    prettified,
  ].join("\n");
}

function missingRequiredFields(
  input: unknown,
  error: z.ZodError,
): readonly string[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return [];
  }
  const provided = input as Record<string, unknown>;
  const names = new Set<string>();
  for (const issue of error.issues) {
    if (issue.path.length !== 1) continue;
    const key = issue.path[0];
    if (typeof key !== "string") continue;
    if (provided[key] === undefined) names.add(key);
  }
  return [...names];
}

function toolError(
  tool: string,
  code: ToolErrorCode,
  message: string,
): ToolResult {
  return {
    type: "tool_result",
    tool,
    status: "error",
    error: { code, message },
  };
}
