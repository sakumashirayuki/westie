import assert from "node:assert/strict";
import { test } from "node:test";
import { callChatCompletions, runReview, validateReviewOutput } from "./review-client.mjs";

const DIFF_BUNDLE = {
  prNumber: 7,
  baseSha: "base-sha",
  headSha: "head-sha",
  mergeBase: "merge-base-sha",
  files: [{ path: "src/http/sse.ts", hunks: [{ addedLines: [13, 14] }], diffText: "..." }],
  coverageGaps: [],
};

const EVENT = {
  pull_request: { number: 7, title: "test pr", body: "desc", base: { sha: "base-sha" }, head: { sha: "head-sha" } },
};

function fakeFetch(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        async json() {
          return JSON.parse(response.body);
        },
        async text() {
          return response.body ?? "";
        },
      };
    },
  };
}

function modelResponse(payload) {
  return {
    status: 200,
    body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
  };
}

test("runReview 成功调用 Chat Completions 并返回校验后的结果", async () => {
  const payload = {
    summary: "发现 1 个已复核缺陷（P2: 1）",
    findings: [
      {
        severity: "P2",
        category: "functional",
        path: "src/http/sse.ts",
        line: 13,
        title: "重复设置响应头",
        evidence: "sseHeaders 已包含同名字段",
        suggestion: "删除新增的 setHeader",
      },
    ],
    coverageGaps: [],
  };
  const harness = fakeFetch([modelResponse(payload)]);

  const result = await runReview({
    event: EVENT,
    diffBundle: DIFF_BUNDLE,
    baseUrl: "https://api.deepseek.com",
    apiKey: "test-key",
    model: "deepseek-v4-flash",
    fetchImpl: harness.fetch,
  });

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].url, "https://api.deepseek.com/chat/completions");
  const requestBody = JSON.parse(harness.calls[0].options.body);
  assert.equal(requestBody.response_format.type, "json_object");
  assert.equal(requestBody.temperature, 0);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].line, 13);
});

test("callChatCompletions 对 5xx 重试后成功", async () => {
  const harness = fakeFetch([
    { status: 503, body: "service unavailable" },
    modelResponse({ summary: "无缺陷", findings: [], coverageGaps: [] }),
  ]);

  const content = await callChatCompletions({
    baseUrl: "https://api.deepseek.com",
    apiKey: "k",
    model: "m",
    messages: [],
    fetchImpl: harness.fetch,
  });

  assert.equal(harness.calls.length, 2);
  assert.match(content, /无缺陷/);
});

test("callChatCompletions 对 4xx 立即失败且不重试", async () => {
  const harness = fakeFetch([{ status: 401, body: "unauthorized" }]);
  await assert.rejects(
    callChatCompletions({
      baseUrl: "https://api.deepseek.com",
      apiKey: "bad",
      model: "m",
      messages: [],
      fetchImpl: harness.fetch,
    }),
    /4xx 不重试/,
  );
  assert.equal(harness.calls.length, 1);
});

test("validateReviewOutput 在 JSON 非法时失败", () => {
  assert.throws(() => validateReviewOutput("not json", DIFF_BUNDLE), /不是合法 JSON/);
});

test("validateReviewOutput 丢弃非法 finding 并合并缺口", () => {
  const raw = {
    summary: "混合结果",
    findings: [
      { severity: "P9", category: "functional", path: "src/http/sse.ts", title: "t", evidence: "e", suggestion: "s" },
      { severity: "P1", category: "security", path: "src/other.ts", title: "t", evidence: "e", suggestion: "s" },
      { severity: "P2", category: "functional", path: "src/http/sse.ts", line: 0, title: "t", evidence: "e", suggestion: "s" },
      { severity: "suggestion", category: "convention", path: "src/http/sse.ts", title: "t", evidence: "e", suggestion: "s" },
    ],
    coverageGaps: ["模型自述缺口"],
  };

  const result = validateReviewOutput(JSON.stringify(raw), DIFF_BUNDLE, 20);
  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0].line, undefined);
  assert.ok(result.coverageGaps.some((gap) => gap.includes("已丢弃")));
  assert.ok(result.coverageGaps.some((gap) => gap.includes("行号非法")));
  assert.ok(result.coverageGaps.includes("模型自述缺口"));
});

test("callChatCompletions 默认在请求体中关闭思考模式", async () => {
  const harness = fakeFetch([modelResponse({ summary: "ok", findings: [], coverageGaps: [] })]);
  await callChatCompletions({
    baseUrl: "https://api.deepseek.com",
    apiKey: "k",
    model: "m",
    messages: [],
    fetchImpl: harness.fetch,
  });
  assert.deepEqual(JSON.parse(harness.calls[0].options.body).thinking, { type: "disabled" });
});

