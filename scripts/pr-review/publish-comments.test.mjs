import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDiff } from "./collect-diff.mjs";
import {
  buildMarker,
  buildReviewBody,
  DEFAULT_MAX_INLINE_COMMENTS,
  deleteBotReviewComments,
  findLatestBotReview,
  isLineInDiff,
  listBotReviewCommentIds,
  publishReview,
  splitFindings,
} from "./publish-comments.mjs";

const DIFF_TEXT = `diff --git a/src/http/sse.ts b/src/http/sse.ts
index 1111111..2222222 100644
--- a/src/http/sse.ts
+++ b/src/http/sse.ts
@@ -12,0 +13,2 @@
+export function keepAlive() {
+  return true;
`;

function buildBundle() {
  const parsed = parseDiff(DIFF_TEXT);
  return {
    prNumber: 7,
    baseSha: "base-sha",
    headSha: "head-sha",
    mergeBase: "merge-base-sha",
    files: parsed.files,
    coverageGaps: [],
    totalBytes: parsed.totalBytes,
  };
}

const CONTEXT_DIFF_TEXT = `diff --git a/src/http/sse.ts b/src/http/sse.ts
index 1111111..2222222 100644
--- a/src/http/sse.ts
+++ b/src/http/sse.ts
@@ -10,5 +10,6 @@
 function keepAlive() {
   const timer = 1;
+  const extra = 2;
   return timer;
 }
`;

function buildContextBundle() {
  const parsed = parseDiff(CONTEXT_DIFF_TEXT);
  return {
    prNumber: 7,
    baseSha: "base-sha",
    headSha: "head-sha",
    mergeBase: "merge-base-sha",
    files: parsed.files,
    coverageGaps: [],
    totalBytes: parsed.totalBytes,
  };
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function githubFake({ reviews = [], prComments = [] }) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === "GET" && url.includes("/reviews")) {
      return jsonResponse(reviews);
    }
    if (options.method === "GET" && url.includes("/comments")) {
      return jsonResponse(prComments);
    }
    if (options.method === "DELETE") {
      return { ok: true, status: 204, async text() { return ""; } };
    }
    return jsonResponse({ id: 999 });
  };
  return { calls, fetch };
}

const ONE_INLINE_RESULT = {
  summary: "发现 1 个已复核缺陷（P1: 1）",
  coverageGaps: [],
  findings: [
    { severity: "P1", category: "functional", path: "src/http/sse.ts", line: 13, title: "a", evidence: "e", suggestion: "s" },
  ],
};

test("isLineInDiff 只接受 hunk 中的新增行", () => {
  const bundle = buildBundle();
  const file = bundle.files[0];
  assert.equal(isLineInDiff(file, 13), true);
  assert.equal(isLineInDiff(file, 14), true);
  assert.equal(isLineInDiff(file, 12), false);
  assert.equal(isLineInDiff(file, 99), false);
});

test("isLineInDiff 接受 hunk 内的上下文行", () => {
  const bundle = buildContextBundle();
  const file = bundle.files[0];
  assert.equal(isLineInDiff(file, 12), true);
  assert.equal(isLineInDiff(file, 11), true);
  assert.equal(isLineInDiff(file, 13), true);
  assert.equal(isLineInDiff(file, 9), false);
});

test("splitFindings 可把 finding 落到 hunk 内的上下文行", () => {
  const bundle = buildContextBundle();
  const result = {
    summary: "1 条",
    coverageGaps: [],
    findings: [
      { severity: "P1", category: "functional", path: "src/http/sse.ts", line: 11, title: "a", evidence: "e", suggestion: "s" },
      { severity: "P2", category: "functional", path: "src/http/sse.ts", line: 9, title: "b", evidence: "e", suggestion: "s" },
    ],
  };

  const { inlineComments, summaryOnlyFindings } = splitFindings(result, bundle);
  assert.equal(inlineComments.length, 1);
  assert.equal(inlineComments[0].line, 11);
  assert.equal(summaryOnlyFindings.length, 1);
  assert.equal(summaryOnlyFindings[0].title, "b");
});

test("splitFindings 区分行内评论与汇总条目", () => {
  const bundle = buildBundle();
  const result = {
    summary: "3 条",
    coverageGaps: [],
    findings: [
      { severity: "P1", category: "functional", path: "src/http/sse.ts", line: 13, title: "a", evidence: "e", suggestion: "s" },
      { severity: "P2", category: "functional", path: "src/http/sse.ts", line: 99, title: "b", evidence: "e", suggestion: "s" },
      { severity: "suggestion", category: "convention", path: "src/http/sse.ts", title: "c", evidence: "e", suggestion: "s" },
    ],
  };

  const { inlineComments, summaryOnlyFindings } = splitFindings(result, bundle);
  assert.equal(inlineComments.length, 1);
  assert.equal(inlineComments[0].line, 13);
  assert.equal(inlineComments[0].side, "RIGHT");
  assert.equal(summaryOnlyFindings.length, 2);
});

