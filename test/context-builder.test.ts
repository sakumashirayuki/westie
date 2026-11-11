import assert from "node:assert/strict";
import test from "node:test";

import {
  ContextCompactionFailedError,
  ContextLimitExceededError,
  type LlmProvider,
} from "../src/agent-loop.js";
import { ContextBuilder } from "../src/application/context-builder.js";
import { RunUsageLog } from "../src/run-usage.js";
import { defineTool } from "../src/tools.js";
import {
  transcriptBytes,
  type TranscriptMessage,
} from "../src/transcript.js";
import { z } from "zod";
import { validSummary } from "./support/summary.js";

const message = (
  content: string,
  role: "user" | "assistant" = "user",
): TranscriptMessage => role === "user"
  ? { role: "user", content }
  : { role: "assistant", content };

function toolPair(callId: string, outputBytes: number): TranscriptMessage[] {
  return [
    {
      role: "assistant",
      content: null,
      toolCalls: [{ callId, name: "read", arguments: "{}" }],
    },
    {
      role: "tool",
      results: [{
        toolCallId: callId,
        result: {
        type: "tool_result",
        tool: "read",
        status: "success",
        output: "x".repeat(outputBytes),
        },
      }],
    },
  ];
}

function createProvider(options: {
  contextWindowTokens: number;
  maxOutputTokens: number;
}): LlmProvider {
  return {
    model: "test-model",
    contextWindowTokens: options.contextWindowTokens,
    maxOutputTokens: options.maxOutputTokens,
    async *stream() {
      throw new Error("stream must not be called by ContextBuilder");
    },
  };
}

function inputLimit(
  contextWindowTokens: number,
  maxOutputTokens: number,
): number {
  return (
    contextWindowTokens -
    maxOutputTokens -
    Math.max(2_048, Math.ceil(contextWindowTokens * 0.05))
  );
}

const TEST_SYSTEM_PROMPT = "Test system prompt.";

test("reports the request estimate with the step for usage reconciliation", async () => {
  const contextWindowTokens = 128 * 1_024;
  const maxOutputTokens = 4_096;
  const provider = createProvider({ contextWindowTokens, maxOutputTokens });
  const reports: Array<{
    runId?: string;
    step?: number;
    estimatedInputTokens: number;
    inputTokenLimit: number;
    triggerTokens: number;
    compactions: number;
  }> = [];
  const builder = new ContextBuilder({
    bytesPerToken: 1,
    provider,
    runId: "run-1",
    onRequestEstimate: (report) => reports.push({ ...report }),
  });

  const currentTranscript = [message("查一下 README")];
  await builder.buildContext({
    systemPrompt: TEST_SYSTEM_PROMPT,
    currentTranscript,
    tools: [],
    step: 7,
  });

  assert.equal(reports.length, 1);
  const report = reports[0]!;
  assert.equal(report.runId, "run-1");
  assert.equal(report.step, 7);
  assert.equal(report.compactions, 0);
  assert.equal(
    report.inputTokenLimit,
    inputLimit(contextWindowTokens, maxOutputTokens),
  );
  assert.equal(
    report.triggerTokens,
    Math.floor(report.inputTokenLimit * 0.8),
  );
  // 估算按 UTF-8 字节计，因此至少覆盖 system prompt 与当前 transcript 的字节数。
  assert.ok(
    report.estimatedInputTokens >=
      Buffer.byteLength(TEST_SYSTEM_PROMPT, "utf8") +
        transcriptBytes(currentTranscript),
  );
  assert.ok(report.estimatedInputTokens < report.triggerTokens);
});

test("returns the current transcript unchanged below the compaction trigger", async () => {
  const provider = createProvider({
    contextWindowTokens: 128 * 1_024,
    maxOutputTokens: 4_096,
  });
  const builder = new ContextBuilder({ bytesPerToken: 1, provider });
  const currentTranscript = [message("task")];
  assert.deepEqual(
    await builder.buildContext({
      systemPrompt: TEST_SYSTEM_PROMPT,
      currentTranscript,
      tools: [],
    }).then(({ transcript }) => transcript),
    currentTranscript,
  );
});

