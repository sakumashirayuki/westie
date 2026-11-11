import assert from "node:assert/strict";
import test from "node:test";

import {
  parseTranscriptMessage,
  serializeTranscriptMessage,
  TranscriptParseError,
  TranscriptValidationError,
  transcriptBytes,
  transcriptMessageBytes,
  validateTranscriptBatches,
  type TranscriptMessage,
} from "../src/transcript.js";

const messages: readonly TranscriptMessage[] = [
  { role: "user", content: "问题" },
  { role: "assistant", content: "答案" },
  {
    role: "assistant",
    content: null,
    toolCalls: [{
      callId: "call-1",
      name: "read",
      arguments: '{"path":"README.md"}',
    }],
  },
  {
    role: "tool",
    results: [{
      toolCallId: "call-1",
      result: {
      type: "tool_result",
      tool: "read",
      status: "success",
      output: { content: "hello" },
      },
    }],
  },
];

test("canonical transcript messages round-trip without losing tool call data", () => {
  for (const message of messages) {
    assert.deepEqual(
      parseTranscriptMessage(serializeTranscriptMessage(message)),
      message,
    );
  }
});

test("canonical transcript parsing rejects invalid JSON and message shapes", () => {
  assert.throws(() => parseTranscriptMessage("not-json"), TranscriptParseError);
  for (const value of [
    {},
    { role: "system", content: "instruction" },
    { role: "assistant", content: null },
    {
      role: "assistant",
      content: null,
      toolCalls: [{ callId: "", name: "read", arguments: "{}" }],
    },
    { role: "tool", results: [] },
  ]) {
    assert.throws(
      () => parseTranscriptMessage(JSON.stringify(value)),
      TranscriptParseError,
    );
  }
});

test("canonical transcript validates complete and open tool batches", () => {
  assert.doesNotThrow(() => validateTranscriptBatches(messages));
  const open = messages.slice(0, -1);
  assert.throws(
    () => validateTranscriptBatches(open),
    TranscriptValidationError,
  );
  assert.doesNotThrow(() =>
    validateTranscriptBatches(open, { allowOpenBatch: true })
  );

  const mismatched: TranscriptMessage[] = [
    messages[2]!,
    {
      role: "tool",
      results: [{
        toolCallId: "other",
        result: {
          type: "tool_result",
          tool: "read",
          status: "success",
          output: null,
        },
      }],
    },
  ];
  assert.throws(
    () => validateTranscriptBatches(mismatched),
    TranscriptValidationError,
  );
});

test("canonical transcript byte size is serialized JSON UTF-8 bytes", () => {
  assert.equal(
    transcriptBytes(messages),
    messages.reduce(
      (total, message) =>
        total + Buffer.byteLength(JSON.stringify(message), "utf8"),
      0,
    ),
  );
  assert.equal(
    transcriptMessageBytes(messages[0]),
    Buffer.byteLength(JSON.stringify(messages[0]), "utf8"),
  );
});

test("canonical transcript accepts the sub agent failure code", () => {
  const message: TranscriptMessage = {
    role: "tool",
    results: [{
      toolCallId: "call-agent",
      result: {
        type: "tool_result",
        tool: "agent",
        status: "error",
        error: { code: "SUB_AGENT_FAILED", message: "Sub agent failed: X: y" },
      },
    }],
  };

  assert.deepEqual(
    parseTranscriptMessage(serializeTranscriptMessage(message)),
    message,
  );
});


test("sub-agent reports retain provenance and reject ambiguous sources", () => {
  const report: TranscriptMessage = {
    role: "user", source: "sub_agent", subAgentRunId: "child-1",
    content: JSON.stringify({ status: "completed", answer: "evidence" }),
  };
  assert.deepEqual(parseTranscriptMessage(serializeTranscriptMessage(report)), report);
  validateTranscriptBatches([...messages, report, { role: "user", content: "continue" }]);
  for (const invalid of [
    { role: "user", content: "x", source: "sub_agent" },
    { role: "user", content: "x", subAgentRunId: "child-1" },
    { ...report, source: "steering" },
    { ...report, source: null },
    { ...report, subAgentRunId: "" },
    { ...report, role: "assistant" },
  ]) {
    assert.throws(() => parseTranscriptMessage(JSON.stringify(invalid)), TranscriptParseError);
  }
});

test("round-trips a completion check record as a stop_hook user message", () => {
  const message = {
    role: "user",
    content: JSON.stringify({
      command: "node check.mjs",
      step: 1,
      decision: "block",
      reason: "未通过",
      applied: true,
    }),
    source: "stop_hook",
  } as const;
  assert.deepEqual(
    parseTranscriptMessage(serializeTranscriptMessage(message)),
    message,
  );
  assert.throws(
    () => parseTranscriptMessage(JSON.stringify({ ...message, subAgentRunId: "x" })),
    TranscriptParseError,
  );
});
