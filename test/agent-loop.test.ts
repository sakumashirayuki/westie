import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MaxStepsExceededError,
  runAgent as runAgentWithSystemPrompt,
  streamAgentRun as streamAgentRunWithSystemPrompt,
  assertTranscriptCompleteOnWrite,
  type LlmProvider,
  type ProviderRequest,
  type RunAgentOptions,
  type TranscriptMessage,
} from "../src/agent-loop.js";
import type { AgentEvent } from "../src/agent-events.js";
import type {
  ProviderStreamEvent,
  ProviderTurn,
} from "../src/provider-protocol.js";
import { InMemoryInteractionBroker } from "../src/application/interaction-broker.js";
import { InMemoryWorkspaceGrantStore } from "../src/application/workspace-grant-store.js";
import { ProtocolError } from "../src/protocol.js";
import { validateTranscriptBatches } from "../src/transcript.js";
import {
  AuthorizedToolExecutor,
  FixedToolPermissionPolicy,
  type ToolAuditEvent,
} from "../src/tool-permissions.js";
import { defineTool, ToolExecutionError } from "../src/tools.js";
import { MAX_CONCURRENT_TOOL_EXECUTIONS } from "../src/protocol.js";
import {
  ProviderTruncatedOutputError,
  ProviderUnavailableError,
} from "../src/provider-protocol.js";
import { RunUsageLog } from "../src/run-usage.js";
import { createReadTool } from "../src/tools/read.js";
import { z } from "zod";
import { testRunOptions, testToolEnvironment, testRun } from "./support/agent-run-options.js";

const TEST_SYSTEM_PROMPT = "Test system prompt.";

function runAgent(
  options: Parameters<typeof testRunOptions>[0],
): Promise<string> {
  return runAgentWithSystemPrompt(testRunOptions({ ...options, systemPrompt: TEST_SYSTEM_PROMPT }));
}

function streamAgentRun(
  options: Parameters<typeof testRunOptions>[0],
) {
  return streamAgentRunWithSystemPrompt(testRunOptions({ ...options, systemPrompt: TEST_SYSTEM_PROMPT }));
}

class FakeProvider implements LlmProvider {
  readonly model = "test-model";
  readonly requests: ProviderRequest[] = [];

  constructor(private readonly responses: Array<ProviderTurn | Error>) {}

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push({
      ...request,
      transcript: request.transcript.map((message) => ({ ...message })),
      tools: [...request.tools],
    });

    const response = this.responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    if (response === undefined) {
      throw new Error("FakeProvider has no response left");
    }
    if (response.type === "final") {
      yield { type: "output_text.delta", text: response.content };
    } else {
      yield {
        type: "tool_arguments.delta",
        callIndex: 0,
        text: response.calls[0].arguments,
      };
    }
    yield { type: "completed", turn: response };
  }
}

class StreamingFakeProvider implements LlmProvider {
  readonly model = "test-model";
  readonly requests: ProviderRequest[] = [];

  constructor(private readonly events: readonly ProviderStreamEvent[]) {}

  async *stream(
    request: ProviderRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(request);
    for (const event of this.events) {
      yield event;
    }
  }
}

const finalStep = (
  answer: string,
): Extract<ProviderTurn, { type: "final" }> => ({
  type: "final",
  content: answer,
});

const emptyUsage = () => ({
  calls: 0,
  unmeasuredCalls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

const toolStep = (
  name: string,
  input: Record<string, unknown>,
  callId = `provider-call-${name}`,
): Extract<ProviderTurn, { type: "tool_calls" }> => ({
  type: "tool_calls",
  calls: [{ callId, name, arguments: JSON.stringify(input) }],
});

function lastToolResult(request: ProviderRequest) {
  const message = request.transcript.at(-1);
  assert.equal(message?.role, "tool");
  if (message?.role !== "tool") {
    throw new Error("Expected the transcript to end with a tool result.");
  }
  return message.results[0]!.result;
}

const echoTool = defineTool({
  name: "echo",
  description: "Returns the supplied text.",
  inputSchema: z.strictObject({ text: z.string() }),
  async execute(input) {
    return { text: input.text };
  },
});

test("returns a direct final answer", async () => {
  const provider = new FakeProvider([finalStep("hello")]);

  assert.equal(await runAgent({
    provider,
    transcript: [{ role: "user", content: "hi" }]
  }), "hello");
  assert.deepEqual(provider.requests[0]?.transcript, [
    { role: "user", content: "hi" },
  ]);
  assert.equal(provider.requests[0]?.systemPrompt, TEST_SYSTEM_PROMPT);
});

test("emits ordered streaming events with run-wide seq and step numbers", async () => {
  const provider = new StreamingFakeProvider([
    { type: "output_text.delta", text: "hello" },
    { type: "completed", turn: finalStep("hello") },
  ]);
  const events: AgentEvent[] = [];

  for await (const event of streamAgentRun({
    provider,
    transcript: [{ role: "user", content: "hi" }],
    run: { ...testRun("run-1") }
  })) {
    events.push(event);
  }

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "run.started",
      "step.started",
      "answer.delta",
      "step.completed",
      "answer.completed",
      "run.completed",
    ],
  );
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal("step" in events[0]!, false);
  assert.equal("step" in events.at(-1)!, false);
  for (const event of events.slice(1, -1)) {
    assert.ok("step" in event);
    assert.equal(event.step, 1);
  }
  assert.deepEqual(events.filter((event) => event.type === "answer.delta"), [
    {
      v: 1,
      runId: "run-1",
      seq: 3,
      type: "answer.delta",
      step: 1,
      data: { text: "hello" },
    },
  ]);
});

test("keeps a completed transcript before emitting run.completed", async () => {
  let committed = false;
  const events = streamAgentRun({
    provider: new FakeProvider([finalStep("hello")]),
    transcript: [{ role: "user", content: "hi" }],
    run: { ...testRun("run-commit") },
    lifecycle: {
      beforeCompleted(result) {
        assert.equal(result.answer, "hello");
        assert.deepEqual(result.transcript.map((message) => message.role), [
          "user",
          "assistant",
        ]);
        committed = true;
      }
    }
  })[Symbol.asyncIterator]();

  let event: AgentEvent | undefined;
  do {
    event = (await events.next()).value;
  } while (event?.type !== "answer.completed");
  assert.equal(committed, false);

  const terminal = await events.next();
  assert.equal(committed, true);
  assert.equal(terminal.value?.type, "run.completed");
});

test("emits only answer deltas with continuous public event numbers", async () => {
  const events: AgentEvent[] = [];

  for await (const event of streamAgentRun({
    provider: new StreamingFakeProvider([
      { type: "output_text.delta", text: "he" },
      { type: "output_text.delta", text: "llo" },
      { type: "completed", turn: finalStep("hello") },
    ]),
    transcript: [{ role: "user", content: "hi" }],
    run: { ...testRun("run-debug") }
  })) {
    events.push(event);
  }

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "run.started",
      "step.started",
      "answer.delta",
      "answer.delta",
      "step.completed",
      "answer.completed",
      "run.completed",
    ],
  );
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2, 3, 4, 5, 6, 7],
  );
});

test("stops after an answer delta when cancelled", async () => {
  const controller = new AbortController();
  const cancelled = new Error("cancelled");
  const iterator = streamAgentRun({
    provider: new StreamingFakeProvider([
      { type: "output_text.delta", text: "he" },
      // 不再给 completed：正常情况下这里会继续产出 answer.delta 之后才到完成。
    ]),
    signal: controller.signal,
    transcript: [{ role: "user", content: "hi" }],
    run: { ...testRun("run-cancel-after-answer-delta") }
  })[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value?.type, "run.started");
  assert.equal((await iterator.next()).value?.type, "step.started");
  assert.equal((await iterator.next()).value?.type, "answer.delta");

  controller.abort(cancelled);
  await assert.rejects(iterator.next(), cancelled);
});

