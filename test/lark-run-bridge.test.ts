import assert from "node:assert/strict";
import test from "node:test";

import { LarkRunBridge } from "../src/application/lark-run-bridge.js";
import type {
  RunActivityEvent,
  RunActivityState,
} from "../src/application/run-registry.js";
import type { OutboundSendRequest } from "../src/application/lark-outbound.js";

type ActivityListener = (event: RunActivityEvent) => void;

/**
 * 可控的事件流：next 保持挂起以模拟运行中的 Run，release 让迭代器结束，
 * 避免测试退出时留下悬挂 Promise。
 */
function createStreamStub(): {
  iterable: AsyncIterable<unknown>;
  release: () => void;
} {
  const waiters = new Set<(result: IteratorResult<unknown>) => void>();
  const finish = (): void => {
    for (const resolve of waiters) resolve({ value: undefined, done: true });
    waiters.clear();
  };
  const iterable: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<unknown>>((resolve) => {
            waiters.add(resolve);
          }),
        return: () => {
          finish();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
  return { iterable, release: finish };
}

function createRegistryStub(iterable: AsyncIterable<unknown>) {
  const listeners = new Set<ActivityListener>();
  const registry = {
    onActivity(listener: ActivityListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribe(): AsyncIterable<unknown> {
      return iterable;
    },
  };
  return { registry, listeners };
}

function createOutboundSpy(): {
  outbound: { enqueue(request: OutboundSendRequest): Promise<void> };
  sent: OutboundSendRequest[];
} {
  const sent: OutboundSendRequest[] = [];
  return {
    sent,
    outbound: {
      enqueue: async (request) => {
        sent.push(request);
      },
    },
  };
}

/** 等一个检查点，让泵的 finally 等微任务完成清理。 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("sends one awaiting reminder per awaiting_interaction edge", async () => {
  const stream = createStreamStub();
  const { registry, listeners } = createRegistryStub(stream.iterable);
  const { outbound, sent } = createOutboundSpy();
  const bridge = new LarkRunBridge({
    registry: registry as never,
    outbound: outbound as never,
  });
  bridge.register("run-1", "oc-1");
  const listener = [...listeners][0]!;
  const emit = (state: RunActivityState): void =>
    listener({ conversationId: "c1", runId: "run-1", state });

  emit("awaiting_interaction");
  emit("running");
  emit("awaiting_interaction");
  emit("waiting_sub_agents");
  emit("awaiting_interaction");

  const reminders = sent.filter((item) => item.uuid === "westie-await-run-1");
  assert.equal(reminders.length, 3);
  assert.deepEqual(
    reminders.map((item) => item.chatId),
    ["oc-1", "oc-1", "oc-1"],
  );
  await bridge.stop(50);
  stream.release();
  await flushMicrotasks();
});

test("does not duplicate the reminder while staying in the same state", async () => {
  const stream = createStreamStub();
  const { registry, listeners } = createRegistryStub(stream.iterable);
  const { outbound, sent } = createOutboundSpy();
  const bridge = new LarkRunBridge({
    registry: registry as never,
    outbound: outbound as never,
  });
  bridge.register("run-1", "oc-1");
  const listener = [...listeners][0]!;
  const emit = (state: RunActivityState): void =>
    listener({ conversationId: "c1", runId: "run-1", state });

  emit("awaiting_interaction");
  emit("awaiting_interaction");

  assert.equal(
    sent.filter((item) => item.uuid === "westie-await-run-1").length,
    1,
  );
  await bridge.stop(50);
  stream.release();
  await flushMicrotasks();
});

test("ignores activity events from runs it does not track", async () => {
  const stream = createStreamStub();
  const { registry, listeners } = createRegistryStub(stream.iterable);
  const { outbound, sent } = createOutboundSpy();
  const bridge = new LarkRunBridge({
    registry: registry as never,
    outbound: outbound as never,
  });
  bridge.register("run-1", "oc-1");
  const listener = [...listeners][0]!;
  listener({
    conversationId: "c-other",
    runId: "run-other",
    state: "awaiting_interaction",
  });
  assert.equal(sent.length, 0);
  await bridge.stop(50);
  stream.release();
  await flushMicrotasks();
});

test("stop resolves within the timeout even when a pump never settles", async () => {
  const stream = createStreamStub();
  const registry = {
    onActivity: (): (() => void) => () => {},
    subscribe: (): AsyncIterable<unknown> => stream.iterable,
  };
  const { outbound } = createOutboundSpy();
  const bridge = new LarkRunBridge({
    registry: registry as never,
    outbound: outbound as never,
  });
  bridge.register("run-stuck", "oc-1");

  const startedAt = Date.now();
  await bridge.stop(60);
  assert.ok(
    Date.now() - startedAt < 500,
    "stop should fall back to the timeout instead of waiting for the pump",
  );
  stream.release();
  await flushMicrotasks();
});