test("callChatCompletions 在 disableThinking=false 时省略 thinking 字段", async () => {
  const harness = fakeFetch([modelResponse({ summary: "ok", findings: [], coverageGaps: [] })]);
  await callChatCompletions({
    baseUrl: "https://api.deepseek.com",
    apiKey: "k",
    model: "m",
    messages: [],
    fetchImpl: harness.fetch,
    disableThinking: false,
  });
  assert.equal("thinking" in JSON.parse(harness.calls[0].options.body), false);
});

test("callChatCompletions 在 finish_reason=length 且 content 为空时翻倍 token 预算重试", async () => {
  const harness = fakeFetch([
    {
      status: 200,
      body: JSON.stringify({
        choices: [{ finish_reason: "length", message: { content: null, reasoning_content: "x".repeat(8000) } }],
      }),
    },
    modelResponse({ summary: "重试成功", findings: [], coverageGaps: [] }),
  ]);

  const content = await callChatCompletions({
    baseUrl: "https://api.deepseek.com",
    apiKey: "k",
    model: "m",
    messages: [],
    fetchImpl: harness.fetch,
    maxTokens: 8000,
  });

  assert.equal(harness.calls.length, 2);
  assert.equal(JSON.parse(harness.calls[0].options.body).max_tokens, 8000);
  assert.equal(JSON.parse(harness.calls[1].options.body).max_tokens, 16000);
  assert.match(content, /重试成功/);
});

test("callChatCompletions 对非 length 的空 content 抛出带 finish_reason 的诊断错误", async () => {
  const harness = fakeFetch([
    {
      status: 200,
      body: JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "", reasoning_content: "推理完成但无结论" } }],
      }),
    },
  ]);

  await assert.rejects(
    callChatCompletions({
      baseUrl: "https://api.deepseek.com",
      apiKey: "k",
      model: "m",
      messages: [],
      fetchImpl: harness.fetch,
    }),
    /finish_reason=stop/,
  );
  assert.equal(harness.calls.length, 1);
});

test("validateReviewOutput 解包模型嵌套的一层 JSON 字符串", () => {
  const inner = {
    summary: "发现 1 个 P2",
    findings: [
      {
        severity: "P2",
        category: "functional",
        path: "src/http/sse.ts",
        line: 13,
        title: "重复响应头",
        evidence: "e",
        suggestion: "s",
      },
    ],
    coverageGaps: [],
  };
  const wrapped = JSON.stringify({ value: JSON.stringify(inner) });
  const result = validateReviewOutput(wrapped, DIFF_BUNDLE);
  assert.equal(result.summary, "发现 1 个 P2");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].path, "src/http/sse.ts");
});

test("validateReviewOutput 解包对象型包装字段", () => {
  const wrapped = {
    structured_output: {
      summary: "发现 1 个非阻塞建议",
      findings: [
        {
          severity: "suggestion",
          category: "maintainability",
          path: "src/http/sse.ts",
          line: 13,
          title: "重复 setHeader",
          evidence: "e",
          suggestion: "s",
        },
      ],
      coverageGaps: [],
    },
  };
  const result = validateReviewOutput(JSON.stringify(wrapped), DIFF_BUNDLE);
  assert.equal(result.summary, "发现 1 个非阻塞建议");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, "maintainability");
});

test("validateReviewOutput 接受带 json 代码围栏的输出", () => {
  const raw = "```json\n" + JSON.stringify({ summary: "无缺陷", findings: [], coverageGaps: [] }) + "\n```";
  const result = validateReviewOutput(raw, DIFF_BUNDLE);
  assert.equal(result.findings.length, 0);
  assert.equal(result.summary, "无缺陷");
});

test("validateReviewOutput 按上限截断 finding", () => {
  const raw = {
    summary: "过多",
    findings: Array.from({ length: 5 }, (_, index) => ({
      severity: "P2",
      category: "functional",
      path: "src/http/sse.ts",
      line: 13,
      title: `t${index}`,
      evidence: "e",
      suggestion: "s",
    })),
    coverageGaps: [],
  };

  const result = validateReviewOutput(JSON.stringify(raw), DIFF_BUNDLE, 3);
  assert.equal(result.findings.length, 3);
  assert.ok(result.coverageGaps.some((gap) => gap.includes("超过上限")));
});