test("keeps an answer preview unvalidated when the complete step is invalid", async () => {
  const events: AgentEvent[] = [];

  for await (const event of streamAgentRun({
    provider: new StreamingFakeProvider([
      { type: "output_text.delta", text: "preview" },
    ]),
    transcript: [{ role: "user", content: "hi" }],
    run: { ...testRun("run-invalid-preview") }
  })) {
    events.push(event);
  }

  assert.deepEqual(
    events.map((event) => event.type),
    ["run.started", "step.started", "answer.delta", "run.error"],
  );
  assert.equal(
    events.find((event) => event.type === "answer.delta")?.data.text,
    "preview",
  );
  assert.deepEqual(events.at(-1)?.data, {
    code: "INVALID_MODEL_OUTPUT",
    message: "Model returned an invalid response.",
    usage: emptyUsage(),
  });
  assert.equal(
    events.some((event) =>
      event.type === "answer.completed" || event.type === "run.completed"
    ),
    false,
  );
});

test("stops emitting terminal events when cancelled after step completion", async () => {
  const controller = new AbortController();
  const cancelled = new Error("cancelled");
  const iterator = streamAgentRun({
    provider: new FakeProvider([finalStep("hello")]),
    signal: controller.signal,
    transcript: [{ role: "user", content: "hi" }],
    run: { ...testRun("run-cancelled-final") }
  })[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value?.type, "run.started");
  assert.equal((await iterator.next()).value?.type, "step.started");
  assert.equal((await iterator.next()).value?.type, "answer.delta");
  assert.equal((await iterator.next()).value?.type, "step.completed");

  controller.abort(cancelled);
  await assert.rejects(iterator.next(), cancelled);
});

test("does not emit tool completion when cancelled during execution", async () => {
  let releaseTool!: () => void;
  const toolGate = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  let toolStarted!: () => void;
  const toolStartedPromise = new Promise<void>((resolve) => {
    toolStarted = resolve;
  });
  let receivedSignal: AbortSignal | undefined;
  const slowTool = defineTool({
    name: "slow",
    description: "Waits for a gate.",
    inputSchema: z.strictObject({}),
    async execute(_input, context) {
      receivedSignal = context.signal;
      toolStarted();
      await new Promise<void>((resolve, reject) => {
        context.signal?.addEventListener("abort", () =>
          reject(context.signal?.reason ?? new Error("cancelled"))
        );
        toolGate.then(resolve);
      });
      return { ok: true };
    },
  });
  const controller = new AbortController();
  const cancelled = new Error("cancelled");
  let failedTranscript: readonly TranscriptMessage[] | undefined;
  const iterator = streamAgentRun({
    provider: new FakeProvider([toolStep("slow", {})]),
    signal: controller.signal,
    transcript: [{ role: "user", content: "wait" }],
    toolEnvironment: testToolEnvironment({ tools: [slowTool] }),
    run: { ...testRun("run-cancelled-tool") },
    lifecycle: {
      beforeFailed(result) {
        failedTranscript = result.transcript;
      }
    }
  })[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value?.type, "run.started");
  assert.equal((await iterator.next()).value?.type, "step.started");
  assert.equal((await iterator.next()).value?.type, "step.completed");
  assert.equal((await iterator.next()).value?.type, "tool.started");

  const pending = iterator.next();
  await toolStartedPromise;
  assert.equal(receivedSignal?.aborted, false);
  controller.abort(cancelled);
  releaseTool();
  await assert.rejects(pending, cancelled);
  assert.equal(receivedSignal?.aborted, true);
  assert.ok(failedTranscript !== undefined);
  assert.doesNotThrow(() => validateTranscriptBatches(failedTranscript!));
  assert.deepEqual(failedTranscript?.at(-1), {
    role: "tool",
    results: [{
      toolCallId: toolStep("slow", {}).calls[0]!.callId,
      result: {
        type: "tool_result",
        tool: "slow",
        status: "error",
        error: {
          code: "TOOL_INTERRUPTED",
          message:
            "Run 在这个工具执行期间被用户取消，工具可能已经部分执行，结果未知。",
        },
      },
    }],
  });
});

test("preserves controlled tool errors for the next model step", async () => {
  const conflictTool = defineTool({
    name: "conflict",
    description: "Reports an expected conflict.",
    inputSchema: z.strictObject({}),
    execute() {
      throw new ToolExecutionError(
        "EDIT_CONFLICT",
        "The requested text is not unique.",
      );
    },
  });
  const provider = new FakeProvider([
    toolStep("conflict", {}),
    finalStep("recovered"),
  ]);

  assert.equal(
    await runAgent({
      provider,
      transcript: [{ role: "user", content: "edit" }],
      toolEnvironment: testToolEnvironment({ tools: [conflictTool] })
    }),
    "recovered",
  );
  assert.deepEqual(lastToolResult(provider.requests[1]!), {
    type: "tool_result",
    tool: "conflict",
    status: "error",
    error: {
      code: "EDIT_CONFLICT",
      message: "The requested text is not unique.",
    },
  });
});

