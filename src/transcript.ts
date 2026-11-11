import { z } from "zod";

import type { ToolResult } from "./protocol.js";

const toolErrorCodeSchema = z.enum([
  "UNKNOWN_TOOL",
  "INVALID_TOOL_INPUT",
  "TOOL_OUTPUT_TOO_LARGE",
  "TOOL_EXECUTION_FAILED",
  "PATH_OUTSIDE_WORKSPACE",
  "SENSITIVE_FILE_ACCESS_DENIED",
  "FILE_NOT_FOUND",
  "FILE_NOT_TEXT",
  "EDIT_CONFLICT",
  "COMMAND_TIMEOUT",
  "COMMAND_OUTPUT_TOO_LARGE",
  "COMMAND_CPU_LIMIT_EXCEEDED",
  "COMMAND_MEMORY_LIMIT_EXCEEDED",
  "COMMAND_PROCESS_LIMIT_EXCEEDED",
  "COMMAND_DISK_WRITE_LIMIT_EXCEEDED",
  "RESOURCE_LIMIT_ENFORCEMENT_FAILED",
  "PROCESS_CONTAINMENT_FAILED",
  "SANDBOX_UNAVAILABLE",
  "TOOL_PERMISSION_DENIED",
  "TOOL_APPROVAL_DENIED",
  "TOOL_APPROVAL_EXPIRED",
  "WORKSPACE_GRANT_DENIED",
  "WORKSPACE_GRANT_EXPIRED",
  "SUB_AGENT_FAILED",
  "SUB_AGENT_LIMIT_REACHED",
  "SUB_AGENT_PARENT_ENDING",
  "SUB_AGENT_NOT_FOUND",
  "FETCH_FAILED",
  "FETCH_BLOCKED_ADDRESS",
  "FETCH_UNSUPPORTED_CONTENT",
  "MCP_SERVER_UNAVAILABLE",
  "MCP_TOOL_ERROR",
  "STOP_HOOK_OUTPUT_INVALID",
  "TOOL_INTERRUPTED",
]);

const toolResultSchema: z.ZodType<ToolResult> = z.discriminatedUnion("status", [
  z.strictObject({
    type: z.literal("tool_result"),
    tool: z.string(),
    status: z.literal("success"),
    output: z.json(),
  }),
  z.strictObject({
    type: z.literal("tool_result"),
    tool: z.string(),
    status: z.literal("error"),
    error: z.strictObject({
      code: toolErrorCodeSchema,
      message: z.string(),
    }),
  }),
]);

const nativeToolCallSchema = z.strictObject({
  callId: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
});

export type NativeToolCall = z.infer<typeof nativeToolCallSchema>;

const toolCallsSchema = z.array(nativeToolCallSchema).min(1).superRefine(
  (calls, context) => {
    const callIds = new Set<string>();
    for (const [index, call] of calls.entries()) {
      if (callIds.has(call.callId)) {
        context.addIssue({
          code: "custom",
          message: "Tool call IDs must be unique within a batch.",
          path: [index, "callId"],
        });
      }
      callIds.add(call.callId);
    }
  },
);

const toolResultEntrySchema = z.strictObject({
  toolCallId: z.string().min(1),
  result: toolResultSchema,
});

export interface ToolResultEntry {
  readonly toolCallId: string;
  readonly result: ToolResult;
}

export type TranscriptMessage =
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "user";
      readonly content: string;
      /** harness 自动交付的子任务结果。 */
      readonly source: "sub_agent";
      readonly subAgentRunId: string;
    }
  | {
      readonly role: "user";
      /** 完成检查记录；content 是一段 JSON 文本，由 `stop-hook-result.ts` 生成。 */
      readonly content: string;
      readonly source: "stop_hook";
    }
  | { readonly role: "assistant"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: null;
      readonly toolCalls: readonly NativeToolCall[];
    }
  | {
      readonly role: "tool";
      readonly results: readonly ToolResultEntry[];
    };

const toolResultsSchema = z.array(toolResultEntrySchema).min(1)
  .superRefine((results, context) => {
    const callIds = new Set<string>();
    for (const [index, result] of results.entries()) {
      if (callIds.has(result.toolCallId)) {
        context.addIssue({
          code: "custom",
          message: "Tool result IDs must be unique within a batch.",
          path: [index, "toolCallId"],
        });
      }
      callIds.add(result.toolCallId);
    }
  });

export const transcriptMessageSchema: z.ZodType<TranscriptMessage> = z.union([
  z.strictObject({
    role: z.literal("user"),
    content: z.string(),
  }),
  z.strictObject({
    role: z.literal("user"),
    content: z.string(),
    source: z.literal("sub_agent"),
    subAgentRunId: z.string().min(1),
  }),
  z.strictObject({
    role: z.literal("user"),
    content: z.string(),
    source: z.literal("stop_hook"),
  }),
  z.strictObject({
    role: z.literal("assistant"),
    content: z.string(),
  }),
  z.strictObject({
    role: z.literal("assistant"),
    content: z.null(),
    toolCalls: toolCallsSchema,
  }),
  z.strictObject({
    role: z.literal("tool"),
    results: toolResultsSchema,
  }),
]);

export class TranscriptParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TranscriptParseError";
  }
}

export class TranscriptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptValidationError";
  }
}

export function isCompleteToolBatch(
  callMessage: TranscriptMessage | undefined,
  resultMessage: TranscriptMessage | undefined,
): boolean {
  if (
    callMessage?.role !== "assistant" ||
    callMessage.content !== null ||
    resultMessage?.role !== "tool" ||
    callMessage.toolCalls.length !== resultMessage.results.length
  ) {
    return false;
  }
  return callMessage.toolCalls.every((call, index) => {
    const result = resultMessage.results[index];
    return result?.toolCallId === call.callId && result.result.tool === call.name;
  });
}

export function validateTranscriptBatches(
  transcript: readonly TranscriptMessage[],
  options: { readonly allowOpenBatch?: boolean } = {},
): void {
  for (let index = 0; index < transcript.length; index += 1) {
    const message = transcript[index]!;
    if (message.role === "tool") {
      throw new TranscriptValidationError("Transcript contains an orphan tool result batch.");
    }
    if (message.role !== "assistant" || message.content !== null) continue;
    const result = transcript[index + 1];
    if (
      result === undefined &&
      options.allowOpenBatch === true &&
      index === transcript.length - 1
    ) {
      return;
    }
    if (!isCompleteToolBatch(message, result)) {
      throw new TranscriptValidationError(
        "Transcript contains an incomplete or mismatched tool batch.",
      );
    }
    index += 1;
  }
}

export function serializeTranscriptMessage(message: TranscriptMessage): string {
  return JSON.stringify(transcriptMessageSchema.parse(message));
}

export function parseTranscriptMessage(serialized: string): TranscriptMessage {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new TranscriptParseError("Transcript message is not valid JSON.", {
      cause: error,
    });
  }

  const parsed = transcriptMessageSchema.safeParse(value);
  if (!parsed.success) {
    throw new TranscriptParseError(
      "Transcript message has an invalid shape.",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export function transcriptMessageBytes(message: TranscriptMessage): number {
  return Buffer.byteLength(serializeTranscriptMessage(message), "utf8");
}

export function transcriptBytes(
  transcript: readonly TranscriptMessage[],
): number {
  return transcript.reduce(
    (total, message) => total + transcriptMessageBytes(message),
    0,
  );
}
