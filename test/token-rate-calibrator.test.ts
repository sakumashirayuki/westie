import assert from "node:assert/strict";
import test from "node:test";

import { REQUEST_OVERHEAD_TOKENS } from "../src/application/context-budget.js";
import {
  MAX_BYTES_PER_TOKEN,
  MIN_BYTES_PER_TOKEN,
  MIN_SAMPLE_TOKENS,
  observeTokenRate,
  TOKEN_RATE_SMOOTHING,
  type TokenRateState,
} from "../src/application/token-rate-calibrator.js";

const initial: TokenRateState = { bytesPerToken: 2.5, observations: 0 };

test("adopts the first observation directly", () => {
  // 评测 k1-r0.01-b 第 10 步：64,093 字节，真实 19,861 token。
  const next = observeTokenRate(initial, {
    requestBytes: 64_093,
    inputTokens: 19_861,
  });

  const expected = 64_093 / (19_861 - REQUEST_OVERHEAD_TOKENS);
  assert.ok(Math.abs(next.bytesPerToken - expected) < 1e-9);
  assert.equal(next.observations, 1);
});

test("smooths later observations into the current rate", () => {
  const first = observeTokenRate(initial, {
    requestBytes: 12_000,
    inputTokens: 4_000 + REQUEST_OVERHEAD_TOKENS,
  });
  const second = observeTokenRate(first, {
    requestBytes: 20_000,
    inputTokens: 4_000 + REQUEST_OVERHEAD_TOKENS,
  });

  assert.equal(TOKEN_RATE_SMOOTHING, 0.5);
  assert.equal(second.bytesPerToken, 3 * 0.5 + 5 * 0.5);
  assert.equal(second.observations, 2);
});

test("clamps an observation to the supported range", () => {
  const low = observeTokenRate(initial, {
    requestBytes: 10,
    inputTokens: 4_000 + REQUEST_OVERHEAD_TOKENS,
  });
  const high = observeTokenRate(initial, {
    requestBytes: 1_000_000,
    inputTokens: 4_000 + REQUEST_OVERHEAD_TOKENS,
  });

  assert.equal(low.bytesPerToken, MIN_BYTES_PER_TOKEN);
  assert.equal(high.bytesPerToken, MAX_BYTES_PER_TOKEN);
});

test("ignores samples without usable tokens or bytes", () => {
  assert.equal(MIN_SAMPLE_TOKENS, 2 * REQUEST_OVERHEAD_TOKENS);
  const cases = [
    { requestBytes: 0, inputTokens: 5_000 },
    { requestBytes: 5_000, inputTokens: REQUEST_OVERHEAD_TOKENS },
    { requestBytes: 5_000, inputTokens: 0 },
    // 实测第 1 步：请求太小，固定开销的误差占主导。
    { requestBytes: 5_800, inputTokens: 1_726 },
    { requestBytes: 5_000, inputTokens: REQUEST_OVERHEAD_TOKENS + MIN_SAMPLE_TOKENS - 1 },
  ];
  for (const sample of cases) {
    assert.deepEqual(observeTokenRate(initial, sample), initial);
  }
});

test("returns a new state without mutating the input", () => {
  const before = { ...initial };
  const next = observeTokenRate(initial, {
    requestBytes: 16_000,
    inputTokens: 4_000 + REQUEST_OVERHEAD_TOKENS,
  });

  assert.notEqual(next, initial);
  assert.deepEqual(initial, before);
});