test("rejects an agent step that exceeds the model output limit", async () => {
  const iterator = streamAgentRun({
    provider: new StreamingFakeProvider([
      { type: "output_text.delta", text: "x".repeat(300_000) },
    ]),
    transcript: [{ role: "user", content: "hi" }],
    run: { ...testRun("run-large-model-output") }
  })[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value?.type, "run.started");
  assert.equal((await iterator.next()).value?.type, "step.started");
  const terminal = await iterator.next();
  assert.equal(terminal.value?.type, "run.error");
  assert.deepEqual(terminal.value?.data, {
    code: "MODEL_OUTPUT_TOO_LARGE",
    message: "Model output exceeded the maximum provider turn size.",
    usage: emptyUsage(),
  });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("waits for complete tool JSON before emitting validated arguments and executing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let executionCount = 0;
  const tool = defineTool({
    name: "count",
    description: "Counts executions.",
    inputSchema: z.strictObject({ value: z.number() }),
    async execute(input) {
      executionCount += 1;
      return { value: input.value };
    },
  });
  const firstTurn = toolStep("count", { value: 3 }, "provider-count-1");
  let sentPartial!: () => void;
  const partial = new Promise<void>((resolve) => { sentPartial = resolve; });
  let providerCallCount = 0;
  const provider: LlmProvider = {
    model: "test-model",
    async *stream() {
      providerCallCount += 1;
      if (providerCallCount === 1) {
        yield {
          type: "tool_arguments.delta",
          callIndex: 0,
          text: '{"value":',
        } as const;
        sentPartial();
        await gate;
        yield {
          type: "tool_arguments.delta",
          callIndex: 0,
          text: "3}",
        } as const;
        yield { type: "completed", turn: firstTurn } as const;
      } else {
        yield { type: "output_text.delta", text: "done" } as const;
        yield { type: "completed", turn: finalStep("done") } as const;
      }
    },
  };
  const iterator = streamAgentRun({
    provider,
    transcript: [{ role: "user", content: "count" }],
    toolEnvironment: testToolEnvironment({ tools: [tool] }),
    run: { ...testRun("run-tools") }
  })[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value?.type, "run.started");
  assert.equal((await iterator.next()).value?.type, "step.started");
  const pending = iterator.next();
  await partial;
  assert.equal(executionCount, 0);

  release();
  const first = await pending;
  assert.equal(first.value?.type, "step.completed");
  const remaining: AgentEvent[] = first.done ? [] : [first.value];
  for (;;) {
    const result = await iterator.next();
    if (result.done) break;
    remaining.push(result.value);
  }

  assert.equal(executionCount, 1);
  const started = remaining.find((event) => event.type === "tool.started");
  assert.deepEqual(started?.data, {
    toolCallId: "provider-count-1",
    name: "count",
    arguments: { value: 3 },
  });
  const completed = remaining.find((event) => event.type === "tool.completed");
  assert.equal(completed?.data.status, "success");
  assert.deepEqual(
    completed?.data.status === "success" ? completed.data.result : undefined,
    { value: 3 },
  );
});

test("redacts sensitive tool arguments and results from public events", async () => {
  let receivedApiKey = "";
  const secretTool = defineTool({
    name: "secret",
    description: "Checks a secret.",
    inputSchema: z.strictObject({ apiKey: z.string() }),
    async execute(input) {
      receivedApiKey = input.apiKey;
      return { token: "result-secret", ok: true };
    },
  });
  const provider = new FakeProvider([
    toolStep("secret", { apiKey: "input-secret" }),
    finalStep("done"),
  ]);
  const events: AgentEvent[] = [];

  for await (const event of streamAgentRun({
    provider,
    transcript: [{ role: "user", content: "use secret" }],
    toolEnvironment: testToolEnvironment({ tools: [secretTool] }),
    run: { ...testRun("run-secret") }
  })) {
    events.push(event);
  }

  assert.equal(receivedApiKey, "input-secret");
  const started = events.find((event) => event.type === "tool.started");
  assert.deepEqual(started?.data.arguments, { apiKey: "[REDACTED]" });
  const completed = events.find((event) => event.type === "tool.completed");
  assert.deepEqual(
    completed?.data.status === "success" ? completed.data.result : undefined,
    { token: "[REDACTED]", ok: true },
  );
});

test("executes a tool and feeds its result into the next provider call", async () => {
  const provider = new FakeProvider([
    toolStep("echo", { text: "hello" }),
    finalStep("tool finished"),
  ]);

  assert.equal(
    await runAgent({
      provider,
      transcript: [{ role: "user", content: "echo hello" }],
      toolEnvironment: testToolEnvironment({ tools: [echoTool] })
    }),
    "tool finished",
  );

  const transcript = provider.requests[1]?.transcript;
  assert.equal(transcript?.length, 3);
  assert.equal(transcript?.[2]?.role, "tool");
  assert.deepEqual(
    transcript?.[2]?.role === "tool"
      ? transcript[2].results[0]?.result
      : undefined,
    {
    type: "tool_result",
    tool: "echo",
    status: "success",
    output: { text: "hello" },
    },
  );
});

test("returns invalid JSON tool arguments without executing", async () => {
  const provider = new FakeProvider([
    {
      type: "tool_calls",
      calls: [{
        callId: "provider-invalid-json",
        name: "echo",
        arguments: '{"text":',
      }],
    },
    finalStep("tool finished"),
  ]);
  let executions = 0;
  const tool = defineTool({
    name: "echo",
    description: "Returns the supplied text.",
    inputSchema: z.strictObject({ text: z.string() }),
    execute({ text }) {
      executions += 1;
      return { text };
    },
  });
  const events: AgentEvent[] = [];

  for await (const event of streamAgentRun({
    provider,
    transcript: [{ role: "user", content: "echo hello" }],
    toolEnvironment: testToolEnvironment({ tools: [tool] }),
    run: { ...testRun("run-flattened-tool") }
  })) {
    events.push(event);
  }

  assert.equal(executions, 0);
  assert.deepEqual(events.map((event) => event.type), [
    "run.started",
    "step.started",
    "step.completed",
    "tool.completed",
    "step.started",
    "answer.delta",
    "step.completed",
    "answer.completed",
    "run.completed",
  ]);
  assert.deepEqual(
    lastToolResult(provider.requests[1]!),
    {
      type: "tool_result",
      tool: "echo",
      status: "error",
      error: {
        code: "INVALID_TOOL_INPUT",
        message: "Tool arguments are not valid JSON.",
      },
    },
  );
});

test("executes multiple tools in order with validated arguments", async () => {
  const calls: string[] = [];
  const recordingTool = defineTool({
    name: "record",
    description: "Records text.",
    inputSchema: z.strictObject({ text: z.string() }),
    async execute(input) {
      calls.push(input.text);
      return { recorded: input.text };
    },
  });
  const provider = new FakeProvider([
    toolStep("record", { text: "first" }),
    toolStep("record", { text: "second" }),
    finalStep("done"),
  ]);

  assert.equal(
    await runAgent({
      provider,
      transcript: [{ role: "user", content: "record twice" }],
      toolEnvironment: testToolEnvironment({ tools: [recordingTool] })
    }),
    "done",
  );
  assert.deepEqual(calls, ["first", "second"]);
});

test("runs read and grep concurrently while preserving canonical result order", async () => {
  let releaseRead!: () => void;
  let releaseGrep!: () => void;
  let markReadStarted!: () => void;
  let markGrepStarted!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const grepGate = new Promise<void>((resolve) => {
    releaseGrep = resolve;
  });
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  const grepStarted = new Promise<void>((resolve) => {
    markGrepStarted = resolve;
  });
  const readTool = defineTool({
    name: "read",
    description: "Test read.",
    inputSchema: z.strictObject({}),
    async execute() {
      markReadStarted();
      await readGate;
      return { source: "read" };
    },
  });
  const grepTool = defineTool({
    name: "grep",
    description: "Test grep.",
    inputSchema: z.strictObject({}),
    async execute() {
      markGrepStarted();
      await grepGate;
      return { source: "grep" };
    },
  });
  const provider = new FakeProvider([
    {
      type: "tool_calls",
      calls: [
        { callId: "call-read", name: "read", arguments: "{}" },
        { callId: "call-grep", name: "grep", arguments: "{}" },
      ],
    },
    finalStep("done"),
  ]);
  const iterator = streamAgentRun({
    provider,
    transcript: [{ role: "user", content: "inspect" }],
    toolEnvironment: testToolEnvironment({ tools: [readTool, grepTool] })
  })[Symbol.asyncIterator]();

  const prefix: AgentEvent[] = [];
  while (prefix.filter((event) => event.type === "tool.started").length < 2) {
    prefix.push((await iterator.next()).value!);
  }
  const firstCompletion = iterator.next();
  await Promise.all([readStarted, grepStarted]);
  releaseGrep();
  const grepCompleted = (await firstCompletion).value!;
  assert.equal(grepCompleted.type, "tool.completed");
  assert.equal(grepCompleted.data.toolCallId, "call-grep");

  const secondCompletion = iterator.next();
  releaseRead();
  const readCompleted = (await secondCompletion).value!;
  assert.equal(readCompleted.type, "tool.completed");
  assert.equal(readCompleted.data.toolCallId, "call-read");

  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
  }
  const resultMessage = provider.requests[1]?.transcript.at(-1);
  assert.equal(resultMessage?.role, "tool");
  assert.deepEqual(
    resultMessage?.role === "tool"
      ? resultMessage.results.map((result) => result.toolCallId)
      : [],
    ["call-read", "call-grep"],
  );
});

test("keeps mixed tool batches serial", async () => {
  let releaseRead!: () => void;
  let markReadStarted!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  let writeStarted = false;
  const readTool = defineTool({
    name: "read",
    description: "Test read.",
    inputSchema: z.strictObject({}),
    async execute() {
      markReadStarted();
      await readGate;
      return {};
    },
  });
  const writeTool = defineTool({
    name: "write",
    description: "Test write.",
    inputSchema: z.strictObject({}),
    execute() {
      writeStarted = true;
      return {};
    },
  });
  const iterator = streamAgentRun({
    provider: new FakeProvider([
      {
        type: "tool_calls",
        calls: [
          { callId: "call-read", name: "read", arguments: "{}" },
          { callId: "call-write", name: "write", arguments: "{}" },
        ],
      },
      finalStep("done"),
    ]),
    transcript: [{ role: "user", content: "read then write" }],
    toolEnvironment: testToolEnvironment({ tools: [readTool, writeTool] })
  })[Symbol.asyncIterator]();

  while ((await iterator.next()).value?.type !== "tool.started") {
    // Consume the model step prefix.
  }
  const readCompletion = iterator.next();
  await readStarted;
  assert.equal(writeStarted, false);
  releaseRead();
  assert.equal((await readCompletion).value?.type, "tool.completed");
  assert.equal((await iterator.next()).value?.type, "tool.started");
  assert.equal(writeStarted, false);
  assert.equal((await iterator.next()).value?.type, "tool.completed");
  assert.equal(writeStarted, true);
  for (;;) {
    if ((await iterator.next()).done) break;
  }
});

