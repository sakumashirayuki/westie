import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  streamAgentRun,
  type RunAgentOptions,
} from "../src/agent-loop.js";
import { createAgentRun } from "../src/agent-run.js";
import { AgentEventType } from "../src/agent-events.js";
import { ContextBuilder } from "../src/application/context-builder.js";
import { allowAllToolPermissionPolicy, AuthorizedToolExecutor } from "../src/tool-permissions.js";
import { defineTool } from "../src/tools.js";
import { finalTurn, providerFromTurnFactory, toolCallTurn } from "./support/provider.js";

const systemPrompt = "Test system prompt.";

function options(overrides: Partial<RunAgentOptions> = {}): RunAgentOptions {
  const run = overrides.run ?? createAgentRun({ runId: "options-test" });
  return {
    transcript: [{ role: "user", content: "hello" }],
    systemPrompt,
    provider: providerFromTurnFactory(() => finalTurn("done")),
    contextBuilder: {
      async buildContext(request) {
        return { transcript: request.currentTranscript };
      },
    },
    toolEnvironment: {
      tools: [],
      executor: new AuthorizedToolExecutor({ policy: allowAllToolPermissionPolicy }),
      permissionContext: { workspaceRoot: "/workspace" },
    },
    run,
    ...overrides,
  };
}

test("clones the input transcript and keeps one run's event and usage records", async () => {
  const transcript = [{ role: "user" as const, content: "hello" }];
  const run = createAgentRun({ runId: "shared-run" });
  const provider = {
    model: "test-model",
    async *stream() {
      yield { type: "output_text.delta" as const, text: "done" };
      yield {
        type: "completed" as const,
        turn: finalTurn("done"),
        usage: {
          model: "test-model",
          inputTokens: 3,
          cachedInputTokens: 0,
          outputTokens: 1,
          reasoningTokens: 0,
        },
      };
    },
  };
  const events = [];

  for await (const event of streamAgentRun(options({ transcript, provider, run }))) {
    events.push(event);
  }

  assert.deepEqual(transcript, [{ role: "user", content: "hello" }]);
  assert.equal(events[0]?.runId, "shared-run");
  assert.equal(events.at(-1)?.type, AgentEventType.RunCompleted);
  const started = events.find((event) => event.type === AgentEventType.RunStarted);
  const completed = events.find((event) => event.type === AgentEventType.RunCompleted);
  assert.equal(started?.seq, 1);
  assert.equal(completed?.seq, events.length);
  assert.equal(run.usageLog.calls.length, 1);
});

test("passes the complete transcript through ContextBuilder across five tool steps", async () => {
  const tool = defineTool({
    name: "record",
    description: "Record one value.",
    inputSchema: z.object({ value: z.string() }),
    execute: async () => ({ ok: true }),
  });
  let calls = 0;
  const requestObjects: import("../src/transcript.js").TranscriptMessage[][] = [];
  const received: import("../src/transcript.js").TranscriptMessage[][] = [];
  const provider = {
    model: "test-model",
    contextWindowTokens: 64_000,
    maxOutputTokens: 4_000,
    async *stream(request: { transcript: readonly import("../src/transcript.js").TranscriptMessage[] }) {
      requestObjects.push(request.transcript as import("../src/transcript.js").TranscriptMessage[]);
      received.push(request.transcript.map((message) => ({ ...message })));
      calls += 1;
      const turn = calls <= 5
        ? toolCallTurn("record", { value: `step-${calls}` }, `call-${calls}`)
        : finalTurn("finished");
      if (turn.type === "tool_calls") {
        yield { type: "tool_arguments.delta" as const, callIndex: 0, text: turn.calls[0].arguments };
      } else {
        yield { type: "output_text.delta" as const, text: turn.content };
      }
      yield { type: "completed" as const, turn };
    },
  };
  const contextBuilder = new ContextBuilder({ provider });
  const inputTranscript = [{ role: "user" as const, content: "hello" }];

  const events = [];
  for await (const event of streamAgentRun(options({ provider, contextBuilder, transcript: inputTranscript, toolEnvironment: {
    tools: [tool],
    executor: new AuthorizedToolExecutor({ policy: allowAllToolPermissionPolicy }),
    permissionContext: { workspaceRoot: "/workspace" },
  } }))) {
    events.push(event);
  }

  assert.equal(events.at(-1)?.type, AgentEventType.RunCompleted);
  assert.equal(calls, 6);
  assert.equal(received.length, 6);
  assert.equal(received.at(-1)?.length, 11);
  assert.deepEqual(received.at(-1)?.[0], { role: "user", content: "hello" });
  assert.equal(received.at(-1)?.some((message) => message.role === "tool" && message.results.some(result => result.toolCallId === "call-1")), true);
  assert.equal(received.at(-1)?.some((message) => message.role === "assistant" && message.content === null && message.toolCalls.some((call) => call.callId === "call-1")), true);
  assert.notStrictEqual(requestObjects.at(-1), inputTranscript);
  assert.notStrictEqual(requestObjects.at(-1)?.[0], inputTranscript[0]);
  assert.deepEqual(inputTranscript, [{ role: "user", content: "hello" }]);
});

test("awaits beforeCompleted before publishing run.completed", async () => {
  let release!: () => void;
  let entered!: () => void;
  const callbackEntered = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let completed = false;
  const consuming = (async () => {
    for await (const event of streamAgentRun(options({
      lifecycle: { beforeCompleted: async () => { entered(); await gate; } },
    }))) {
      if (event.type === AgentEventType.RunCompleted) completed = true;
    }
  })();

  await callbackEntered;
  assert.equal(completed, false);
  release();
  await consuming;
  assert.equal(completed, true);
});
