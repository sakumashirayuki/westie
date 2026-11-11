import assert from "node:assert/strict";
import test from "node:test";

import {
  streamAgentRun,
  type LlmProvider,
  type ProviderRequest,
} from "../src/agent-loop.js";
import type { AgentEvent } from "../src/agent-events.js";
import type { ToolErrorCode } from "../src/protocol.js";
import type {
  ProviderStreamEvent,
  ProviderTurn,
} from "../src/provider-protocol.js";
import {
  StopHookFailedError,
  type StopHook,
  type StopHookDecision,
  type StopHookRequest,
} from "../src/stop-hook.js";
import { parseStopHookRecord } from "../src/stop-hook-result.js";
import type { TranscriptMessage } from "../src/transcript.js";
import { getCurrentTimeTool } from "../src/tools/get-current-time.js";
import {
  testRunOptions,
  testToolEnvironment,
} from "./support/agent-run-options.js";

class ScriptedProvider implements LlmProvider {
  readonly model = "test-model";
  readonly requests: ProviderRequest[] = [];

  constructor(private readonly turns: readonly ProviderTurn[]) {}

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(request);
    const turn = this.turns[this.requests.length - 1];
    if (turn === undefined) throw new Error("No scripted turn left.");
    if (turn.type === "final") {
      yield { type: "output_text.delta", text: turn.content };
    }
    yield { type: "completed", turn };
  }
}

function final(content: string): ProviderTurn {
  return { type: "final", content };
}

function toolCall(callId: string): ProviderTurn {
  return {
    type: "tool_calls",
    calls: [
      {
        callId,
        name: "get_current_time",
        arguments: JSON.stringify({ timezone: "UTC" }),
      },
    ],
  };
}

/** 按顺序返回脚本化结果的 Hook；记录每次收到的检查请求。 */
class ScriptedStopHook implements StopHook {
  readonly command = "node .agents/check.mjs";
  readonly maxContinuations: number;
  readonly requests: StopHookRequest[] = [];

  constructor(
    maxContinuations: number,
    private readonly outcomes: readonly (
      | StopHookDecision
      | {
          readonly failure: {
            readonly code: ToolErrorCode;
            readonly message: string;
          };
        }
    )[],
  ) {
    this.maxContinuations = maxContinuations;
  }

  async *check(
    request: StopHookRequest,
  ): AsyncGenerator<AgentEvent, StopHookDecision, void> {
    this.requests.push(request);
    const outcome = this.outcomes[this.requests.length - 1];
    if (outcome === undefined) throw new Error("No scripted outcome left.");
    if ("failure" in outcome) {
      // 与真实实现一致：先发布工具失败事件，再由主循环映射为检查故障。
      yield {
        v: 1,
        runId: "test-run",
        seq: 1,
        type: "tool.completed",
        step: request.step,
        data: {
          toolCallId: "test-run:stop_hook:1:1",
          name: "stop_hook",
          status: "error",
          error: outcome.failure,
          durationMs: 1,
        },
      };
      // 与真实实现一致：先发布工具失败事件（前端展示），再抛出带诊断码的
      // 异常，主循环据此失败。
      throw new StopHookFailedError(
        outcome.failure.code,
        outcome.failure.message,
      );
    }
    return outcome;
  }
}

interface Collected {
  readonly events: AgentEvent[];
  readonly transcript: TranscriptMessage[];
  readonly completed: boolean;
}

async function collect(
  options: Parameters<typeof streamAgentRun>[0],
): Promise<Collected> {
  const events: AgentEvent[] = [];
  let transcript: TranscriptMessage[] = [];
  let completed = false;
  const stream = streamAgentRun({
    ...options,
    lifecycle: {
      beforeCompleted: ({ transcript: finalTranscript }) => {
              transcript = [...finalTranscript];
      },
      beforeFailed: ({ transcript: finalTranscript }) => {
        transcript = [...finalTranscript];
      },
    },
  });
  for await (const event of stream) {
    events.push(event);
    if (event.type === "run.completed") completed = true;
  }
  return { events, transcript, completed };
}

function roles(transcript: readonly TranscriptMessage[]): string[] {
  return transcript.map((message) => message.role);
}

function stopHookRecord(
  message: TranscriptMessage | undefined,
): ReturnType<typeof parseStopHookRecord> {
  assert.ok(message !== undefined);
  assert.ok(message.role === "user" && "source" in message);
  return parseStopHookRecord(
    message as Extract<TranscriptMessage, { source: "stop_hook" }>,
  );
}

function errorCodes(events: readonly AgentEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "run.error" ? [event.data.code] : []
  );
}