test("keeps a parallel sibling running after an ordinary tool error", async () => {
  let releaseGrep!: () => void;
  const grepGate = new Promise<void>((resolve) => {
    releaseGrep = resolve;
  });
  const readTool = defineTool({
    name: "read",
    description: "Failing read.",
    inputSchema: z.strictObject({}),
    execute() {
      throw new ToolExecutionError("FILE_NOT_FOUND", "Missing file.");
    },
  });
  const grepTool = defineTool({
    name: "grep",
    description: "Successful grep.",
    inputSchema: z.strictObject({}),
    async execute() {
      await grepGate;
      return { matches: [] };
    },
  });
  const provider = new FakeProvider([
    {
      type: "tool_calls",
      calls: [
        { callId: "call-read", name: "read", arguments: "{}" },
        { callId: "call-grep", name: "grep", arguments: "{}" },
      ],
    },
    finalStep("done"),
  ]);
  const iterator = streamAgentRun({
    provider,
    transcript: [{ role: "user", content: "inspect" }],
    toolEnvironment: testToolEnvironment({ tools: [readTool, grepTool] })
  })[Symbol.asyncIterator]();

  while ((await iterator.next()).value?.type !== "tool.completed") {
    // Consume both start events and the first controlled failure.
  }
  releaseGrep();
  for (;;) {
    if ((await iterator.next()).done) break;
  }
  const resultMessage = provider.requests[1]?.transcript.at(-1);
  assert.equal(resultMessage?.role, "tool");
  assert.deepEqual(
    resultMessage?.role === "tool"
      ? resultMessage.results.map(({ result }) => result.status)
      : [],
    ["error", "success"],
  );
});

test("keeps complete transcript history supplied by the context builder", async () => {
  const provider = new FakeProvider([
    toolStep("echo", { text: "first" }),
    toolStep("echo", { text: "second" }),
    toolStep("echo", { text: "third" }),
    finalStep("done"),
  ]);

  assert.equal(
    await runAgent({
      provider,
      transcript: [{ role: "user", content: "echo three times" }],
      toolEnvironment: testToolEnvironment({ tools: [echoTool] })
    }),
    "done",
  );

  assert.deepEqual(provider.requests[3]?.transcript, [
    { role: "user", content: "echo three times" },
    {
      role: "assistant", content: null,
      toolCalls: toolStep("echo", { text: "first" }).calls,
    },
    {
      role: "tool", results: [{
        toolCallId: "provider-call-echo",
        result: { type: "tool_result", tool: "echo", status: "success", output: { text: "first" } },
      }],
    },
    {
      role: "assistant",
      content: null,
      toolCalls: toolStep("echo", { text: "second" }).calls,
    },
    {
      role: "tool",
      results: [{
        toolCallId: "provider-call-echo",
        result: {
        type: "tool_result",
        tool: "echo",
        status: "success",
        output: { text: "second" },
        },
      }],
    },
    {
      role: "assistant",
      content: null,
      toolCalls: toolStep("echo", { text: "third" }).calls,
    },
    {
      role: "tool",
      results: [{
        toolCallId: "provider-call-echo",
        result: {
        type: "tool_result",
        tool: "echo",
        status: "success",
        output: { text: "third" },
        },
      }],
    },
  ]);
});

test("feeds unknown tools, invalid inputs, and tool failures back as errors", async () => {
  const throwingTool = defineTool({
    name: "explode",
    description: "Always fails.",
    inputSchema: z.strictObject({}),
    async execute() {
      throw new Error("boom");
    },
  });
  const provider = new FakeProvider([
    toolStep("missing", {}),
    toolStep("echo", { text: 42 }),
    toolStep("explode", {}),
    finalStep("recovered"),
  ]);

  assert.equal(
    await runAgent({
      provider,
      maxSteps: 5,
      transcript: [{ role: "user", content: "exercise failures" }],
      toolEnvironment: testToolEnvironment({ tools: [echoTool, throwingTool] })
    }),
    "recovered",
  );

  const errorResults = provider.requests.slice(1).map(lastToolResult);
  assert.deepEqual(
    errorResults.map((result) =>
      result.status === "error" ? result.error.code : undefined
    ),
    ["UNKNOWN_TOOL", "INVALID_TOOL_INPUT", "TOOL_EXECUTION_FAILED"],
  );
  assert.equal(
    errorResults[2]?.status === "error"
      ? errorResults[2].error.message
      : undefined,
    "Tool execution failed.",
  );
});

test("rejects oversized tool output before adding it to events or history", async () => {
  const largeTool = defineTool({
    name: "large",
    description: "Returns a large value.",
    inputSchema: z.strictObject({}),
    async execute() {
      return { value: "x".repeat(100_000) };
    },
  });
  const provider = new FakeProvider([
    toolStep("large", {}),
    finalStep("recovered"),
  ]);
  const events: AgentEvent[] = [];

  for await (const event of streamAgentRun({
    provider,
    transcript: [{ role: "user", content: "large" }],
    toolEnvironment: testToolEnvironment({ tools: [largeTool] }),
    run: { ...testRun("run-large-tool-output") }
  })) {
    events.push(event);
  }

  const completed = events.find((event) => event.type === "tool.completed");
  assert.equal(completed?.data.status, "error");
  assert.deepEqual(
    completed?.data.status === "error" ? completed.data.error : undefined,
    {
      code: "TOOL_OUTPUT_TOO_LARGE",
      message: "Tool output exceeded the maximum size.",
    },
  );
  assert.deepEqual(lastToolResult(provider.requests[1]!), {
    type: "tool_result",
    tool: "large",
    status: "error",
    error: {
      code: "TOOL_OUTPUT_TOO_LARGE",
      message: "Tool output exceeded the maximum size.",
    },
  });
});

test("terminates on malformed provider output and provider errors", async () => {
  await assert.rejects(
    runAgent({
      provider: new StreamingFakeProvider([]),
      transcript: [{ role: "user", content: "hi" }]
    }),
    ProtocolError,
  );

  const failure = new Error("network down");
  await assert.rejects(
    runAgent({
      provider: new FakeProvider([failure]),
      transcript: [{ role: "user", content: "hi" }]
    }),
    failure,
  );
});