test("input estimation is conservative for Chinese input", async () => {
  const builder = new ContextBuilder({
    bytesPerToken: 1,
    provider: createProvider({
      contextWindowTokens: 10_000,
      maxOutputTokens: 1_000,
    }),
  });

  await assert.rejects(
    builder.buildContext({
      systemPrompt: TEST_SYSTEM_PROMPT,
      currentTranscript: [message("汉".repeat(1_975))],
      tools: [],
    }),
    ContextLimitExceededError,
  );
});

test("input estimation includes the complete system prompt", async () => {
  const builder = new ContextBuilder({
    bytesPerToken: 1,
    provider: createProvider({
      contextWindowTokens: 10_000,
      maxOutputTokens: 1_000,
    }),
  });

  await assert.rejects(
    builder.buildContext({
      systemPrompt: "x".repeat(6_000),
      currentTranscript: [message("current")],
      tools: [],
    }),
    ContextLimitExceededError,
  );
});

test("input estimation includes tool input JSON schemas", async () => {
  const schemaHeavyTool = defineTool({
    name: "schema_heavy",
    description: "Exercises schema accounting.",
    inputSchema: z.strictObject({
      payload: z.literal("x".repeat(6_000)),
    }),
    execute() {
      return {};
    },
  });
  const builder = new ContextBuilder({
    bytesPerToken: 1,
    provider: createProvider({
      contextWindowTokens: 10_000,
      maxOutputTokens: 1_000,
    }),
  });

  await assert.rejects(
    builder.buildContext({
      systemPrompt: TEST_SYSTEM_PROMPT,
      currentTranscript: [message("current")],
      tools: [schemaHeavyTool],
    }),
    ContextLimitExceededError,
  );
});

test("continues with the original context when summary generation fails below the hard limit", async () => {
  let summaryCalls = 0;
  const provider: LlmProvider = {
    model: "test-model",
    contextWindowTokens: 64_000,
    maxOutputTokens: 4_000,
    async *stream() {
      summaryCalls += 1;
      throw new Error("summary failed");
    },
  };
  const builder = new ContextBuilder({
    bytesPerToken: 1,
    provider,
  });
  const canonical = [
    message("task"),
    ...toolPair("old", 28_000),
    ...toolPair("latest", 18_000),
  ];

  assert.deepEqual((await builder.buildContext({
    systemPrompt: TEST_SYSTEM_PROMPT,
    currentTranscript: canonical,
    tools: [],
  })).transcript, canonical);
  assert.equal(summaryCalls, 1);
  assert.deepEqual(builder.compactions, []);
});

test("reports compaction failure when summary generation fails at the hard limit", async () => {
  const provider: LlmProvider = {
    model: "test-model",
    contextWindowTokens: 64_000,
    maxOutputTokens: 4_000,
    async *stream() {
      throw new Error("summary failed");
    },
  };
  const builder = new ContextBuilder({
    bytesPerToken: 1,
    provider,
  });

  await assert.rejects(builder.buildContext({
    systemPrompt: TEST_SYSTEM_PROMPT,
    currentTranscript: [
      message("task"),
      ...toolPair("old", 38_000),
      ...toolPair("latest", 20_000),
    ],
    tools: [],
  }), ContextCompactionFailedError);
  assert.deepEqual(builder.compactions, []);
});

function summaryProvider(
  summaries: string[],
  contextWindowTokens = 64_000,
): LlmProvider {
  const remaining = summaries.map(validSummary);
  return {
    model: "test-model",
    contextWindowTokens,
    maxOutputTokens: 1_000,
    async *stream(request) {
      const content = remaining.shift();
      if (content === undefined) throw new Error("No summary configured.");
      yield { type: "output_text.delta", text: content };
      yield { type: "completed", turn: { type: "final", content } };
    },
  };
}

