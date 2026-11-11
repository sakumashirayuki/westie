import { z } from "zod";

import {
  isValidMemoryFileName,
  MemoryContentTooLargeError,
  MemoryEntryNotRegularError,
  MemoryFileNotFoundError,
  MemoryWriteConflictError,
  MEMORY_INDEX_FILE,
  type ProjectMemoryStore,
} from "../infrastructure/memory-store.js";
import { MemoryWriteTimeoutError } from "../infrastructure/memory-write-queue.js";
import type { JsonValue } from "../protocol.js";
import { defineTool, ToolExecutionError } from "../tools.js";

/**
 * 只接受单层 `.md` 文件名：不含分隔符、`..` 和前导点，UTF-8 字节数限长。
 * 规则与 `list` 共用 `isValidMemoryFileName`，保证列出的名字都能被工具接受。
 */
const memoryFileName = z.string()
  .refine(isValidMemoryFileName, { message: "Memory file names are single-level <name>.md, at most 200 UTF-8 bytes." })
  .nullable();

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

const memoryToolInput = z.strictObject({
  action: z.enum(["list", "read", "write", "delete"]),
  file: memoryFileName,
  start_line: z.int().positive().nullable(),
  limit: z.int().positive().nullable(),
  content: z.string().nullable(),
  expected_sha256: sha256Hex.nullable(),
});

export type MemoryToolInput = z.infer<typeof memoryToolInput>;

/**
 * 项目记忆工具。绑定单个项目记忆目录；输入组合按 action 校验，失败时不修改文件，
 * 错误里不携带任何外部路径。
 */
export function createMemoryTool(store: ProjectMemoryStore) {
  return defineTool({
    name: "memory",
    description:
      `Read and maintain the project's Markdown memory files shared by every session of this Git repository or directory. ${MEMORY_INDEX_FILE} is the startup index: its content is already in the system prompt under <project_memory>, and every future session loads it. Record durable project facts as one-line entries in ${MEMORY_INDEX_FILE}; put long details in other .md files and reference them from the index. Only write when the user explicitly asks to remember, change, or forget something. Call list first, read before writing an existing file, and pass expected_sha256 from that read; use null expected_sha256 only to create a new file. Use content to replace the whole file.`,
    impact:
      "Reads or changes the user's project memory files outside the workspace.",
    inputSchema: memoryToolInput,
    summarizeInput(input) {
      return {
        action: input.action,
        file: input.file,
        start_line: input.start_line,
        limit: input.limit,
        content_bytes:
          input.content === null ? null : Buffer.byteLength(input.content, "utf8"),
        expected_sha256: input.expected_sha256,
      };
    },
    async execute(input, context) {
      context.signal?.throwIfAborted();
      try {
        return await runMemoryAction(store, input, context.signal);
      } catch (error) {
        const mapped = mapMemoryError(error);
        if (mapped !== undefined) throw mapped;
        throw error;
      }
    },
  });
}

async function runMemoryAction(
  store: ProjectMemoryStore,
  input: MemoryToolInput,
  signal: AbortSignal | undefined,
): Promise<JsonValue> {
  switch (input.action) {
    case "list":
      requireNull(input, ["file", "start_line", "limit", "content", "expected_sha256"]);
      return { files: [...await store.list(signal)] };
    case "read":
      if (input.file === null) throw invalidInput("read requires file.");
      requireNull(input, ["content", "expected_sha256"]);
      return {
        ...await store.read(
          input.file,
          {
            ...(input.start_line === null ? {} : { startLine: input.start_line }),
            ...(input.limit === null ? {} : { limit: input.limit }),
          },
          signal,
        ),
      };
    case "write":
      if (input.file === null) throw invalidInput("write requires file.");
      if (input.content === null) throw invalidInput("write requires content.");
      requireNull(input, ["start_line", "limit"]);
      return {
        ...await store.write(
          input.file,
          input.content,
          input.expected_sha256,
          signal,
        ),
      };
    case "delete":
      if (input.file === null) throw invalidInput("delete requires file.");
      if (input.expected_sha256 === null) {
        throw invalidInput(
          "delete requires expected_sha256 from the last read of the file.",
        );
      }
      requireNull(input, ["start_line", "limit", "content"]);
      return {
        ...await store.delete(input.file, input.expected_sha256, signal),
      };
  }
}

function requireNull(
  input: MemoryToolInput,
  fields: readonly (keyof MemoryToolInput)[],
): void {
  for (const field of fields) {
    if (input[field] !== null) {
      throw invalidInput(`${input.action} requires ${field} to be null.`);
    }
  }
}

function invalidInput(message: string): ToolExecutionError {
  return new ToolExecutionError("INVALID_TOOL_INPUT", message);
}

function mapMemoryError(error: unknown): ToolExecutionError | undefined {
  if (error instanceof MemoryFileNotFoundError) {
    return new ToolExecutionError("FILE_NOT_FOUND", error.message);
  }
  if (error instanceof MemoryWriteConflictError) {
    return new ToolExecutionError("EDIT_CONFLICT", error.message);
  }
  if (error instanceof MemoryContentTooLargeError) {
    return new ToolExecutionError("INVALID_TOOL_INPUT", error.message);
  }
  if (error instanceof MemoryEntryNotRegularError) {
    return new ToolExecutionError(
      "EDIT_CONFLICT",
      "A memory entry with this name is a directory, symbolic link or other non-regular file. Choose another file name.",
    );
  }
  if (error instanceof MemoryWriteTimeoutError) {
    return new ToolExecutionError(
      "TOOL_EXECUTION_FAILED",
      "Project memory is busy with another write; nothing was changed.",
    );
  }
  return undefined;
}