test("emits run.error and ends the public event stream", async () => {
  const failure = new Error("network down");
  const iterator = streamAgentRun({
    provider: new FakeProvider([failure]),
    transcript: [{ role: "user", content: "hi" }],
    run: { ...testRun("run-error") }
  })[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value?.type, "run.started");
  assert.equal((await iterator.next()).value?.type, "step.started");
  const terminal = await iterator.next();
  assert.equal(terminal.value?.type, "run.error");
  assert.deepEqual(terminal.value?.data, {
    code: "AGENT_RUN_FAILED",
    message: "Agent run failed.",
    usage: emptyUsage(),
  });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("enforces maxSteps after executing the final allowed tool action", async () => {
  let executionCount = 0;
  const countingTool = defineTool({
    name: "count",
    description: "Counts executions.",
    inputSchema: z.strictObject({}),
    async execute() {
      executionCount += 1;
      return { executionCount };
    },
  });
  const provider = new FakeProvider([toolStep("count", {})]);

  await assert.rejects(
    runAgent({
      provider,
      maxSteps: 1,
      transcript: [{ role: "user", content: "count" }],
      toolEnvironment: testToolEnvironment({ tools: [countingTool] })
    }),
    MaxStepsExceededError,
  );
  assert.equal(provider.requests.length, 1);
  assert.equal(executionCount, 1);
});

test("defaults to a 512-step safety limit", async () => {
  let executionCount = 0;
  const countingTool = defineTool({
    name: "count",
    description: "Counts executions.",
    inputSchema: z.strictObject({}),
    async execute() {
      executionCount += 1;
      return { executionCount };
    },
  });
  const provider = new FakeProvider(
    Array.from({ length: 512 }, () => toolStep("count", {})),
  );

  await assert.rejects(
    runAgent({
      provider,
      transcript: [{ role: "user", content: "count" }],
      toolEnvironment: testToolEnvironment({ tools: [countingTool] })
    }),
    (error: unknown) =>
      error instanceof MaxStepsExceededError &&
      error.message ===
        "Agent did not produce a final answer within 512 steps.",
  );
  assert.equal(provider.requests.length, 512);
  // The last step is reserved for the handoff answer and executes no tool.
  assert.equal(executionCount, 511);
});

test("reserves the last step for a handoff answer without tools", async () => {
  let executionCount = 0;
  const countingTool = defineTool({
    name: "count",
    description: "Counts executions.",
    inputSchema: z.strictObject({}),
    async execute() {
      executionCount += 1;
      return { executionCount };
    },
  });
  const provider = new FakeProvider([
    toolStep("count", {}),
    toolStep("count", {}),
    finalStep("Changed src/a.ts; tests unrun; next run the suite."),
  ]);

  const events: AgentEvent[] = [];
  for await (
    const event of streamAgentRun({
      provider,
      maxSteps: 3,
      transcript: [{ role: "user", content: "count" }],
      toolEnvironment: testToolEnvironment({ tools: [countingTool] })
    })
  ) {
    events.push(event);
  }

  assert.equal(executionCount, 2);
  const handoffRequest = provider.requests[2]!;
  assert.deepEqual(handoffRequest.tools, []);
  const lastMessage = handoffRequest.transcript.at(-1)!;
  assert.equal(lastMessage.role, "user");
  assert.match(
    lastMessage.role === "user" ? lastMessage.content : "",
    /step budget for this run is exhausted/,
  );
  const completed = events.find((event) => event.type === "run.completed");
  assert.deepEqual(completed?.data, {
    steps: 3,
    stopReason: "step_limit",
    usage: { calls: 3, unmeasuredCalls: 3, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  });
});

test("reports the final stop reason when the agent answers on its own", async () => {
  const provider = new FakeProvider([finalStep("done")]);
  const events: AgentEvent[] = [];
  for await (
    const event of streamAgentRun({
      provider,
      maxSteps: 4,
      transcript: [{ role: "user", content: "hi" }]
    })
  ) {
    events.push(event);
  }

  const completed = events.find((event) => event.type === "run.completed");
  assert.deepEqual(completed?.data, {
    steps: 1,
    stopReason: "final",
    usage: { calls: 1, unmeasuredCalls: 1, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  });
});

test("carries per-step usage and a run total across two steps", async () => {
  const responses = [
    {
      type: "tool_calls",
      calls: [{ callId: "count-1", name: "count", arguments: "{}" }],
    },
    {
      type: "final",
      content: "done",
    },
  ] as ProviderTurn[];
  const provider: LlmProvider = {
    model: "test-model",
    async *stream(request) {
      const turn = responses.shift()!;
      if (turn.type === "final") {
        yield { type: "output_text.delta", text: turn.content };
      } else {
        yield {
          type: "tool_arguments.delta",
          callIndex: 0,
          text: turn.calls[0].arguments,
        };
      }
      yield {
        type: "completed",
        turn,
        usage: {
          model: "test-model",
          inputTokens: turn.type === "final" ? 200 : 100,
          cachedInputTokens: turn.type === "final" ? 80 : 40,
          outputTokens: turn.type === "final" ? 30 : 20,
          reasoningTokens: turn.type === "final" ? 10 : 5,
        },
      };
    },
  };
  const events: AgentEvent[] = [];
  for await (
    const event of streamAgentRun({
      provider,
      transcript: [{ role: "user", content: "hi" }],
      toolEnvironment: testToolEnvironment({ tools: [] })
    })
  ) {
    events.push(event);
  }

  const stepEvents = events.filter((event) => event.type === "step.completed");
  const completed = events.find((event) => event.type === "run.completed");
  assert.equal(stepEvents.length, 2);
  if (stepEvents[0]?.type === "step.completed") {
    assert.deepEqual(stepEvents[0].data.usage, {
      model: "test-model",
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      reasoningTokens: 5,
    });
  }
  if (stepEvents[1]?.type === "step.completed") {
    assert.deepEqual(stepEvents[1].data.usage, {
      model: "test-model",
      inputTokens: 200,
      cachedInputTokens: 80,
      outputTokens: 30,
      reasoningTokens: 10,
    });
  }
  assert.deepEqual(completed?.data.usage, {
    calls: 2,
    unmeasuredCalls: 0,
    inputTokens: 300,
    cachedInputTokens: 120,
    outputTokens: 50,
    reasoningTokens: 15,
  });
});

test("still fails when the model calls a tool on the handoff step", async () => {
  const countingTool = defineTool({
    name: "count",
    description: "Counts executions.",
    inputSchema: z.strictObject({}),
    async execute() {
      return {};
    },
  });
  const provider = new FakeProvider([
    toolStep("count", {}),
    toolStep("count", {}),
  ]);

  await assert.rejects(
    runAgent({
      provider,
      maxSteps: 2,
      transcript: [{ role: "user", content: "count" }],
      toolEnvironment: testToolEnvironment({ tools: [countingTool] })
    }),
    MaxStepsExceededError,
  );
  assert.equal(provider.requests.length, 2);
});

test("injects steering messages at the step boundary before the provider request", async () => {
  let calls = 0;
  const steeringSource = {
    async take() {
      calls += 1;
      if (calls === 1) return [];
      return [
        { seq: 0, content: "second instruction" },
        { seq: 1, content: "third instruction" },
      ];
    },
  };
  const provider = new FakeProvider([
    toolStep("echo", { text: "first" }),
    finalStep("done"),
  ]);
  const events: AgentEvent[] = [];
  for await (const event of streamAgentRun({
    provider,
    steeringSource,
    transcript: [{ role: "user", content: "original task" }],
    toolEnvironment: testToolEnvironment({ tools: [echoTool] }),
    run: { ...testRun("run-steering") }
  })) {
    events.push(event);
  }

  const applied = events.filter((event) => event.type === "steering.applied");
  assert.deepEqual(applied.map((event) => event.data), [
    { messageSeq: 0, content: "second instruction" },
    { messageSeq: 1, content: "third instruction" },
  ]);
  assert.equal(applied.every((event) => event.step === 2), true);
});

test("steering is not taken on the forced handoff step", async () => {
  const calls: number[] = [];
  const steeringSource = {
    async take(step: number) {
      calls.push(step);
      return [{ seq: 0, content: "late instruction" }];
    },
  };
  const provider = new FakeProvider([
    toolStep("echo", { text: "x" }),
    finalStep("done"),
  ]);
  for await (const event of streamAgentRun({
    provider,
    maxSteps: 2,
    steeringSource,
    transcript: [{ role: "user", content: "task" }],
    toolEnvironment: testToolEnvironment({ tools: [echoTool] })
  })) {
    void event;
  }
  assert.deepEqual(calls, [1]);
});

test("steering take error fails the run", async () => {
  const steeringSource = {
    async take() {
      throw new Error("steering boom");
    },
  };
  const provider = new FakeProvider([finalStep("done")]);
  await assert.rejects(
    runAgent({
      provider,
      steeringSource,
      transcript: [{ role: "user", content: "task" }]
    }),
    /steering boom/,
  );
});

test("rejects invalid configuration", async () => {
  assert.throws(
    () =>
      runAgent({
        provider: new FakeProvider([]),
        transcript: [{ role: "user", content: "hi" }],
        toolEnvironment: testToolEnvironment({ tools: [echoTool, echoTool] })
      }),
    /Duplicate tool name/,
  );
  assert.throws(
    () => runAgent({
      provider: new FakeProvider([]),
      maxSteps: 0,
      transcript: [{ role: "user", content: "hi" }]
    }),
    /maxSteps/,
  );

});

test("waits for approval before executing and resumes the same run after approve", async () => {
  let executionCount = 0;
  const tool = defineTool({
    name: "dangerous",
    description: "Needs confirmation.",
    impact: "Performs one test side effect.",
    inputSchema: z.strictObject({ command: z.string() }),
    execute() {
      executionCount += 1;
      return { executionCount };
    },
  });
  const provider = new FakeProvider([
    toolStep("dangerous", { command: "run" }),
    finalStep("done"),
  ]);
  const broker = new InMemoryInteractionBroker();
  const auditEvents: ToolAuditEvent[] = [];
  const authorizedToolExecutor = new AuthorizedToolExecutor({
    policy: new FixedToolPermissionPolicy({
      dangerous: {
        effect: "confirm",
        ruleId: "dangerous-confirm",
        reason: "Needs confirmation.",
      },
    }),
    interactionBroker: broker,
    auditSink: {
      record(event) {
        auditEvents.push(event);
      },
    },
  });
  const iterator = streamAgentRun({
    provider,
    transcript: [{ role: "user", content: "run it" }],
    toolEnvironment: testToolEnvironment({ tools: [tool], executor: authorizedToolExecutor, permissionContext: { workspaceRoot: "/workspace" } }),
    run: { ...testRun("run-approval") }
  })[Symbol.asyncIterator]();

  const events: AgentEvent[] = [];
  for (let index = 0; index < 4; index += 1) {
    events.push((await iterator.next()).value!);
  }
  const required = events.at(-1);
  assert.equal(required?.type, "interaction.required");
  assert.equal(executionCount, 0);
  assert.equal(broker.pendingCount, 1);
  if (required?.type !== "interaction.required") {
    assert.fail("Expected interaction.required.");
  }
  if (required.kind !== "tool_approval") {
    assert.fail("Expected tool_approval interaction.");
  }
  assert.deepEqual(required.payload.argumentsSummary, { command: "run" });
  assert.equal(required.payload.argumentsDigest.length, 64);

  assert.deepEqual(
    broker.resolve(required.interactionId, { decision: "approve" }),
    { status: "accepted" },
  );
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
  }

  assert.equal(executionCount, 1);
  assert.equal(broker.pendingCount, 0);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "run.started",
      "step.started",
      "step.completed",
      "interaction.required",
      "interaction.resolved",
      "tool.started",
      "tool.completed",
      "step.started",
      "answer.delta",
      "step.completed",
      "answer.completed",
      "run.completed",
    ],
  );
  assert.deepEqual(
    events.map((event) => event.seq),
    events.map((_, index) => index + 1),
  );
  const resolved = events.find(
    (event) => event.type === "interaction.resolved",
  );
  assert.equal(
    resolved?.type === "interaction.resolved"
      ? resolved.interactionId
      : undefined,
    required.interactionId,
  );
  assert.deepEqual(
    auditEvents.map((event) => event.type),
    [
      "policy.decision",
      "interaction.required",
      "interaction.resolution",
      "execution.result",
    ],
  );
  assert.equal(
    JSON.stringify(auditEvents).includes('"command":"run"'),
    false,
  );
});

test("workspace grant approval retries the same read call once without another model step", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "agent-grant-loop-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const workspace = join(parent, "workspace");
  const outside = join(parent, "outside.txt");
  await mkdir(workspace);
  await writeFile(outside, "external content", "utf8");
  const canonicalOutside = await realpath(outside);

  const grants = new InMemoryWorkspaceGrantStore();
  const broker = new InMemoryInteractionBroker();
  const provider = new FakeProvider([
    toolStep("read", { path: outside }),
    finalStep("done"),
  ]);
  const iterator = streamAgentRun({
    provider,
    transcript: [{ role: "user", content: "read it" }],
    toolEnvironment: testToolEnvironment({
      tools: [await createReadTool(workspace, grants)], executor: new AuthorizedToolExecutor({
        policy: new FixedToolPermissionPolicy({
          read: { effect: "allow", ruleId: "read-allow" },
        }),
        interactionBroker: broker,
        workspaceGrantStore: grants,
      }), permissionContext: {
        workspaceRoot: workspace,
        conversationId: "conversation-1",
      }
    }),
    run: { ...testRun("run-workspace-grant") }
  })[Symbol.asyncIterator]();

  const events: AgentEvent[] = [];
  let required:
    | Extract<
        AgentEvent,
        { type: "interaction.required"; kind: "workspace_grant" }
      >
    | undefined;
  while (required === undefined) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    events.push(next.value);
    if (
      next.value.type === "interaction.required" &&
      next.value.kind === "workspace_grant"
    ) {
      required = next.value;
    }
  }
  assert.deepEqual(required.payload, {
    reason: "outside_workspace",
    toolCallId: "provider-call-read",
    toolName: "read",
    requestedPath: canonicalOutside,
    access: "read",
    scope: "once",
  });
  assert.equal(
    broker.resolve(required.interactionId, {
      decision: "approve",
      selectedPath: canonicalOutside,
    }).status,
    "accepted",
  );

  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
  }

  assert.equal(provider.requests.length, 2);
  assert.deepEqual(
    events
      .filter((event) =>
        [
          "interaction.required",
          "interaction.resolved",
          "tool.started",
          "tool.completed",
        ].includes(event.type),
      )
      .map((event) => event.type),
    [
      "interaction.required",
      "interaction.resolved",
      "tool.started",
      "tool.completed",
    ],
  );
  assert.equal(
    events.filter((event) => event.type === "tool.started").length,
    1,
  );
  const completed = events.find(
    (event) => event.type === "tool.completed",
  );
  assert.equal(
    completed?.type === "tool.completed"
      ? completed.data.status
      : undefined,
    "success",
  );
  assert.equal(
    JSON.stringify(provider.requests[1]?.transcript).includes(
      "external content",
    ),
    true,
  );
});

