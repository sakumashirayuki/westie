import assert from "node:assert/strict";
import test from "node:test";

import { AgentEventType, type AgentEvent } from "../src/agent-events.js";
import {
  MAX_RUN_EVENT_LOG_BYTES,
  RunEventLog,
  RunEventLogTruncatedError,
} from "../src/application/run-event-log.js";
import { RunRegistry } from "../src/application/run-registry.js";
import type { StartedConversationRun } from "../src/application/conversation-run-service.js";
import type { RunEventSource, RunStreamRecord } from "../src/run-stream.js";

function event(seq: number, type: AgentEvent["type"]): AgentEvent {
  return { v: 1, runId: "run-1", seq, type, data: {} } as AgentEvent;
}
function source(value: AgentEvent): RunEventSource { return { event: value }; }

test("RunEventLog replays seq > afterSeq then truncates on exceeding the cap", async () => {
  const log = new RunEventLog();
  log.append(source(event(1, AgentEventType.RunStarted)));
  log.append(source(event(2, AgentEventType.StepStarted)));

  const controller = new AbortController();
  const iterable = log.subscribe(1, controller.signal);
  const iterator = iterable[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.streamSeq, 2);

  // 追加超过上限的单条事件触发截断。
  const huge: AgentEvent = {
    v: 1,
    runId: "run-1",
    seq: 3,
    step: 1,
    type: AgentEventType.ToolCompleted,
    data: {
      toolCallId: "t",
      name: "x",
      status: "success",
      result: "a".repeat(MAX_RUN_EVENT_LOG_BYTES),
      durationMs: 0,
    },
  };
  log.append(source(huge));
  // 截断后新订阅者拿不到可回放的日志。
  assert.equal(log.truncated, true);
  assert.throws(
    () => log.subscribe(0, new AbortController().signal),
    RunEventLogTruncatedError,
  );
  // 已有订阅者继续收到实时事件。
  const next = await iterator.next();
  assert.equal(next.value.streamSeq, 3);
  log.close();
  const done = await iterator.next();
  assert.equal(done.done, true);
});

test("RunEventLog stores answer.delta with a continuous stream sequence", async () => {
  const log = new RunEventLog();
  const controller = new AbortController();
  const iterable = log.subscribe(0, controller.signal);
  const iterator = iterable[Symbol.asyncIterator]();

  log.append(source(event(1, AgentEventType.RunStarted)));
  await iterator.next();
  log.append(source(event(2, AgentEventType.AnswerDelta)));
  const delta = await iterator.next();
  assert.equal(delta.value.event.type, AgentEventType.AnswerDelta);
  const second = log.subscribe(0, new AbortController().signal);
  const secondIterator = second[Symbol.asyncIterator]();
  assert.equal((await secondIterator.next()).value.event.type, AgentEventType.RunStarted);
  assert.equal((await secondIterator.next()).value.event.type, AgentEventType.AnswerDelta);
  log.close();
});

test("RunEventLog live subscription is registered before the iterator is consumed", async () => {
  const log = new RunEventLog(256);
  const live = log.subscribeLive(0, new AbortController().signal);
  // This append happens before for-await invokes the iterator. It must not be lost.
  log.append(source(event(2, AgentEventType.StepStarted)));
  const iterator = live[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.streamSeq, 1);
  log.close();
  assert.equal((await iterator.next()).done, true);
});

test("truncated log keeps the latest sequence for snapshot recovery", async () => {
  const log = new RunEventLog(1);
  log.append(source(event(4, AgentEventType.RunStarted)));
  log.append(source(event(9, AgentEventType.StepStarted)));
  assert.equal(log.truncated, true);
  assert.equal(log.latestStreamSeq, 2);
  const controller = new AbortController();
  const live = log.subscribeLive(2, controller.signal);
  const iterator = live[Symbol.asyncIterator]();
  log.append(source(event(10, AgentEventType.RunCompleted)));
  assert.equal((await iterator.next()).value.streamSeq, 3);
  log.close();
});

test("run.cancelled is synthesized by the pump when the run is cancelled", async () => {
  const events: RunStreamRecord[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = {
    startRun(command: {
      conversationId: string;
      input: string;
      signal: AbortSignal;
    }): StartedConversationRun {
      return {
        runId: "run-1",
        events: (async function* () {
          yield source(event(1, AgentEventType.RunStarted));
          yield source(event(2, AgentEventType.StepStarted));
          command.signal.addEventListener("abort", () => {
            release();
          }, { once: true });
          await gate;
          command.signal.throwIfAborted();
        })(),
      };
    },
  };
  const registry = new RunRegistry({ runService: service });
  registry.start({ conversationId: "c1", input: "hi" });
  const active = registry.get("run-1");
  assert.ok(active);

  const registrySignal = new AbortController();
  const iterable = registry.subscribe("run-1", 0, registrySignal.signal);
  const reading = (async () => {
    for await (const event of iterable) {
      events.push(event);
    }
  })();

  // 等前两条事件回放后取消。
  await new Promise((resolve) => setImmediate(resolve));
  registry.cancel("run-1", "Run cancelled by request.");
  await reading;

  assert.equal((events.at(-1) as Extract<RunStreamRecord, { event: unknown }>).event.type, AgentEventType.RunCancelled);
  assert.deepEqual((events.at(-1) as Extract<RunStreamRecord, { event: unknown }>).event.data, {});
});

test("RunRegistry removes an ended run after the retention window", async () => {
  let now = 1_000_000;
  const service = {
    startRun(): StartedConversationRun {
      return {
        runId: "run-1",
        events: (async function* () {
          yield source(event(1, AgentEventType.RunStarted));
          yield source({
            v: 1,
            runId: "run-1",
            seq: 2,
            type: AgentEventType.RunCompleted,
            data: { steps: 1, stopReason: "final", usage: { calls: 0, unmeasuredCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 } },
          });
        })(),
      };
    },
  };
  const registry = new RunRegistry({
    runService: service,
    retentionMs: 100,
    now: () => now,
  });
  registry.start({ conversationId: "c1", input: "hi" });
  assert.ok(registry.get("run-1"));
  // 推进到结束 + 保留期之内，仍保留。
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(registry.get("run-1"));
  // 超过保留期后移除。
  now += 200;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(registry.get("run-1"), undefined);
});

test("RunRegistry ends status follows the terminal event type", async () => {
  const service = {
    startRun(): StartedConversationRun {
      return {
        runId: "run-1",
        events: (async function* () {
          yield source(event(1, AgentEventType.RunStarted));
          yield source({
            v: 1,
            runId: "run-1",
            seq: 2,
            type: AgentEventType.RunCompleted,
            data: { steps: 1, stopReason: "final", usage: { calls: 0, unmeasuredCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 } },
          });
        })(),
      };
    },
  };
  const registry = new RunRegistry({ runService: service });
  const seen: Array<{ state: string; status?: string }> = [];
  registry.onActivity((event) =>
    seen.push({ state: event.state, status: event.status })
  );
  registry.start({ conversationId: "c1", input: "hi" });
  // 等 pump 结束。
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const ended = seen.find((event) => event.state === "ended");
  assert.equal(ended?.status, "completed");
});
