import assert from "node:assert/strict";
import test from "node:test";

import OpenAI from "openai";

import type { AgentEvent } from "../src/agent-events.js";
import { streamAgentRun as streamAgentRunRaw } from "../src/agent-loop.js";
import { DeepSeekProvider } from "../src/providers/deepseek.js";
import {
  DEFAULT_RETRY_POLICY,
  RetryingProvider,
} from "../src/providers/retrying-provider.js";
import { AuthorizedToolExecutor, allowAllToolPermissionPolicy } from "../src/tool-permissions.js";
import {
  startFakeChatCompletionsServer,
  type FakeChatResponse,
} from "./support/fake-chat-completions-server.js";
import { testRunOptions, testToolEnvironment, testRun } from "./support/agent-run-options.js";

function streamAgentRun(options: Parameters<typeof testRunOptions>[0]) {
  return streamAgentRunRaw(testRunOptions(options));
}

// 端到端：真实 OpenAI SDK + 真实 HTTP 连接 → DeepSeekProvider → RetryingProvider → agent loop。
// 只把退避等待换成记录，不真的睡。

interface RunResult {
  readonly events: readonly AgentEvent[];
  readonly sleeps: readonly number[];
  readonly requestCount: number;
}

async function runAgainst(
  responses: readonly FakeChatResponse[],
): Promise<RunResult> {
  await using server = await startFakeChatCompletionsServer(responses);
  const client = new OpenAI({ apiKey: "test-key", baseURL: server.baseURL });
  const inner = new DeepSeekProvider({
    apiKey: "test-key",
    model: "fake-model",
    createStreamingChatCompletion: async (body, options) =>
      client.chat.completions.create(body, options),
  });
  const sleeps: number[] = [];
  const provider = new RetryingProvider(inner, DEFAULT_RETRY_POLICY, {
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
    },
    random: () => 0.5,
  });
  const events: AgentEvent[] = [];
  for await (const event of streamAgentRun({
    systemPrompt: "Test system prompt.",
    provider,
    transcript: [{ role: "user", content: "hi" }],
    toolEnvironment: testToolEnvironment({
      tools: [], executor: new AuthorizedToolExecutor({
        policy: allowAllToolPermissionPolicy,
      }), permissionContext: { workspaceRoot: "/workspace" }
    })
  })) {
    events.push(event);
  }
  return { events, sleeps, requestCount: server.requestCount };
}

function finalAnswer(events: readonly AgentEvent[]): string | undefined {
  const event = events.find((item) => item.type === "answer.completed");
  return event?.type === "answer.completed" ? event.data.answer : undefined;
}

function retries(events: readonly AgentEvent[]) {
  return events.flatMap((event) =>
    event.type === "model.retrying" ? [event.data] : []
  );
}

test("retries a 429 with Retry-After and completes the run", async () => {
  const result = await runAgainst([
    { kind: "error", status: 429, headers: { "retry-after": "1" } },
    { kind: "stream", deltas: ["hel", "lo"] },
  ]);
  assert.equal(result.requestCount, 2);
  assert.equal(finalAnswer(result.events), "hello");
  assert.deepEqual(retries(result.events).map((retry) => retry.reason), [
    "rate_limited",
  ]);
  // 服务端要求至少等 1 秒，jitter 只会往上加。
  assert.ok(result.sleeps[0]! >= 1_000);
  assert.equal(result.events.at(-1)?.type, "run.completed");
});

test("discards the partial output of a stream that dropped mid-way", async () => {
  const result = await runAgainst([
    { kind: "disconnect", deltas: ["STALE-", "PARTIAL"] },
    { kind: "stream", deltas: ["fresh"] },
  ]);
  assert.equal(result.requestCount, 2);
  assert.deepEqual(retries(result.events).map((retry) => retry.reason), [
    "connection",
  ]);
  assert.equal(finalAnswer(result.events), "fresh");
  assert.doesNotMatch(finalAnswer(result.events) ?? "", /STALE/);
});

test("gives up with MODEL_UNAVAILABLE when the service stays at 503", async () => {
  const result = await runAgainst([{ kind: "error", status: 503 }]);
  assert.equal(result.requestCount, DEFAULT_RETRY_POLICY.maxAttempts);
  assert.equal(retries(result.events).length, DEFAULT_RETRY_POLICY.maxAttempts - 1);
  const totalWait = result.sleeps.reduce((sum, delay) => sum + delay, 0);
  assert.ok(totalWait <= DEFAULT_RETRY_POLICY.maxTotalDelayMs);
  const terminal = result.events.at(-1);
  assert.equal(terminal?.type, "run.error");
  assert.equal(terminal?.type === "run.error" ? terminal.data.code : "", "MODEL_UNAVAILABLE");
});

test("does not retry a 401", async () => {
  const result = await runAgainst([{ kind: "error", status: 401 }]);
  assert.equal(result.requestCount, 1);
  assert.deepEqual(retries(result.events), []);
  const terminal = result.events.at(-1);
  assert.equal(terminal?.type === "run.error" ? terminal.data.code : "", "AGENT_RUN_FAILED");
});
