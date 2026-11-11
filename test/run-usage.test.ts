import assert from "node:assert/strict";
import test from "node:test";

import { RunUsageLog } from "../src/run-usage.js";
import type { ProviderUsage } from "../src/provider-protocol.js";

function usage(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    model: "test-model",
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 20,
    reasoningTokens: 5,
    ...overrides,
  };
}

test("allocates contiguous seq values from zero in record order", () => {
  const log = new RunUsageLog();
  log.record({ kind: "step", step: 1, model: "a", usage: usage() });
  log.record({ kind: "context_compaction", model: "b", usage: usage() });
  log.record({ kind: "history_summary", model: "c" });

  assert.deepEqual(log.calls.map((call) => call.seq), [0, 1, 2]);
  assert.equal(log.calls[0].kind, "step");
  assert.equal(log.calls[0].step, 1);
  assert.equal(log.calls[1].kind, "context_compaction");
  assert.equal(log.calls[1].step, undefined);
  assert.equal(log.calls[2].kind, "history_summary");
});

test("marks every call with an ISO timestamp", () => {
  const log = new RunUsageLog();
  log.record({ kind: "step", step: 1, model: "a", usage: usage() });

  assert.match(
    log.calls[0].createdAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  );
});

test("totals sum only measured calls and count unmeasured calls", () => {
  const log = new RunUsageLog();
  log.record({
    kind: "step",
    step: 1,
    model: "a",
    usage: usage({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningTokens: 5 }),
  });
  log.record({ kind: "context_compaction", model: "b" });
  log.record({
    kind: "step",
    step: 2,
    model: "c",
    usage: usage({ inputTokens: 200, cachedInputTokens: 80, outputTokens: 30, reasoningTokens: 10 }),
  });

  assert.deepEqual(log.totals, {
    calls: 3,
    unmeasuredCalls: 1,
    inputTokens: 300,
    cachedInputTokens: 120,
    outputTokens: 50,
    reasoningTokens: 15,
  });
});

test("totals are all zero for a log with no calls", () => {
  assert.deepEqual(new RunUsageLog().totals, {
    calls: 0,
    unmeasuredCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  });
});

test("totals count unmeasuredCalls when none are measured", () => {
  const log = new RunUsageLog();
  log.record({ kind: "history_summary", model: "a" });
  assert.deepEqual(log.totals, {
    calls: 1,
    unmeasuredCalls: 1,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  });
});

test("drops an invalid usage to unmeasured and reports through onInvalid", () => {
  const invalid: Array<Record<string, unknown>> = [];
  const log = new RunUsageLog({
    onInvalid: (call) => invalid.push(call.usage as unknown as Record<string, unknown>),
  });
  log.record({
    kind: "step",
    step: 1,
    model: "a",
    usage: usage({ cachedInputTokens: 999 }),
  });
  assert.deepEqual(log.totals, {
    calls: 1,
    unmeasuredCalls: 1,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  });
  assert.equal(log.calls[0].usage, undefined);
  assert.equal(invalid.length, 1);
});

test("rejects a step call without a step number", () => {
  const log = new RunUsageLog();
  assert.throws(
    () => log.record({ kind: "step", model: "a", usage: usage() }),
    /step number/,
  );
});

test("rejects a step call with a non-positive step number", () => {
  const log = new RunUsageLog();
  assert.throws(
    () => log.record({ kind: "step", step: 0, model: "a", usage: usage() }),
    /step number/,
  );
  assert.throws(
    () => log.record({ kind: "step", step: 1.5, model: "a", usage: usage() }),
    /step number/,
  );
});

test("rejects a non-step call that carries a step number", () => {
  const log = new RunUsageLog();
  assert.throws(
    () =>
      log.record({ kind: "context_compaction", step: 1, model: "a", usage: usage() }),
    /must not include a step/,
  );
  assert.throws(
    () => log.record({ kind: "history_summary", step: 2, model: "a" }),
    /must not include a step/,
  );
});

test("rejects an empty model name", () => {
  const log = new RunUsageLog();
  assert.throws(
    () => log.record({ kind: "step", step: 1, model: "   ", usage: usage() }),
    /non-empty model/,
  );
});

test("calls are returned defensively as copies", () => {
  const log = new RunUsageLog();
  log.record({ kind: "step", step: 1, model: "a", usage: usage() });
  const first = log.calls;
  const second = log.calls;
  assert.notEqual(first, second);
  assert.deepEqual(first, second);
});

test("records sub_agent calls with the child run id and counts them in totals", () => {
  const log = new RunUsageLog();
  log.record({ kind: "step", step: 1, model: "a", usage: usage() });
  log.record({
    kind: "sub_agent",
    subAgentRunId: "child-1",
    model: "child",
    usage: usage({ inputTokens: 50 }),
  });

  assert.equal(log.calls[1].kind, "sub_agent");
  assert.equal(log.calls[1].step, undefined);
  assert.equal(log.calls[1].subAgentRunId, "child-1");
  assert.equal(log.calls[0].subAgentRunId, undefined);
  assert.equal(log.totals.calls, 2);
  assert.equal(log.totals.inputTokens, 150);
});

test("binds the sub agent run id to the sub_agent kind", () => {
  const log = new RunUsageLog();
  assert.throws(() =>
    log.record({ kind: "sub_agent", model: "child", usage: usage() })
  );
  assert.throws(() =>
    log.record({ kind: "sub_agent", subAgentRunId: "c", step: 3, model: "child" })
  );
  assert.throws(() =>
    log.record({ kind: "step", step: 1, subAgentRunId: "c", model: "a" })
  );
});
