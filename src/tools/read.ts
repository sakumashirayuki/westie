import { readFile, stat } from "node:fs/promises";

import { z } from "zod";

import { defineTool, ToolExecutionError } from "../tools.js";
import type { WorkspaceGrantStore } from "../application/workspace-grant-store.js";
import type { ExecutionMode } from "../domain/conversation.js";
import {
  createWorkspacePathResolver,
  decodeTextContent,
  rethrowFileNotFound,
} from "./path.js";

const DEFAULT_LINE_LIMIT = 1_000;
const MAX_LINE_LIMIT = 1_000;
const MAX_READ_BYTES = 64 * 1024;

export async function createReadTool(
  workspaceRoot: string,
  workspaceGrantStore?: WorkspaceGrantStore,
  executionMode: ExecutionMode = "workspace_sandbox",
) {
  const paths = await createWorkspacePathResolver(
    workspaceRoot,
    workspaceGrantStore,
    executionMode,
  );

  return defineTool({
    name: "read",
    description: executionMode === "full_access"
      ? "Read UTF-8 text from any host file available to the current user. offset is a 1-based line number. Reads up to 1000 lines per call by default, so most files arrive in one call."
      : "Read UTF-8 text from a workspace file. offset is a 1-based line number. Reads up to 1000 lines per call by default, so most files arrive in one call.",
    // A readable file is capped at MAX_READ_BYTES; JSON escaping of a full-size
    // file can still exceed the shared 64 KiB tool output cap.
    maxOutputBytes: 96 * 1024,
    impact: executionMode === "full_access"
      ? "Reads one UTF-8 text file anywhere the host user can access."
      : "Reads one UTF-8 text file inside the workspace.",
    inputSchema: z.strictObject({
      path: z.string().min(1),
      offset: z.int().positive().optional(),
      limit: z.int().positive().max(MAX_LINE_LIMIT).optional(),
    }),
    async preflight(input, context) {
      context.signal?.throwIfAborted();
      try {
        return await paths.preflightReadable(input.path, context);
      } catch (error) {
        if (context.signal?.aborted) throw context.signal.reason ?? error;
        // Normal file errors are still reported by execute() as ToolResults.
        if (error instanceof ToolExecutionError) return undefined;
        throw error;
      }
    },
    async execute(input, context) {
      context.signal?.throwIfAborted();
      const resolvedPath = await paths.resolveReadable(input.path, context);
      let contentBuffer: Buffer;
      try {
        const fileStats = await stat(resolvedPath);
        if (fileStats.size > MAX_READ_BYTES) throwReadTooLarge();
        contentBuffer = await readFile(resolvedPath);
      } catch (error) {
        if (error instanceof ToolExecutionError) throw error;
        return rethrowFileNotFound(error, input.path);
      }
      context.signal?.throwIfAborted();
      if (contentBuffer.byteLength > MAX_READ_BYTES) throwReadTooLarge();
      const content = decodeTextContent(contentBuffer, input.path);

      const lines = content.split(/\r?\n/);
      const offset = input.offset ?? 1;
      const limit = input.limit ?? DEFAULT_LINE_LIMIT;
      const selectedLines = lines.slice(offset - 1, offset - 1 + limit);

      return {
        content: selectedLines.join("\n"),
        startLine: offset,
        endLine:
          selectedLines.length === 0
            ? offset - 1
            : offset + selectedLines.length - 1,
        totalLines: lines.length,
      };
    },
  });
}

function throwReadTooLarge(): never {
  throw new ToolExecutionError(
    "TOOL_OUTPUT_TOO_LARGE",
    "File exceeds the maximum readable size.",
  );
}