test("accepts the candidate answer when the check allows it", async () => {
  const provider = new ScriptedProvider([final("实现已完成。")]);
  const hook = new ScriptedStopHook(2, [{ decision: "allow" }]);
  const { events, transcript, completed } = await collect(
    testRunOptions({ provider, stopHook: hook }),
  );

  assert.equal(completed, true);
  assert.equal(hook.requests.length, 1);
  assert.equal(hook.requests[0]!.candidateAnswer, "实现已完成。");
  assert.equal(hook.requests[0]!.step, 1);
  assert.equal(hook.requests[0]!.continuations, 0);
  assert.deepEqual(
    events.flatMap((event) =>
      event.type === "answer.delta" ? [event.data.text] : []
    ),
    ["实现已完成。"],
  );
  // 放行也写一条记录，排在最终回答之前。
  assert.deepEqual(roles(transcript), ["user", "user", "assistant"]);
  assert.deepEqual(stopHookRecord(transcript[1]), {
    command: "node .agents/check.mjs",
    step: 1,
    decision: "allow",
    applied: true,
  });
});

test("keeps the rejected candidate hidden and continues after a block", async () => {
  const provider = new ScriptedProvider([
    final("实现已完成。"),
    final("补充了空输入用例。"),
  ]);
  const hook = new ScriptedStopHook(2, [
    { decision: "block", reason: "空输入测试未通过" },
    { decision: "allow" },
  ]);
  const { events, transcript, completed } = await collect(
    testRunOptions({ provider, stopHook: hook }),
  );

  assert.equal(completed, true);
  assert.deepEqual(
    events.flatMap((event) =>
      event.type === "answer.completed" ? [event.data.answer] : []
    ),
    ["补充了空输入用例。"],
  );
  assert.ok(
    events.every((event) =>
      event.type !== "answer.delta" || event.data.text !== "实现已完成。"
    ),
  );
  assert.equal(hook.requests.length, 2);
  assert.equal(hook.requests[1]!.continuations, 1);
  assert.deepEqual(stopHookRecord(transcript[1]), {
    command: "node .agents/check.mjs",
    step: 1,
    decision: "block",
    reason: "空输入测试未通过",
    applied: true,
  });
  // 拒绝记录之后是第二次检查的放行记录与最终回答；候选回答全文不入库。
  assert.deepEqual(
    roles(transcript),
    ["user", "user", "user", "assistant"],
  );
  assert.deepEqual(stopHookRecord(transcript[2]), {
    command: "node .agents/check.mjs",
    step: 2,
    decision: "allow",
    applied: true,
  });
  assert.equal(provider.requests.length, 2);
});

test("fails when the continuation limit is reached", async () => {
  const provider = new ScriptedProvider([final("a"), final("b"), final("c")]);
  const hook = new ScriptedStopHook(1, [
    { decision: "block", reason: "仍未通过" },
    { decision: "block", reason: "仍未通过" },
  ]);
  const { events, completed } = await collect(
    testRunOptions({ provider, stopHook: hook }),
  );

  assert.equal(completed, false);
  assert.equal(hook.requests.length, 2);
  assert.deepEqual(errorCodes(events), ["STOP_HOOK_LIMIT_REACHED"]);
});

test("fails on the first block when no continuation is allowed", async () => {
  const provider = new ScriptedProvider([final("a")]);
  const hook = new ScriptedStopHook(0, [
    { decision: "block", reason: "未完成" },
  ]);
  const { events } = await collect(
    testRunOptions({ provider, stopHook: hook }),
  );

  assert.equal(hook.requests.length, 1);
  assert.deepEqual(errorCodes(events), ["STOP_HOOK_LIMIT_REACHED"]);
});

test("does not check the step limit handoff answer", async () => {
  const hook = new ScriptedStopHook(2, [{ decision: "allow" }]);
  const provider = new ScriptedProvider([toolCall("call-1"), final("handoff")]);
  const { events, completed } = await collect(
    testRunOptions({
      provider,
      stopHook: hook,
      maxSteps: 2,
      toolEnvironment: testToolEnvironment({ tools: [getCurrentTimeTool] }),
    }),
  );

  // 第 1 步调用工具，第 2 步是禁用工具的交接步：整个 Run 不执行完成检查。
  assert.equal(hook.requests.length, 0);
  assert.equal(completed, true);
  assert.deepEqual(errorCodes(events), []);
  const completedEvent = events.find((event) => event.type === "run.completed");
  assert.equal(
    completedEvent?.type === "run.completed"
      ? completedEvent.data.stopReason
      : undefined,
    "step_limit",
  );
});