test("denied workspace grant skips tool execution and continues with a controlled result", async () => {
  let executionCount = 0;
  const tool = defineTool({
    name: "external_read",
    description: "Test external read.",
    inputSchema: z.strictObject({}),
    preflight() {
      return {
        kind: "workspace_grant",
        reason: "outside_workspace",
        requestedPath: "/outside.txt",
        canonicalPath: "/outside.txt",
        access: "read",
        scope: "once",
      };
    },
    execute() {
      executionCount += 1;
      return {};
    },
  });
  const broker = new InMemoryInteractionBroker();
  const events: AgentEvent[] = [];
  const iterator = streamAgentRun({
    provider: new FakeProvider([
      toolStep("external_read", {}),
      finalStep("continued"),
    ]),
    transcript: [{ role: "user", content: "read it" }],
    toolEnvironment: testToolEnvironment({
      tools: [tool], executor: new AuthorizedToolExecutor({
        policy: new FixedToolPermissionPolicy({
          external_read: { effect: "allow", ruleId: "allow" },
        }),
        interactionBroker: broker,
        workspaceGrantStore: new InMemoryWorkspaceGrantStore(),
      }), permissionContext: {
        workspaceRoot: "/workspace",
        conversationId: "conversation-1",
      }
    }),
    run: { ...testRun("run-denied-grant") }
  })[Symbol.asyncIterator]();

  let required:
    | Extract<
        AgentEvent,
        { type: "interaction.required"; kind: "workspace_grant" }
      >
    | undefined;
  while (required === undefined) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    events.push(next.value);
    if (
      next.value.type === "interaction.required" &&
      next.value.kind === "workspace_grant"
    ) {
      required = next.value;
    }
  }
  assert.deepEqual(
    broker.resolve(required.interactionId, { decision: "deny" }),
    { status: "accepted" },
  );
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
  }

  assert.equal(executionCount, 0);
  assert.equal(events.some((event) => event.type === "tool.started"), false);
  const completed = events.find(
    (event) => event.type === "tool.completed",
  );
  assert.equal(
    completed?.type === "tool.completed" &&
      completed.data.status === "error"
      ? completed.data.error.code
      : undefined,
    "WORKSPACE_GRANT_DENIED",
  );
  assert.equal(events.at(-1)?.type, "run.completed");
});

