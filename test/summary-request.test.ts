import assert from "node:assert/strict";
import test from "node:test";

import {
  generateProviderSummary,
} from "../src/application/summary-request.js";
import type {
  LlmProvider,
  ProviderStreamEvent,
} from "../src/provider-protocol.js";
const MAX_SUMMARY_BYTES = 16 * 1024;

function provider(
  stream: () => AsyncIterable<ProviderStreamEvent>,
): LlmProvider {
  return {
    model: "test-model",
    contextWindowTokens: 100_000,
    maxOutputTokens: 8_192,
    async *stream() {
      yield* stream();
    },
  };
}

test("returns the trimmed final summary", async () => {
  const result = await generateProviderSummary({
    provider: provider(async function* () {
      yield { type: "output_text.delta", text: "  summary text  " };
      yield { type: "completed", turn: { type: "final", content: "  summary text  " } };
    }),
    systemPrompt: "system",
    source: "source",
    maxOutputTokens: 2_048,
    maxSummaryBytes: MAX_SUMMARY_BYTES,
  });
  assert.equal(result.summary, "summary text");
});

test("rejects non-final completion, tool argument deltas, empty, and oversized summaries", async (t) => {
  const cases: ReadonlyArray<
    readonly [string, () => AsyncIterable<ProviderStreamEvent>]
  > = [
    [
      "tool_calls completion",
      async function* () {
        yield {
          type: "completed",
          turn: {
            type: "tool_calls",
            calls: [{ callId: "x", name: "read", arguments: "{}" }],
          },
        };
      },
    ],
    [
      "tool_arguments.delta",
      async function* () {
        yield { type: "tool_arguments.delta", callIndex: 0, text: "{}" };
        yield { type: "completed", turn: { type: "final", content: "summary" } };
      },
    ],
    [
      "empty",
      async function* () {
        yield { type: "completed", turn: { type: "final", content: "   " } };
      },
    ],
    [
      "oversized",
      async function* () {
        yield {
          type: "completed",
          turn: {
            type: "final",
            content: "x".repeat(MAX_SUMMARY_BYTES + 1),
          },
        };
      },
    ],
  ];

  for (const [name, stream] of cases) {
    await t.test(name, async () => {
      await assert.rejects(generateProviderSummary({
        provider: provider(stream),
        systemPrompt: "system",
        source: "source",
        maxOutputTokens: 2_048,
        maxSummaryBytes: MAX_SUMMARY_BYTES,
      }));
    });
  }
});

test("rejects events emitted after completion", async () => {
  await assert.rejects(generateProviderSummary({
    provider: provider(async function* () {
      yield { type: "completed", turn: { type: "final", content: "summary" } };
      yield { type: "output_text.delta", text: "after" };
    }),
    systemPrompt: "system",
    source: "source",
    maxOutputTokens: 2_048,
    maxSummaryBytes: MAX_SUMMARY_BYTES,
  }), /after completion/);
});

test("throws the abort reason when the signal is already cancelled", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled");
  controller.abort(reason);
  await assert.rejects(generateProviderSummary({
    provider: provider(async function* () {
      yield { type: "output_text.delta", text: "x" };
      yield { type: "completed", turn: { type: "final", content: "summary" } };
    }),
    systemPrompt: "system",
    source: "source",
    maxOutputTokens: 2_048,
    maxSummaryBytes: MAX_SUMMARY_BYTES,
    signal: controller.signal,
  }), reason);
});

test("forgets tool arguments from an attempt that was retried", async () => {
  const result = await generateProviderSummary({
    provider: provider(async function* () {
      yield { type: "tool_arguments.delta", callIndex: 0, text: "{" };
      yield {
        type: "retrying",
        attempt: 2,
        maxAttempts: 5,
        delayMs: 1_000,
        reason: "connection",
      };
      yield { type: "output_text.delta", text: "summary" };
      yield { type: "completed", turn: { type: "final", content: "summary" } };
    }),
    systemPrompt: "Summarize.",
    source: "history",
    maxOutputTokens: 1_000,
    maxSummaryBytes: MAX_SUMMARY_BYTES,
  });
  assert.equal(result.summary, "summary");
});