test("splitFindings 对已截断文件的 finding 只进汇总", () => {
  const bundle = buildBundle();
  bundle.files[0].truncated = true;
  const result = {
    summary: "1 条",
    coverageGaps: [],
    findings: [
      { severity: "P1", category: "functional", path: "src/http/sse.ts", line: 13, title: "a", evidence: "e", suggestion: "s" },
    ],
  };

  const { inlineComments, summaryOnlyFindings } = splitFindings(result, bundle);
  assert.equal(inlineComments.length, 0);
  assert.equal(summaryOnlyFindings.length, 1);
  assert.equal(summaryOnlyFindings[0].title, "a");
});

test("splitFindings 行内评论达到上限后其余 finding 转入汇总", () => {
  const bundle = buildBundle();
  const findings = Array.from({ length: DEFAULT_MAX_INLINE_COMMENTS + 2 }, (_, index) => ({
    severity: "P2",
    category: "functional",
    path: "src/http/sse.ts",
    line: 13,
    title: `f${index}`,
    evidence: "e",
    suggestion: "s",
  }));

  const { inlineComments, summaryOnlyFindings } = splitFindings(
    { summary: "s", coverageGaps: [], findings },
    bundle,
  );
  assert.equal(inlineComments.length, DEFAULT_MAX_INLINE_COMMENTS);
  assert.equal(summaryOnlyFindings.length, 2);
});

test("buildReviewBody 含统计、缺口和提交标记", () => {
  const body = buildReviewBody({
    result: {
      summary: "发现 1 个 P1",
      coverageGaps: ["缺口 A"],
      findings: [{ severity: "P1", category: "functional", path: "x.ts", title: "t", evidence: "e", suggestion: "s" }],
    },
    summaryOnlyFindings: [],
    headSha: "head-sha",
    baseSha: "base-sha",
  });

  assert.match(body, /P0 0，P1 1/);
  assert.match(body, /缺口 A/);
  assert.ok(body.includes(buildMarker("head-sha", "base-sha")));
});

test("buildReviewBody 在行内评论溢出时提示转汇总的条数", () => {
  const body = buildReviewBody({
    result: {
      summary: "发现 2 个 P2",
      coverageGaps: [],
      findings: [
        { severity: "P2", category: "functional", path: "x.ts", line: 1, title: "t", evidence: "e", suggestion: "s" },
      ],
    },
    summaryOnlyFindings: [
      { severity: "P2", category: "functional", path: "x.ts", line: 1, title: "t", evidence: "e", suggestion: "s" },
    ],
    inlineOverflowCount: 2,
    headSha: "head-sha",
    baseSha: "base-sha",
  });

  assert.match(body, /行内评论达到上限/);
  assert.match(body, /另有 2 条/);
  assert.match(body, /仅汇总条目/);
});

test("findLatestBotReview 只匹配机器人账号的带标记 review 并取最后一条", () => {
  const reviews = [
    { id: 1, user: { login: "human" }, body: buildMarker("h", "b") },
    { id: 2, user: { login: "github-actions[bot]" }, body: "机器人发布但不含标记" },
    { id: 3, user: { login: "github-actions[bot]" }, body: `${buildMarker("h1", "b")} 旧结论` },
    { id: 4, user: { login: "github-actions[bot]" }, body: `${buildMarker("h2", "b")} 新结论` },
    { id: 5, user: { login: "other-bot" }, body: buildMarker("h", "b") },
  ];

  assert.equal(findLatestBotReview(reviews).id, 4);
  assert.equal(findLatestBotReview([reviews[0]]), null);
});

test("publishReview 首次运行创建带行内评论的 COMMENT review", async () => {
  const bundle = buildBundle();
  const harness = githubFake({
    reviews: [{ id: 100, user: { login: "human" }, body: "人工评审" }],
  });

  const outcome = await publishReview({
    token: "token",
    owner: "o",
    repo: "r",
    prNumber: 7,
    headSha: "head-sha",
    baseSha: "base-sha",
    result: ONE_INLINE_RESULT,
    diffBundle: bundle,
    fetchImpl: harness.fetch,
  });

  assert.equal(outcome.reviewId, 999);
  assert.equal(outcome.refreshed, false);
  assert.equal(outcome.deletedComments, 0);
  assert.equal(outcome.inlineCount, 1);

  const reviewPosts = harness.calls.filter((call) => call.options.method === "POST" && call.url.endsWith("/reviews"));
  assert.equal(reviewPosts.length, 1);
  const postBody = JSON.parse(reviewPosts[0].options.body);
  assert.equal(postBody.event, "COMMENT");
  assert.equal(postBody.commit_id, "head-sha");
  assert.equal(postBody.comments.length, 1);
  assert.equal(postBody.comments[0].path, "src/http/sse.ts");
  assert.ok(postBody.body.includes(buildMarker("head-sha", "base-sha")));
  assert.equal(harness.calls.some((call) => call.options.method === "PUT"), false);
  assert.equal(harness.calls.some((call) => call.options.method === "DELETE"), false);
});