test("deny skips execution, emits a controlled ToolResult, and continues the run", async () => {
  let executionCount = 0;
  const tool = defineTool({
    name: "dangerous",
    description: "Needs confirmation.",
    inputSchema: z.strictObject({}),
    execute() {
      executionCount += 1;
      return {};
    },
  });
  const provider = new FakeProvider([
    toolStep("dangerous", {}),
    finalStep("used another approach"),
  ]);
  const broker = new InMemoryInteractionBroker();
  const authorizedToolExecutor = new AuthorizedToolExecutor({
    policy: new FixedToolPermissionPolicy({
      dangerous: { effect: "confirm", ruleId: "confirm" },
    }),
    interactionBroker: broker,
  });
  const iterator = streamAgentRun({
    provider,
    transcript: [{ role: "user", content: "run it" }],
    toolEnvironment: testToolEnvironment({ tools: [tool], executor: authorizedToolExecutor })
  })[Symbol.asyncIterator]();
  const events: AgentEvent[] = [];
  let required:
    | Extract<AgentEvent, { type: "interaction.required" }>
    | undefined;
  while (required === undefined) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    events.push(next.value);
    if (next.value.type === "interaction.required") required = next.value;
  }
  broker.resolve(required.interactionId, { decision: "deny" });
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
  }

  assert.equal(executionCount, 0);
  assert.equal(events.some((event) => event.type === "tool.started"), false);
  const completed = events.find(
    (event) => event.type === "tool.completed",
  );
  assert.equal(
    completed?.type === "tool.completed" &&
      completed.data.status === "error"
      ? completed.data.error.code
      : undefined,
    "TOOL_APPROVAL_DENIED",
  );
  assert.deepEqual(
    lastToolResult(provider.requests[1]!),
    {
      type: "tool_result",
      tool: "dangerous",
      status: "error",
      error: {
        code: "TOOL_APPROVAL_DENIED",
        message: "The user denied this tool call.",
      },
    },
  );
  assert.equal(events.at(-1)?.type, "run.completed");
});

test("expired approval skips execution and abort clears the pending interaction", async () => {
  const tool = defineTool({
    name: "dangerous",
    description: "Needs confirmation.",
    inputSchema: z.strictObject({}),
    execute() {
      assert.fail("Tool must not execute.");
    },
  });
  const policy = new FixedToolPermissionPolicy({
    dangerous: { effect: "confirm", ruleId: "confirm" },
  });

  const expiringBroker = new InMemoryInteractionBroker();
  const expiredEvents: AgentEvent[] = [];
  for await (const event of streamAgentRun({
    provider: new FakeProvider([
      toolStep("dangerous", {}),
      finalStep("expired"),
    ]),
    transcript: [{ role: "user", content: "run it" }],
    toolEnvironment: testToolEnvironment({
      tools: [tool], executor: new AuthorizedToolExecutor({
        policy,
        interactionBroker: expiringBroker,
        interactionTimeoutMs: 5,
      })
    })
  })) {
    expiredEvents.push(event);
  }
  const expiredCompleted = expiredEvents.find(
    (event) => event.type === "tool.completed",
  );
  assert.equal(
    expiredCompleted?.type === "tool.completed" &&
      expiredCompleted.data.status === "error"
      ? expiredCompleted.data.error.code
      : undefined,
    "TOOL_APPROVAL_EXPIRED",
  );
  assert.equal(
    expiredEvents.some((event) => event.type === "tool.started"),
    false,
  );
  assert.equal(expiringBroker.pendingCount, 0);

  const abortingBroker = new InMemoryInteractionBroker();
  const controller = new AbortController();
  const abortReason = new Error("stop");
  const iterator = streamAgentRun({
    provider: new FakeProvider([toolStep("dangerous", {})]),
    signal: controller.signal,
    transcript: [{ role: "user", content: "run it" }],
    toolEnvironment: testToolEnvironment({
      tools: [tool], executor: new AuthorizedToolExecutor({
        policy,
        interactionBroker: abortingBroker,
      })
    })
  })[Symbol.asyncIterator]();
  let next = await iterator.next();
  while (next.value?.type !== "interaction.required") {
    next = await iterator.next();
  }
  const waiting = iterator.next();
  controller.abort(abortReason);
  await assert.rejects(waiting, (error) => error === abortReason);
  assert.equal(abortingBroker.pendingCount, 0);
});

test("default deny hides an unconfigured tool and prevents execution", async () => {
  let executionCount = 0;
  const tool = defineTool({
    name: "unconfigured",
    description: "Not configured.",
    inputSchema: z.strictObject({}),
    execute() {
      executionCount += 1;
      return {};
    },
  });
  const provider = new FakeProvider([
    toolStep("unconfigured", {}),
    finalStep("denied"),
  ]);
  const authorizedToolExecutor = new AuthorizedToolExecutor({
    policy: new FixedToolPermissionPolicy({}),
  });
  const events: AgentEvent[] = [];

  for await (const event of streamAgentRun({
    provider,
    transcript: [{ role: "user", content: "run it" }],
    toolEnvironment: testToolEnvironment({ tools: [tool], executor: authorizedToolExecutor })
  })) {
    events.push(event);
  }

  assert.equal(provider.requests[0]?.tools.length, 0);
  assert.equal(executionCount, 0);
  assert.equal(
    events.some((event) => event.type === "interaction.required"),
    false,
  );
  const completed = events.find(
    (event) => event.type === "tool.completed",
  );
  assert.equal(
    completed?.type === "tool.completed" &&
      completed.data.status === "error"
      ? completed.data.error.code
      : undefined,
    "TOOL_PERMISSION_DENIED",
  );
});

test("run.error carries the usage of calls that already happened", async () => {
  let streamCount = 0;
  const provider: LlmProvider = {
    model: "test-model",
    async *stream() {
      streamCount += 1;
      if (streamCount > 1) {
        throw new Error("provider exploded on the second step");
      }
      const turn: ProviderTurn = {
        type: "tool_calls",
        calls: [{ callId: "call-1", name: "missing", arguments: "{}" }],
      };
      yield { type: "tool_arguments.delta", callIndex: 0, text: "{}" };
      yield {
        type: "completed",
        turn,
        usage: {
          model: "test-model",
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 20,
          reasoningTokens: 5,
        },
      };
    },
  };

  const events: AgentEvent[] = [];
  for await (
    const event of streamAgentRun({
      provider,
      transcript: [{ role: "user", content: "hi" }],
      toolEnvironment: testToolEnvironment({ tools: [] })
    })
  ) {
    events.push(event);
  }

  const runError = events.find((event) => event.type === "run.error");
  assert.equal(runError?.type, "run.error");
  if (runError?.type === "run.error") {
    assert.deepEqual(runError.data.usage, {
      calls: 1,
      unmeasuredCalls: 0,
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      reasoningTokens: 5,
    });
  }
});

test("records a step whose turn exceeds the size limit", async () => {
  const provider: LlmProvider = {
    model: "test-model",
    async *stream() {
      yield {
        type: "completed",
        turn: { type: "final", content: "x".repeat(300_000) },
        usage: {
          model: "test-model",
          inputTokens: 100,
          cachedInputTokens: 0,
          outputTokens: 90_000,
          reasoningTokens: 0,
        },
      };
    },
  };

  const events: AgentEvent[] = [];
  for await (
    const event of streamAgentRun({
      provider,
      transcript: [{ role: "user", content: "hi" }],
      toolEnvironment: testToolEnvironment({ tools: [] })
    })
  ) {
    events.push(event);
  }

  const runError = events.find((event) => event.type === "run.error");
  assert.equal(
    runError?.type === "run.error" ? runError.data.code : undefined,
    "MODEL_OUTPUT_TOO_LARGE",
  );
  if (runError?.type === "run.error") {
    assert.deepEqual(runError.data.usage, {
      calls: 1,
      unmeasuredCalls: 0,
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 90_000,
      reasoningTokens: 0,
    });
  }
});

