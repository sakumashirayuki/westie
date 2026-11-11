import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderOutputError,
  ProviderTransientError,
  ProviderUnavailableError,
  type LlmProvider,
  type ProviderRequest,
  type ProviderStreamEvent,
} from "../src/provider-protocol.js";
import {
  DEFAULT_RETRY_POLICY,
  RetryingProvider,
} from "../src/providers/retrying-provider.js";

const request: ProviderRequest = {
  systemPrompt: "system",
  transcript: [{ role: "user", content: "hi" }],
  tools: [],
};

function makeInner(
  attempts: ReadonlyArray<
    () => AsyncIterable<ProviderStreamEvent>
  >,
): LlmProvider & { callCount: number } {
  const inner = {
    model: "test-model",
    callCount: 0,
    stream(): AsyncIterable<ProviderStreamEvent> {
      const fn = attempts[Math.min(inner.callCount, attempts.length - 1)];
      inner.callCount += 1;
      return fn();
    },
  };
  return inner;
}

function noopSleep(): Promise<void> {
  return Promise.resolve();
}

async function collect(stream: AsyncIterable<ProviderStreamEvent>) {
  const out: ProviderStreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

test("retries a transient failure once then succeeds", async () => {
  const inner = makeInner([
    async function* () {
      throw new ProviderTransientError("server_error", "boom");
    },
    async function* () {
      yield { type: "output_text.delta", text: "hello" };
      yield { type: "completed", turn: { type: "final", content: "hello" } };
    },
  ]);
  const provider = new RetryingProvider(inner, DEFAULT_RETRY_POLICY, {
    sleep: noopSleep,
    random: () => 0.5,
  });

  const events = await collect(provider.stream(request));
  assert.equal(inner.callCount, 2);
  assert.deepEqual(events, [
    { type: "retrying", attempt: 2, maxAttempts: 5, delayMs: 500, reason: "server_error" },
    { type: "output_text.delta", text: "hello" },
    { type: "completed", turn: { type: "final", content: "hello" } },
  ]);
});

test("emits retrying after partial deltas and restarts output", async () => {
  const inner = makeInner([
    async function* () {
      yield { type: "output_text.delta", text: "part" };
      yield { type: "output_text.delta", text: "ial" };
      throw new ProviderTransientError("connection", "dropped");
    },
    async function* () {
      yield { type: "output_text.delta", text: "full" };
      yield { type: "completed", turn: { type: "final", content: "full" } };
    },
  ]);
  const provider = new RetryingProvider(inner, DEFAULT_RETRY_POLICY, {
    sleep: noopSleep,
    random: () => 0,
  });

  const events = await collect(provider.stream(request));
  assert.deepEqual(
    events.map((e) => e.type),
    ["output_text.delta", "output_text.delta", "retrying", "output_text.delta", "completed"],
  );
  assert.equal(inner.callCount, 2);
});

test("does not retry non-transient errors", async () => {
  const inner = makeInner([
    async function* () {
      throw new ProviderOutputError("bad output");
    },
  ]);
  const provider = new RetryingProvider(inner, DEFAULT_RETRY_POLICY, {
    sleep: noopSleep,
    random: () => 0,
  });
  await assert.rejects(
    collect(provider.stream(request)),
    ProviderOutputError,
  );
  assert.equal(inner.callCount, 1);
});

test("does not retry a generic Error", async () => {
  const inner = makeInner([
    async function* () {
      throw new Error("boom");
    },
  ]);
  const provider = new RetryingProvider(inner, DEFAULT_RETRY_POLICY, {
    sleep: noopSleep,
    random: () => 0,
  });
  await assert.rejects(collect(provider.stream(request)), /boom/);
  assert.equal(inner.callCount, 1);
});

test("throws ProviderUnavailableError with attempts when retries are exhausted", async () => {
  const inner = makeInner([
    async function* () {
      throw new ProviderTransientError("overloaded", "still busy");
    },
    async function* () {
      throw new ProviderTransientError("overloaded", "still busy");
    },
    async function* () {
      throw new ProviderTransientError("overloaded", "still busy");
    },
    async function* () {
      throw new ProviderTransientError("overloaded", "still busy");
    },
    async function* () {
      throw new ProviderTransientError("overloaded", "still busy");
    },
  ]);
  const provider = new RetryingProvider(inner, DEFAULT_RETRY_POLICY, {
    sleep: noopSleep,
    random: () => 0,
  });

  await assert.rejects(
    collect(provider.stream(request)),
    (error: unknown) => {
      assert.ok(error instanceof ProviderUnavailableError);
      assert.equal(error.attempts, 5);
      assert.equal(error.reason, "overloaded");
      assert.ok(error.cause instanceof ProviderTransientError);
      return true;
    },
  );
  assert.equal(inner.callCount, 5);
});

test("honors retryAfterMs floor and over-limit failure", async () => {
  const floorInner = makeInner([
    async function* () {
      throw new ProviderTransientError("rate_limited", "slow", {
        retryAfterMs: 5000,
      });
    },
    async function* () {
      yield { type: "completed", turn: { type: "final", content: "ok" } };
    },
  ]);
  const floor = new RetryingProvider(floorInner, DEFAULT_RETRY_POLICY, {
    sleep: noopSleep,
    random: () => 0,
  });
  const events = await collect(floor.stream(request));
  const retrying = events.find((e) => e.type === "retrying");
  assert.equal(retrying?.type === "retrying" ? retrying.delayMs : -1, 5000);

  const over = makeInner([
    async function* () {
      throw new ProviderTransientError("rate_limited", "slow", {
        retryAfterMs: 90_000,
      });
    },
  ]);
  const overProvider = new RetryingProvider(over, DEFAULT_RETRY_POLICY, {
    sleep: noopSleep,
    random: () => 0,
  });
  await assert.rejects(
    collect(overProvider.stream(request)),
    ProviderUnavailableError,
  );
  assert.equal(over.callCount, 1);
});

test("fails early when cumulative delay exceeds maxTotalDelayMs", async () => {
  const inner = makeInner([
    async function* () {
      throw new ProviderTransientError("server_error", "boom", {
        retryAfterMs: 50_000,
      });
    },
    async function* () {
      throw new ProviderTransientError("server_error", "boom", {
        retryAfterMs: 50_000,
      });
    },
    async function* () {
      throw new ProviderTransientError("server_error", "boom", {
        retryAfterMs: 50_000,
      });
    },
  ]);
  const provider = new RetryingProvider(inner, DEFAULT_RETRY_POLICY, {
    sleep: noopSleep,
    random: () => 0,
  });
  await assert.rejects(collect(provider.stream(request)), ProviderUnavailableError);
  // 前两次各等 50s，累计 100s；第三次再等 50s 会超过 120s 上限，因此在第 3 次失败后
  // 就放弃，不会用满 5 次。累计恰好等于上限时仍允许重试（方案规定「超过」才失败）。
  assert.equal(inner.callCount, 3);
});

test("aborts during sleep and does not retry", async () => {
  const controller = new AbortController();
  const reason = new Error("user cancelled");
  let slept = false;
  const inner = makeInner([
    async function* () {
      throw new ProviderTransientError("server_error", "boom");
    },
    async function* () {
      yield { type: "completed", turn: { type: "final", content: "ok" } };
    },
  ]);
  const provider = new RetryingProvider(inner, DEFAULT_RETRY_POLICY, {
    random: () => 0,
    async sleep(_delay, signal) {
      slept = true;
      controller.abort(reason);
      signal?.throwIfAborted();
    },
  });
  await assert.rejects(collect(provider.stream({
    ...request,
    signal: controller.signal,
  })), reason);
  assert.equal(slept, true);
  assert.equal(inner.callCount, 1);
});

test("full jitter: with random=0.5 the 3rd retry delay is 0.5 * 4000", async () => {
  const delays: number[] = [];
  const inner = makeInner([
    async function* () {
      throw new ProviderTransientError("server_error", "boom");
    },
    async function* () {
      throw new ProviderTransientError("server_error", "boom");
    },
    async function* () {
      throw new ProviderTransientError("server_error", "boom");
    },
    async function* () {
      yield { type: "completed", turn: { type: "final", content: "ok" } };
    },
  ]);
  const provider = new RetryingProvider(inner, DEFAULT_RETRY_POLICY, {
    random: () => 0.5,
    async sleep(delay) {
      delays.push(delay);
    },
  });
  await collect(provider.stream(request));
  // 第 1 次重试：base × 2^0 = 1000 → 500；第 2 次：2000 → 1000；第 3 次：4000 → 2000。
  assert.deepEqual(delays, [500, 1000, 2000]);
});

test("returns immediately on success without retrying", async () => {
  const inner = makeInner([
    async function* () {
      yield { type: "output_text.delta", text: "ok" };
      yield { type: "completed", turn: { type: "final", content: "ok" } };
    },
  ]);
  const provider = new RetryingProvider(inner, DEFAULT_RETRY_POLICY, {
    sleep: noopSleep,
    random: () => 0,
  });
  const events = await collect(provider.stream(request));
  assert.equal(inner.callCount, 1);
  assert.equal(events.length, 2);
});

test("passes through model metadata", () => {
  const inner = {
    model: "m",
    contextWindowTokens: 123,
    maxOutputTokens: 456,
    stream: async function* () {},
  } as LlmProvider;
  const provider = new RetryingProvider(inner);
  assert.equal(provider.model, "m");
  assert.equal(provider.contextWindowTokens, 123);
  assert.equal(provider.maxOutputTokens, 456);
});