test("records a context_compaction call when the run is compacted", async () => {
  const usageLog = new RunUsageLog();
  const provider = summaryProvider(["压缩后的摘要"]);
  const canonical = [
    message("task"),
    ...toolPair("old", 38_000),
    ...toolPair("latest", 20_000),
  ];
  const builder = new ContextBuilder({
    bytesPerToken: 1,
    provider,
    usageLog,
  });

  await builder.buildContext({
    systemPrompt: TEST_SYSTEM_PROMPT,
    currentTranscript: canonical,
    tools: [],
  });

  const calls = usageLog.calls.filter((c) => c.kind === "context_compaction");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].step, undefined);
});

test("keeps running uncompacted when the summary provider fails under the limit", async () => {
  const usageLog = new RunUsageLog();
  // 预算：window 64000 - output 1000 - margin 3200 = limit 59800，trigger 47840。
  // 这份 transcript 过了 trigger、没到 limit，压缩失败不该让整个请求失败。
  const canonical = [
    message("task"),
    ...toolPair("old", 38_000),
    ...toolPair("latest", 20_000),
  ];
  const builder = new ContextBuilder({
    bytesPerToken: 1,
    provider: {
      model: "test-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 1_000,
      async *stream() {
        throw new Error("summary failed");
      },
    },
    usageLog,
  });

  const { transcript } = await builder.buildContext({
    systemPrompt: TEST_SYSTEM_PROMPT,
    currentTranscript: canonical,
    tools: [],
  });

  assert.deepEqual(transcript, canonical);
  assert.deepEqual(usageLog.calls, []);
});

test("fails the request when compaction is forced and its provider fails", async () => {
  const usageLog = new RunUsageLog();
  // 这份 transcript 超过 limit 59800，压缩是强制的，失败必须上抛。
  const canonical = [
    message("task"),
    ...toolPair("old", 38_000),
    ...toolPair("latest", 38_000),
  ];
  const builder = new ContextBuilder({
    bytesPerToken: 1,
    provider: {
      model: "test-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 1_000,
      async *stream() {
        throw new Error("summary failed");
      },
    },
    usageLog,
  });

  await assert.rejects(builder.buildContext({
    systemPrompt: TEST_SYSTEM_PROMPT,
    currentTranscript: canonical,
    tools: [],
  }), ContextCompactionFailedError);
  assert.deepEqual(usageLog.calls, []);
});

test("starts from an initial adopted compaction and only compacts newer coverage", async () => {
  const usageLog = new RunUsageLog();
  const provider = summaryProvider(["new summary"]);
  const canonical = [
    message("task"),
    ...toolPair("old", 30_000),
    ...toolPair("middle", 30_000),
    ...toolPair("new", 20_000),
  ];
  const builder = new ContextBuilder({
    bytesPerToken: 1,
    provider,
    usageLog,
    initialCompactions: [{
      position: 0,
      coveredThroughSeq: 2,
      summary: "adopted summary",
      createdAt: "2026-08-12T00:00:00.000Z",
    }],
  });

  await builder.buildContext({
    systemPrompt: TEST_SYSTEM_PROMPT,
    currentTranscript: canonical,
    tools: [],
  });

  // 初始 adopted 覆盖 seq 2，新的压缩必须覆盖到 seq 2 之后。
  assert.equal(builder.compactions.length, 1);
  assert.ok(builder.compactions[0]!.coveredThroughSeq > 2);
  assert.match(
    builder.compactions[0]!.summary,
    /new summary/,
  );
});

