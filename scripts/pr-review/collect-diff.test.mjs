import assert from "node:assert/strict";
import { test } from "node:test";
import { collectDiff, parseDiff, DIFF_CONTEXT_LINES } from "./collect-diff.mjs";

const SAMPLE_DIFF = `diff --git a/src/http/sse.ts b/src/http/sse.ts
index 1111111..2222222 100644
--- a/src/http/sse.ts
+++ b/src/http/sse.ts
@@ -12,0 +13,2 @@
+export function keepAlive() {
+  return true;
diff --git a/src/index.ts b/src/index.ts
index 3333333..4444444 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -5,1 +5,1 @@
-import old from "old";
+import fresh from "fresh";
diff --git a/build/icon.png b/build/icon.png
index 5555555..6666666 100644
Binary files a/build/icon.png and b/build/icon.png differ
`;

const EVENT = {
  pull_request: {
    number: 7,
    title: "test pr",
    body: "",
    base: { sha: "base-sha" },
    head: { sha: "head-sha" },
  },
  repository: { owner: { login: "sakumashirayuki" }, name: "westie" },
};

test("parseDiff 解析文件、hunk 新增行并跳过二进制文件", () => {
  const result = parseDiff(SAMPLE_DIFF);
  assert.equal(result.files.length, 2);
  const [sse, index] = result.files;

  assert.equal(sse.path, "src/http/sse.ts");
  assert.deepEqual(sse.hunks[0].addedLines, [13, 14]);
  assert.equal(index.hunks[0].addedLines[0], 5);
  assert.ok(result.coverageGaps.some((gap) => gap.includes("icon.png")));
});

const CONTEXT_DIFF = `diff --git a/src/http/sse.ts b/src/http/sse.ts
index 1111111..2222222 100644
--- a/src/http/sse.ts
+++ b/src/http/sse.ts
@@ -10,5 +10,6 @@
 function keepAlive() {
   const timer = 1;
+  const extra = 2;
   return timer;
 }
diff --git a/src/index.ts b/src/index.ts
index 3333333..4444444 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -4,3 +4,3 @@
 header
-import old from "old";
+import fresh from "fresh";
 footer
`;

test("parseDiff 记录 hunk 内上下文行号，删除行不占右侧行号", () => {
  const result = parseDiff(CONTEXT_DIFF);
  const [sse, index] = result.files;

  assert.deepEqual(sse.hunks[0].addedLines, [12]);
  assert.deepEqual(sse.hunks[0].contextLines, [10, 11, 13, 14]);
  assert.deepEqual(index.hunks[0].addedLines, [5]);
  assert.deepEqual(index.hunks[0].contextLines, [4, 6]);
});

test("parseDiff 在文件数超限时把多余文件写入缺口", () => {
  const result = parseDiff(SAMPLE_DIFF, { totalBytes: 1_000_000, perFileBytes: 1_000_000, maxFiles: 1 });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, "src/http/sse.ts");
  assert.ok(result.coverageGaps.some((gap) => gap.includes("src/index.ts")));
});

test("parseDiff 在单文件超限时按行截断并标记", () => {
  const result = parseDiff(SAMPLE_DIFF, { totalBytes: 1_000_000, perFileBytes: 80, maxFiles: 50 });
  const sse = result.files.find((file) => file.path === "src/http/sse.ts");
  assert.equal(sse.truncated, true);
  assert.ok(result.coverageGaps.some((gap) => gap.includes("已按行截断")));
  const originalLines = SAMPLE_DIFF.split("\n");
  for (const keptLine of sse.diffText.split("\n")) {
    assert.ok(originalLines.includes(keptLine), `截断只能丢弃整行，保留行必须与原文完全一致：${keptLine}`);
  }
});

test("parseDiff 按行截断时不切断多字节 UTF-8 字符", () => {
  const utf8Diff = `diff --git a/src/中文.ts b/src/中文.ts
index 1111111..2222222 100644
--- a/src/中文.ts
+++ b/src/中文.ts
@@ -1,0 +2,3 @@
+第一行中文内容比较长用于占用字节数
+第二行中文内容也比较长继续占用字节数
+第三行中文内容
`;
  const result = parseDiff(utf8Diff, { totalBytes: 1_000_000, perFileBytes: 70, maxFiles: 50 });
  const file = result.files[0];
  assert.equal(file.truncated, true);
  const originalLines = utf8Diff.split("\n");
  for (const keptLine of file.diffText.split("\n")) {
    assert.ok(originalLines.includes(keptLine), `多字节行必须整体保留或整体丢弃：${keptLine}`);
  }
});

test("parseDiff 在首行即超限时仍保留一行避免空 diff", () => {
  const tinyLimitDiff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,0 +2,1 @@
+这一行的 UTF-8 字节数远超截断限制
`;
  const result = parseDiff(tinyLimitDiff, { totalBytes: 1_000_000, perFileBytes: 5, maxFiles: 50 });
  const file = result.files[0];
  assert.equal(file.truncated, true);
  assert.equal(file.diffText, "index 1111111..2222222 100644");
});

test("collectDiff 固定 merge-base 并返回结构化 diff", () => {
  const calls = [];
  const execGit = (args) => {
    calls.push(args);
    if (args[0] === "merge-base") return "merge-base-sha\n";
    return SAMPLE_DIFF;
  };

  const bundle = collectDiff({ event: EVENT, execGit });
  assert.deepEqual(calls[0], ["merge-base", "base-sha", "head-sha"]);
  assert.equal(calls[1][0], "diff");
  assert.equal(calls[1][1], `--unified=${DIFF_CONTEXT_LINES}`);
  assert.ok(calls[1][2].startsWith("merge-base-sha...head-sha"));
  assert.equal(bundle.prNumber, 7);
  assert.equal(bundle.headSha, "head-sha");
  assert.equal(bundle.files.length, 2);
});

test("collectDiff 在事件缺字段时失败", () => {
  assert.throws(
    () => collectDiff({ event: { pull_request: { number: 1 } }, execGit: () => "" }),
    /无法确定审查对象/,
  );
});

test("collectDiff 在 diff 为空时失败", () => {
  const execGit = (args) => (args[0] === "merge-base" ? "sha\n" : "");
  assert.throws(() => collectDiff({ event: EVENT, execGit }), /没有可审查内容/);
});
