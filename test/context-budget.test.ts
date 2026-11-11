import assert from "node:assert/strict";
import test from "node:test";

import {
  ContextBudget,
  DEFAULT_BYTES_PER_TOKEN,
} from "../src/application/context-budget.js";

// 实测基线：1M 窗口、32K 输出预留下的一次自举运行。
const MEASURED = {
  contextWindowTokens: 1_048_576,
  maxOutputTokens: 32_768,
  /** 上一轮 canonical transcript 的字节数。 */
  historyBytes: 1_011_587,
  /** 该 Run 真实占用的输入 token（同一步估算 588,416 字节对应 164,098 token）。 */
  realTokensAtStep345: 164_098,
  estimatedBytesAtStep345: 588_416,
};

test("derives the input limit from the window, output reserve and safety margin", () => {
  const budget = new ContextBudget({
    contextWindowTokens: MEASURED.contextWindowTokens,
    maxOutputTokens: MEASURED.maxOutputTokens,
  });

  const safetyMargin = Math.max(
    2_048,
    Math.ceil(MEASURED.contextWindowTokens * 0.05),
  );
  assert.equal(
    budget.inputTokenLimit,
    MEASURED.contextWindowTokens - MEASURED.maxOutputTokens - safetyMargin,
  );
  assert.equal(budget.triggerTokens, Math.floor(budget.inputTokenLimit * 0.8));
});

test("converts bytes to tokens with the configured divisor", () => {
  const budget = new ContextBudget({
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_192,
  });

  assert.equal(DEFAULT_BYTES_PER_TOKEN, 2.5);
  assert.equal(budget.tokensFromBytes(10_000), 4_000);
  assert.equal(budget.tokensFromBytes(1), 1);

  const explicit = new ContextBudget({
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_192,
    bytesPerToken: 4,
  });
  assert.equal(explicit.tokensFromBytes(10_000), 2_500);
});

test("rejects a non-positive bytesPerToken", () => {
  for (const bytesPerToken of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        new ContextBudget({
          contextWindowTokens: 128_000,
          maxOutputTokens: 8_192,
          bytesPerToken,
        }),
      /bytesPerToken must be a positive number/,
    );
  }
});

test("stays conservative against the measured bytes-per-token ratio", () => {
  const budget = new ContextBudget({
    contextWindowTokens: MEASURED.contextWindowTokens,
    maxOutputTokens: MEASURED.maxOutputTokens,
  });

  // 默认除数低于实测比值，因此估算值不低于真实 token 数。
  const measuredRatio = MEASURED.estimatedBytesAtStep345 /
    MEASURED.realTokensAtStep345;
  assert.ok(measuredRatio > DEFAULT_BYTES_PER_TOKEN);
  assert.ok(
    budget.tokensFromBytes(MEASURED.estimatedBytesAtStep345) >=
      MEASURED.realTokensAtStep345,
  );
});

test("derives the summary budget from the window instead of a fixed constant", () => {
  const production = new ContextBudget({
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 32_768,
  });
  const evaluation = new ContextBudget({
    contextWindowTokens: 131_072,
    maxOutputTokens: 8_192,
  });

  // 上限压回。
  assert.equal(production.inputTokenLimit, 963_379);
  assert.equal(production.summaryOutputTokens, 8_192);
  assert.equal(
    production.summaryMaxBytes,
    Math.ceil(8_192 * DEFAULT_BYTES_PER_TOKEN),
  );

  // 下限抬起。
  assert.equal(evaluation.inputTokenLimit, 116_326);
  assert.equal(evaluation.summaryOutputTokens, 4_096);

});

test("keeps the summary budget proportional between the clamps", () => {
  // 两个窗口都落在 clamp 不生效的区间里。
  const smaller = new ContextBudget({
    contextWindowTokens: 600_000,
    maxOutputTokens: 32_768,
  });
  const larger = new ContextBudget({
    contextWindowTokens: 800_000,
    maxOutputTokens: 32_768,
  });

  const smallerShare = smaller.summaryOutputTokens / smaller.inputTokenLimit;
  const largerShare = larger.summaryOutputTokens / larger.inputTokenLimit;
  assert.ok(Math.abs(smallerShare - largerShare) < 0.0001,
    `shares diverge: ${smallerShare} vs ${largerShare}`);
  assert.ok(larger.summaryOutputTokens > smaller.summaryOutputTokens);
});

test("clamps the summary output budget at both ends", () => {
  const tiny = new ContextBudget({
    contextWindowTokens: 16_384,
    maxOutputTokens: 2_048,
  });
  const huge = new ContextBudget({
    contextWindowTokens: 8_388_608,
    maxOutputTokens: 65_536,
  });

  assert.equal(tiny.summaryOutputTokens, 4_096);
  assert.equal(huge.summaryOutputTokens, 8_192);
});

test("rejects a summary budget ratio outside (0, 1]", () => {
  for (const summaryBudgetRatio of [0, -0.1, 1.5, Number.NaN]) {
    assert.throws(
      () =>
        new ContextBudget({
          contextWindowTokens: 1_048_576,
          maxOutputTokens: 32_768,
          summaryBudgetRatio,
        }),
      /summaryBudgetRatio must be a number in \(0, 1\]/,
    );
  }
});

test("derives a budget with a different bytes-per-token without touching the original", () => {
  const original = new ContextBudget({
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_192,
    bytesPerToken: 2.5,
  });

  const calibrated = original.withBytesPerToken(4);

  assert.notEqual(calibrated, original);
  assert.equal(original.bytesPerToken, 2.5);
  assert.equal(calibrated.bytesPerToken, 4);
  assert.equal(original.tokensFromBytes(10_000), 4_000);
  assert.equal(calibrated.tokensFromBytes(10_000), 2_500);
  // 不依赖系数的量保持不变。
  assert.equal(calibrated.inputTokenLimit, original.inputTokenLimit);
  assert.equal(calibrated.triggerTokens, original.triggerTokens);
  assert.equal(calibrated.summaryOutputTokens, original.summaryOutputTokens);
  // 摘要字节上限依赖系数，按新系数重算。
  assert.equal(
    calibrated.summaryMaxBytes,
    Math.ceil(calibrated.summaryOutputTokens * 4),
  );
});

test("rejects deriving a budget with a non-positive bytes-per-token", () => {
  const budget = new ContextBudget({
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_192,
  });
  for (const bytesPerToken of [0, -1, Number.NaN]) {
    assert.throws(() => budget.withBytesPerToken(bytesPerToken));
  }
});