test("aborts before calling the provider when already cancelled", async () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  controller.abort(reason);
  let streamCalls = 0;
  const builder = new ContextBuilder({
    bytesPerToken: 1,
    provider: {
      model: "test-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 1_000,
      async *stream() {
        streamCalls += 1;
        yield { type: "completed", turn: { type: "final", content: "s" } };
      },
    },
  });

  await assert.rejects(
    builder.buildContext({
      systemPrompt: TEST_SYSTEM_PROMPT,
      currentTranscript: [message("task")],
      tools: [],
      signal: controller.signal,
    }),
    reason,
  );
  assert.equal(streamCalls, 0);
});

test("reports a swallowed compaction failure on stderr", async () => {
  const written: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  const contextWindowTokens = 20_000;
  const maxOutputTokens = 2_000;
  // 摘要必失败，日志是唯一的痕迹。
  const provider: LlmProvider = {
    model: "test-model",
    contextWindowTokens,
    maxOutputTokens,
    async *stream() {
      throw new Error("summary provider exploded");
    },
  };
  const builder = new ContextBuilder({
    provider,
    bytesPerToken: 1,
    runId: "run-1",
  });
  // 越过触发线但不越过硬上限。
  const currentTranscript: TranscriptMessage[] = [
    message("task"),
    ...toolPair("call-a", 5_000),
    ...toolPair("call-b", 5_000),
    ...toolPair("call-c", 2_000),
  ];

  try {
    await builder.buildContext({
      systemPrompt: TEST_SYSTEM_PROMPT,
      currentTranscript,
      tools: [],
    });
  } finally {
    (process.stderr as { write: unknown }).write = originalWrite;
  }

  const report = written
    .map((line) => line.trim())
    .find((line) => line.includes("context.compaction_failed"));
  assert.ok(report, `no compaction failure reported: ${written.join("")}`);
  const parsed = JSON.parse(report) as { runId?: string; reason?: string };
  assert.equal(parsed.runId, "run-1");
  assert.match(parsed.reason ?? "", /summary provider exploded/);
});

test("recalibrates the estimate from the observed usage of the previous step", async () => {
  const provider = createProvider({
    contextWindowTokens: 128 * 1_024,
    maxOutputTokens: 4_096,
  });
  const reports: Array<{ estimatedInputTokens: number; bytesPerToken: number }> =
    [];
  const builder = new ContextBuilder({
    bytesPerToken: 2.5,
    provider,
    onRequestEstimate: (report) => reports.push({
      estimatedInputTokens: report.estimatedInputTokens,
      bytesPerToken: report.bytesPerToken,
    }),
  });
  const request = {
    systemPrompt: TEST_SYSTEM_PROMPT,
    currentTranscript: [message("x".repeat(40_000))],
    tools: [],
  };

  await builder.buildContext({ ...request, step: 1 });
  const before = reports[0]!;
  assert.equal(before.bytesPerToken, 2.5);

  // 真实 token 是估算的一半：观测到的系数应为 5。
  const requestBytes = (before.estimatedInputTokens - 1_024) * 2.5;
  builder.observeUsage({
    step: 1,
    usage: {
      model: "test-model",
      inputTokens: 1_024 + Math.round(requestBytes / 5),
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
    },
  });
  await builder.buildContext({ ...request, step: 2 });

  const after = reports[1]!;
  assert.ok(Math.abs(after.bytesPerToken - 5) < 0.01, `got ${after.bytesPerToken}`);
  assert.ok(after.estimatedInputTokens < before.estimatedInputTokens);
  assert.ok(
    Math.abs(after.estimatedInputTokens - (1_024 + requestBytes / 5)) <= 2,
  );
});