test("runs at most MAX_CONCURRENT_TOOL_EXECUTIONS read tools at a time", async () => {
  const total = MAX_CONCURRENT_TOOL_EXECUTIONS + 3;
  let inFlight = 0;
  let peakInFlight = 0;
  const releases: Array<() => void> = [];
  const readTool = defineTool({
    name: "read",
    description: "Gated read.",
    inputSchema: z.strictObject({ id: z.number() }),
    async execute() {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      return { content: "x" };
    },
  });
  const provider = new FakeProvider([
    {
      type: "tool_calls",
      calls: Array.from({ length: total }, (_unused, id) => ({
        callId: `call-${id}`,
        name: "read",
        arguments: JSON.stringify({ id }),
      })) as [
        { callId: string; name: string; arguments: string },
        ...{ callId: string; name: string; arguments: string }[],
      ],
    },
    finalStep("done"),
  ]);

  const events = streamAgentRun({
    provider,
    transcript: [{ role: "user", content: "read many" }],
    toolEnvironment: testToolEnvironment({ tools: [readTool] })
  });
  const drain = (async () => {
    for await (const _event of events) {
    }
  })();

  // 逐个放行，窗口应当始终不超过上限。
  for (let released = 0; released < total; released += 1) {
    while (releases.length === 0) await new Promise((resolve) => setImmediate(resolve));
    releases.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await drain;

  assert.equal(peakInFlight, MAX_CONCURRENT_TOOL_EXECUTIONS);
  const resultMessage = provider.requests[1]?.transcript.at(-1);
  assert.equal(
    resultMessage?.role === "tool" ? resultMessage.results.length : 0,
    total,
  );
});

test("retries a truncated step in place instead of failing the run", async () => {
  const provider = new FakeProvider([
    new ProviderTruncatedOutputError("cut off"),
    finalStep("done"),
  ]);

  const events = [];
  for await (const event of streamAgentRun({
    provider,
    transcript: [{ role: "user", content: "write a big file" }]
  })) {
    events.push(event);
  }

  // 重试发生在同一步内，事件仍然成对。
  const started = events.filter((event) => event.type === "step.started");
  const completed = events.filter((event) => event.type === "step.completed");
  assert.equal(started.length, 1);
  assert.equal(completed.length, 1);
  assert.equal(events.at(-1)?.type, "run.completed");

  const retryTranscript = provider.requests[1]?.transcript ?? [];
  const notice = retryTranscript.at(-1);
  assert.equal(notice?.role, "user");
  assert.match(
    notice?.role === "user" ? notice.content : "",
    /cut off at the output token limit/,
  );
});

test("fails with OUTPUT_TRUNCATED once the retries are used up", async () => {
  const provider = new FakeProvider([
    new ProviderTruncatedOutputError("cut off"),
    new ProviderTruncatedOutputError("cut off"),
    new ProviderTruncatedOutputError("cut off"),
  ]);

  const events = [];
  for await (const event of streamAgentRun({
    provider,
    transcript: [{ role: "user", content: "write a big file" }]
  })) {
    events.push(event);
  }

  const failure = events.at(-1);
  assert.equal(failure?.type, "run.error");
  assert.equal(
    failure?.type === "run.error" ? failure.data.code : undefined,
    "OUTPUT_TRUNCATED",
  );
  assert.equal(provider.requests.length, 3);
});

test("reports each step's usage to the context builder for calibration", async () => {
  const responses = [
    toolStep("echo", { text: "first" }),
    finalStep("done"),
  ];
  const provider: LlmProvider = {
    model: "test-model",
    async *stream() {
      const turn = responses.shift()!;
      if (turn.type === "final") {
        yield { type: "output_text.delta", text: turn.content };
      } else {
        yield {
          type: "tool_arguments.delta",
          callIndex: 0,
          text: turn.calls[0].arguments,
        };
      }
      yield {
        type: "completed",
        turn,
        usage: {
          model: "test-model",
          inputTokens: turn.type === "final" ? 200 : 100,
          cachedInputTokens: 0,
          outputTokens: 10,
          reasoningTokens: 0,
        },
      };
    },
  };
  const observed: Array<{ step: number; inputTokens: number }> = [];
  const contextBuilder = {
    async buildContext(request: { currentTranscript: readonly TranscriptMessage[] }) {
      return { transcript: request.currentTranscript };
    },
    observeUsage(report: { step: number; usage: { inputTokens: number } }) {
      observed.push({ step: report.step, inputTokens: report.usage.inputTokens });
    },
  };

  assert.equal(
    await runAgent({
      provider,
      contextBuilder,
      transcript: [{ role: "user", content: "hi" }],
      toolEnvironment: testToolEnvironment({ tools: [echoTool] })
    }),
    "done",
  );
  assert.deepEqual(observed, [
    { step: 1, inputTokens: 100 },
    { step: 2, inputTokens: 200 },
  ]);
});

test("does not report usage to the context builder when the provider has none", async () => {
  const provider = new FakeProvider([finalStep("done")]);
  let observed = 0;
  const contextBuilder = {
    async buildContext(request: { currentTranscript: readonly TranscriptMessage[] }) {
      return { transcript: request.currentTranscript };
    },
    observeUsage() {
      observed += 1;
    },
  };

  assert.equal(await runAgent({
    provider,
    contextBuilder,
    transcript: [{ role: "user", content: "hi" }]
  }), "done");
  assert.equal(observed, 0);
});


/** 与 src/agent-loop.ts 的 MAX_PROVIDER_TURN_BYTES 一致（未导出）。 */
const MAX_PROVIDER_TURN_BYTES_FOR_TEST = 256 * 1024;

const retrying = (attempt: number): ProviderStreamEvent => ({
  type: "retrying",
  attempt,
  maxAttempts: 5,
  delayMs: 1_000,
  reason: "rate_limited",
});

test("emits model.retrying and keeps only the retried attempt's answer", async () => {
  const events: AgentEvent[] = [];
  const usageLog = new RunUsageLog();
  const beforeCompleted: TranscriptMessage[] = [];
  for await (const event of streamAgentRun({
    provider: new StreamingFakeProvider([
      { type: "output_text.delta", text: "stale " },
      retrying(2),
      { type: "output_text.delta", text: "fresh" },
      { type: "completed", turn: finalStep("fresh") },
    ]),
    transcript: [{ role: "user", content: "hi" }],
    run: { ...testRun(), usageLog: usageLog },
    lifecycle: {
      beforeCompleted: ({ transcript }) => {
        beforeCompleted.push(...transcript);
      }
    }
  })) {
    events.push(event);
  }

  assert.deepEqual(events.map((event) => event.type), [
    "run.started",
    "step.started",
    "answer.delta",
    "model.retrying",
    "answer.delta",
    "step.completed",
    "answer.completed",
    "run.completed",
  ]);
  const retry = events.find((event) => event.type === "model.retrying");
  assert.deepEqual(retry?.type === "model.retrying" ? retry.data : undefined, {
    attempt: 2,
    maxAttempts: 5,
    delayMs: 1_000,
    reason: "rate_limited",
  });
  const answer = events.find((event) => event.type === "answer.completed");
  assert.equal(answer?.type === "answer.completed" ? answer.data.answer : "", "fresh");
  // transcript 只追加一条 assistant 消息，用量只记一次。
  assert.deepEqual(beforeCompleted.filter((m) => m.role === "assistant"), [
    { role: "assistant", content: "fresh" },
  ]);
  assert.equal(usageLog.calls.length, 1);
});

test("resets the streamed-byte budget when the provider retries", async () => {
  const almostFull = "x".repeat(MAX_PROVIDER_TURN_BYTES_FOR_TEST - 1);
  const events: AgentEvent[] = [];
  for await (const event of streamAgentRun({
    provider: new StreamingFakeProvider([
      { type: "output_text.delta", text: almostFull },
      retrying(2),
      { type: "output_text.delta", text: almostFull },
      { type: "completed", turn: finalStep(almostFull) },
    ]),
    transcript: [{ role: "user", content: "hi" }]
  })) {
    events.push(event);
  }
  assert.equal(events.at(-1)?.type, "run.completed");
});

test("maps ProviderUnavailableError to MODEL_UNAVAILABLE", async () => {
  const events: AgentEvent[] = [];
  for await (const event of streamAgentRun({
    provider: new FakeProvider([new ProviderUnavailableError(5, "overloaded")]),
    transcript: [{ role: "user", content: "hi" }]
  })) {
    events.push(event);
  }
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "run.error");
  assert.deepEqual(terminal?.type === "run.error" ? terminal.data.code : "", "MODEL_UNAVAILABLE");
});

test("writes a transcript.invalid_on_failure diagnostic when a failed write leaves an unmatched batch", async () => {
  const messages = captureStderr(() => {
    assertTranscriptCompleteOnWrite([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ callId: "call-1", name: "read", arguments: "{}" }],
      },
    ], "run-diag");
  });
  assert.equal(messages.length, 1);
  const parsed = JSON.parse(messages[0]!);
  assert.equal(parsed.event, "transcript.invalid_on_failure");
  assert.equal(parsed.runId, "run-diag");
  assert.match(parsed.message, /incomplete or mismatched/);
});

function captureStderr(fn: () => void): string[] {
  const original = process.stderr.write;
  const lines: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}