test("publishReview 复审时刷新持久 review 并重建行内评论", async () => {
  const bundle = buildBundle();
  const reviews = [
    { id: 100, user: { login: "human-reviewer" }, body: "人工评审" },
    { id: 200, user: { login: "github-actions[bot]" }, body: `${buildMarker("old-head", "base-sha")} 旧结论` },
  ];
  const prComments = [
    { id: 1, user: { login: "github-actions[bot]" }, path: "src/http/sse.ts" },
    { id: 2, user: { login: "human-reviewer" }, path: "src/http/sse.ts" },
    { id: 3, user: { login: "github-actions[bot]" }, path: "src/other.ts" },
  ];
  const harness = githubFake({ reviews, prComments });

  const outcome = await publishReview({
    token: "token",
    owner: "o",
    repo: "r",
    prNumber: 7,
    headSha: "head-sha",
    baseSha: "base-sha",
    result: ONE_INLINE_RESULT,
    diffBundle: bundle,
    fetchImpl: harness.fetch,
  });

  assert.equal(outcome.reviewId, 200);
  assert.equal(outcome.refreshed, true);
  assert.equal(outcome.deletedComments, 2);

  assert.equal(
    harness.calls.filter((call) => call.options.method === "POST" && call.url.endsWith("/reviews")).length,
    0,
  );

  const putCall = harness.calls.find((call) => call.options.method === "PUT");
  assert.match(putCall.url, /\/reviews\/200$/);
  const putBody = JSON.parse(putCall.options.body);
  assert.ok(putBody.body.includes(buildMarker("head-sha", "base-sha")));

  const deleteUrls = harness.calls
    .filter((call) => call.options.method === "DELETE")
    .map((call) => call.url)
    .sort();
  assert.deepEqual(deleteUrls, [
    "https://api.github.com/repos/o/r/pulls/comments/1",
    "https://api.github.com/repos/o/r/pulls/comments/3",
  ]);

  const commentPosts = harness.calls.filter((call) => call.options.method === "POST" && call.url.endsWith("/comments"));
  assert.equal(commentPosts.length, 1);
  const commentBody = JSON.parse(commentPosts[0].options.body);
  assert.equal(commentBody.commit_id, "head-sha");
  assert.equal(commentBody.path, "src/http/sse.ts");
  assert.equal(commentBody.line, 13);
  assert.equal(commentBody.side, "RIGHT");

  // 复审顺序：先拉全旧评论 id，再 PUT body、POST 新评论，最后才删除旧评论
  const putIndex = harness.calls.findIndex((call) => call.options.method === "PUT");
  const postCommentIndex = harness.calls.findIndex(
    (call) => call.options.method === "POST" && call.url.endsWith("/comments"),
  );
  const firstDeleteIndex = harness.calls.findIndex((call) => call.options.method === "DELETE");
  const lastGetIndex = harness.calls.map((call) => call.options.method).lastIndexOf("GET");
  assert.ok(lastGetIndex < putIndex);
  assert.ok(putIndex < postCommentIndex);
  assert.ok(postCommentIndex < firstDeleteIndex);
});

test("deleteBotReviewComments 只删除机器人账号自己的行内评论", async () => {
  const prComments = [
    { id: 1, user: { login: "human-reviewer" } },
    { id: 2, user: { login: "github-actions[bot]" } },
    { id: 3, user: { login: "other-bot" } },
  ];
  const harness = githubFake({ reviews: [], prComments });

  const deleted = await deleteBotReviewComments({
    apiBase: "https://api.github.com",
    token: "token",
    owner: "o",
    repo: "r",
    prNumber: 1,
    fetchImpl: harness.fetch,
  });

  assert.equal(deleted, 1);
  const deleteCalls = harness.calls.filter((call) => call.options.method === "DELETE");
  assert.equal(deleteCalls.length, 1);
  assert.match(deleteCalls[0].url, /\/pulls\/comments\/2$/);
});

test("listBotReviewCommentIds 跨页只收集机器人账号自己的评论 id", async () => {
  const firstPage = [
    { id: 1, user: { login: "human-reviewer" } },
    ...Array.from({ length: 99 }, (_, index) => ({ id: index + 2, user: { login: "github-actions[bot]" } })),
  ];
  const secondPage = [
    { id: 101, user: { login: "github-actions[bot]" } },
    { id: 102, user: { login: "other-bot" } },
  ];
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(url.includes("page=2") ? secondPage : firstPage);
  };

  const ids = await listBotReviewCommentIds({
    apiBase: "https://api.github.com",
    token: "token",
    owner: "o",
    repo: "r",
    prNumber: 1,
    fetchImpl: fetch,
  });

  assert.equal(ids.length, 100);
  assert.ok(ids.includes(101));
  assert.ok(!ids.includes(1));
  assert.ok(!ids.includes(102));
  assert.equal(calls.some((call) => call.options.method !== "GET"), false);
});