test("ignores usage whose step does not match the last built request", async () => {
  const provider = createProvider({
    contextWindowTokens: 128 * 1_024,
    maxOutputTokens: 4_096,
  });
  const reports: number[] = [];
  const builder = new ContextBuilder({
    bytesPerToken: 2.5,
    provider,
    onRequestEstimate: (report) => reports.push(report.bytesPerToken),
  });
  const request = {
    systemPrompt: TEST_SYSTEM_PROMPT,
    currentTranscript: [message("x".repeat(40_000))],
    tools: [],
  };

  await builder.buildContext({ ...request, step: 1 });
  builder.observeUsage({
    step: 7,
    usage: {
      model: "test-model",
      inputTokens: 100_000,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
    },
  });
  await builder.buildContext({ ...request, step: 2 });

  assert.deepEqual(reports, [2.5, 2.5]);
});

test("stops compacting once the calibrated estimate falls below the trigger", async () => {
  let summaryCalls = 0;
  const provider: LlmProvider = {
    model: "test-model",
    contextWindowTokens: 64_000,
    maxOutputTokens: 4_000,
    async *stream() {
      summaryCalls += 1;
      throw new Error("summary failed");
    },
  };
  const builder = new ContextBuilder({ bytesPerToken: 1, provider });
  const canonical = [
    message("task"),
    ...toolPair("old", 28_000),
    ...toolPair("latest", 18_000),
  ];
  const request = {
    systemPrompt: TEST_SYSTEM_PROMPT,
    currentTranscript: canonical,
    tools: [],
  };

  // 系数 1 时越过触发线，尝试压缩（失败后原样继续）。
  await builder.buildContext({ ...request, step: 1 });
  assert.equal(summaryCalls, 1);

  // 真实 token 只有字节数的三分之一：系数校准到 3 后不再越线。
  builder.observeUsage({
    step: 1,
    usage: {
      model: "test-model",
      inputTokens: 1_024 + Math.ceil(transcriptBytes(canonical) / 3),
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
    },
  });
  await builder.buildContext({ ...request, step: 2 });
  assert.equal(summaryCalls, 1);
});

// 保底预算里的「当前用户输入」应是当前未结束 Turn 的 user 消息，而不是会话第一条。
function finishedTurn(
  opening: string,
  pairId: string,
  outputBytes: number,
): TranscriptMessage[] {
  return [
    message(opening),
    ...toolPair(pairId, outputBytes),
    { role: "assistant", content: "done" },
  ];
}

test("protected floor counts the open turn's user messages, not the first", async () => {
  const provider = createProvider({
    contextWindowTokens: 128 * 1_024,
    maxOutputTokens: 4_096,
  });
  const builder = new ContextBuilder({ bytesPerToken: 1, provider });
  // 第一条消息很大（已结束的 Turn），当前未结束 Turn 的消息很小。
  const canonical: TranscriptMessage[] = [
    message("x".repeat(60_000)),
    ...toolPair("old", 1_000),
    { role: "assistant", content: "done" },
    message("small current task"),
  ];
  // 正确实现下：当前 Turn 只算「small current task」，不把 60_000 字节算进保底，
  // 因而能压缩成功，不报 ContextLimitExceededError。
  const result = await builder.buildContext({
    systemPrompt: TEST_SYSTEM_PROMPT,
    currentTranscript: canonical,
    tools: [],
  });
  assert.ok(result.transcript.length > 0);
});

test("protected floor overflows and reports open turn user messages", async () => {
  const provider = createProvider({
    contextWindowTokens: 10_000,
    maxOutputTokens: 1_000,
  });
  const builder = new ContextBuilder({ bytesPerToken: 1, provider });
  // 当前未结束 Turn 的消息本身大到无法压缩。
  const canonical: TranscriptMessage[] = [
    message("small first task"),
    ...toolPair("old", 1_000),
    { role: "assistant", content: "done" },
    message("x".repeat(8_000)),
  ];
  await assert.rejects(
    builder.buildContext({
      systemPrompt: TEST_SYSTEM_PROMPT,
      currentTranscript: canonical,
      tools: [],
    }),
    (error: unknown) => {
      assert.ok(error instanceof ContextLimitExceededError);
      assert.match(error.message, /open turn user messages/);
      return true;
    },
  );
});