test("discards a candidate whose check raced with new input", async () => {
  const provider = new ScriptedProvider([final("旧回答"), final("新回答")]);
  const arriving = new ScriptedStopHook(2, [
    { decision: "block", reason: "未完成" },
    { decision: "allow" },
  ]);
  let pending = 0;
  const steeringQueue = {
    async take() {
      if (pending === 0) return [];
      pending = 0;
      return [{ seq: 0, content: "顺便加上文档" }];
    },
    hasPending: () => pending > 0,
  };
  // 第 1 次检查进行中时到达新消息。
  const checkingHook: StopHook = {
    command: "node .agents/check.mjs",
    maxContinuations: 2,
    async *check(request) {
      const decision = yield* arriving.check(request);
      if (arriving.requests.length === 1) pending = 1;
      return decision;
    },
  };
  const { transcript, completed } = await collect(
    testRunOptions({
      provider,
      stopHook: checkingHook,
      steeringSource: steeringQueue,
    }),
  );

  assert.equal(completed, true);
  // 过期的那次检查不应用、不计入补做次数；新回答再检查一次才放行。
  assert.equal(arriving.requests.length, 2);
  assert.equal(arriving.requests[1]!.candidateAnswer, "新回答");
  assert.equal(arriving.requests[1]!.continuations, 0);
  // 记录紧跟在被作废的那次检查之后；新消息由第 2 步取走后追加在后面。
  assert.deepEqual(
    roles(transcript),
    ["user", "user", "user", "user", "assistant"],
  );
  assert.deepEqual(stopHookRecord(transcript[1]), {
    command: "node .agents/check.mjs",
    step: 1,
    decision: "block",
    reason: "未完成",
    applied: false,
  });
  assert.deepEqual(stopHookRecord(transcript[3]), {
    command: "node .agents/check.mjs",
    step: 2,
    decision: "allow",
    applied: true,
  });
});

test("records a failed check before failing the run", async () => {
  const provider = new ScriptedProvider([final("a")]);
  const hook = new ScriptedStopHook(2, [
    { failure: { code: "COMMAND_TIMEOUT", message: "Command timed out after 30000ms." } },
  ]);
  const { events, transcript } = await collect(
    testRunOptions({ provider, stopHook: hook }),
  );

  assert.deepEqual(errorCodes(events), ["STOP_HOOK_FAILED"]);
  // 失败前先把完成的工具事件发给前端，卡片不会停在“执行中”。
  const eventTypes = events.map((event) => event.type);
  assert.ok(eventTypes.indexOf("tool.completed") < eventTypes.indexOf("run.error"));
  // 检查自己已经发过完成事件，不再补发：前端只应有一张失败卡片。
  assert.equal(eventTypes.filter((type) => type === "tool.completed").length, 1);
  assert.deepEqual(roles(transcript), ["user", "user"]);
  assert.deepEqual(stopHookRecord(transcript[1]), {
    command: "node .agents/check.mjs",
    step: 1,
    decision: "error",
    reason: "COMMAND_TIMEOUT: Command timed out after 30000ms.",
    applied: false,
  });
});

test("a check that throws before any tool event still ends the trace", async () => {
  const provider = new ScriptedProvider([final("a")]);
  const hook: StopHook = {
    command: "node .agents/check.mjs",
    maxContinuations: 2,
    async *check() {
      throw new StopHookFailedError("STOP_HOOK_OUTPUT_INVALID", "bad output");
    },
  };
  const { events, transcript } = await collect(
    testRunOptions({ provider, stopHook: hook }),
  );

  assert.deepEqual(errorCodes(events), ["STOP_HOOK_FAILED"]);
  // 即使检查没发事件，也补一条完成的工具事件，卡片不会停在“执行中”。
  const completed = events.filter((event) => event.type === "tool.completed");
  assert.equal(completed.length, 1);
  assert.equal(
    completed[0]?.type === "tool.completed" ? completed[0].data.status : undefined,
    "error",
  );
  assert.deepEqual(roles(transcript), ["user", "user"]);
  assert.deepEqual(stopHookRecord(transcript[1]), {
    command: "node .agents/check.mjs",
    step: 1,
    decision: "error",
    reason: "STOP_HOOK_OUTPUT_INVALID: bad output",
    applied: false,
  });
});

test("keeps the plain final flow when no hook is configured", async () => {
  const provider = new ScriptedProvider([final("answer")]);
  const { events, transcript } = await collect(testRunOptions({ provider }));

  assert.deepEqual(
    events.flatMap((event) =>
      event.type === "answer.delta" ? [event.data.text] : []
    ),
    ["answer"],
  );
  assert.deepEqual(transcript, [
    { role: "user", content: "test" },
    { role: "assistant", content: "answer" },
  ]);
});