test("deleteBotReviewComments 先拉全 id 再删除，offset 偏移不漏删", async () => {
  // 可变存储模拟真实分页：删除会让后续条目前移，边翻页边删会跳过第二页
  const store = Array.from({ length: 150 }, (_, index) => ({
    id: index + 1,
    user: { login: "github-actions[bot]" },
  }));
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === "GET") {
      const page = Number(new URL(url).searchParams.get("page"));
      const start = (page - 1) * 100;
      return jsonResponse(store.slice(start, start + 100));
    }
    if (options.method === "DELETE") {
      const id = Number(url.split("/").pop());
      const index = store.findIndex((comment) => comment.id === id);
      if (index >= 0) store.splice(index, 1);
      return { ok: true, status: 204, async text() { return ""; } };
    }
    return jsonResponse({});
  };

  const deleted = await deleteBotReviewComments({
    apiBase: "https://api.github.com",
    token: "token",
    owner: "o",
    repo: "r",
    prNumber: 1,
    fetchImpl: fetch,
  });

  assert.equal(deleted, 150);
  assert.equal(store.length, 0);
  const firstDeleteIndex = calls.findIndex((call) => call.options.method === "DELETE");
  const lastGetIndex = calls.map((call) => call.options.method).lastIndexOf("GET");
  assert.ok(lastGetIndex < firstDeleteIndex);
});

test("publishReview 复审时 PUT 失败则不发新评论也不删旧评论", async () => {
  const bundle = buildBundle();
  const reviews = [{ id: 200, user: { login: "github-actions[bot]" }, body: buildMarker("old", "b") }];
  const prComments = [{ id: 1, user: { login: "github-actions[bot]" } }];
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === "PUT") {
      return { ok: false, status: 422, async text() { return "validation failed" } };
    }
    if (options.method === "GET" && url.includes("/reviews")) return jsonResponse(reviews);
    if (options.method === "GET" && url.includes("/comments")) return jsonResponse(prComments);
    if (options.method === "DELETE") return { ok: true, status: 204, async text() { return ""; } };
    return jsonResponse({ id: 999 });
  };

  await assert.rejects(
    publishReview({
      token: "token",
      owner: "o",
      repo: "r",
      prNumber: 7,
      headSha: "head-sha",
      baseSha: "base-sha",
      result: ONE_INLINE_RESULT,
      diffBundle: bundle,
      fetchImpl: fetch,
    }),
    /422/,
  );
  assert.equal(calls.some((call) => call.options.method === "DELETE"), false);
  assert.equal(
    calls.some((call) => call.options.method === "POST" && call.url.endsWith("/comments")),
    false,
  );
});

test("publishReview 复审时新评论 POST 失败则保留旧评论不删除", async () => {
  const bundle = buildBundle();
  const reviews = [{ id: 200, user: { login: "github-actions[bot]" }, body: buildMarker("old", "b") }];
  const prComments = [{ id: 1, user: { login: "github-actions[bot]" } }];
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === "POST" && url.endsWith("/comments")) {
      return { ok: false, status: 422, async text() { return "line not in diff" } };
    }
    if (options.method === "GET" && url.includes("/reviews")) return jsonResponse(reviews);
    if (options.method === "GET" && url.includes("/comments")) return jsonResponse(prComments);
    if (options.method === "DELETE") return { ok: true, status: 204, async text() { return ""; } };
    return jsonResponse({ id: 999 });
  };

  await assert.rejects(
    publishReview({
      token: "token",
      owner: "o",
      repo: "r",
      prNumber: 7,
      headSha: "head-sha",
      baseSha: "base-sha",
      result: ONE_INLINE_RESULT,
      diffBundle: bundle,
      fetchImpl: fetch,
    }),
    /422/,
  );
  assert.equal(calls.some((call) => call.options.method === "DELETE"), false);
  assert.ok(calls.some((call) => call.options.method === "PUT"));
});

test("publishReview 在 API 失败时抛出错误", async () => {
  const bundle = buildBundle();
  const failingFetch = async () => ({
    ok: false,
    status: 422,
    async text() {
      return "validation failed";
    },
  });

  await assert.rejects(
    publishReview({
      token: "token",
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "h",
      baseSha: "b",
      result: { summary: "s", coverageGaps: [], findings: [] },
      diffBundle: bundle,
      fetchImpl: failingFetch,
    }),
    /422/,
  );
});
