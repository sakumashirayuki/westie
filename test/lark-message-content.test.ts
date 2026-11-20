import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPostContent,
  chunkMarkdownForPost,
  measurePostRequestBytes,
  MAX_POST_MARKDOWN_CHUNK_BYTES,
  POST_MESSAGE_REQUEST_LIMIT_BYTES,
} from "../src/lark/lark-message-content.js";

/** 生产标识的保守最大长度：chat_id 约 36 字符，派生 uuid 约 54 字符，取整留余。 */
const REALISTIC_CHAT_ID = "o".repeat(36);
const REALISTIC_UUID = "u".repeat(60);
/** 模块内固定开销使用的最长占位标识，切片预算的硬保证以此为准。 */
const PLACEHOLDER_CHAT_ID = "o".repeat(64);
const PLACEHOLDER_UUID = "u".repeat(128);

test("buildPostContent wraps markdown in a single post md element", () => {
  const parsed = JSON.parse(buildPostContent("## 标题\n\n**加粗**"));
  assert.deepEqual(parsed, {
    zh_cn: {
      title: "",
      content: [[{ tag: "md", text: "## 标题\n\n**加粗**" }]],
    },
  });
});

test("post content round-trips through the double JSON encoding used on the wire", () => {
  const markdown = '路径 C:\\tmp 与 "引号"、\n\t制表符';
  const wire = JSON.stringify({ content: buildPostContent(markdown) });
  const recovered = JSON.parse(JSON.parse(wire).content).zh_cn.content[0][0].text;
  assert.equal(recovered, markdown);
});

test("measurePostRequestBytes accounts for double-escaped special characters", () => {
  const ids = { chatId: "oc_x", uuid: "westie-answer-run-0" };
  const baseline = measurePostRequestBytes("a", ids);
  assert.equal(measurePostRequestBytes('"', ids) - baseline, 3);
  assert.equal(measurePostRequestBytes("\\", ids) - baseline, 3);
  assert.equal(measurePostRequestBytes("\n", ids) - baseline, 2);
});

test("short markdown stays in a single chunk", () => {
  const markdown = "# 标题\n\n| A | B |\n| --- | --- |\n| 1 | 2 |";
  assert.deepEqual(chunkMarkdownForPost(markdown), [markdown]);
  assert.ok(
    measurePostRequestBytes(markdown, {
      chatId: REALISTIC_CHAT_ID,
      uuid: REALISTIC_UUID,
    }) < POST_MESSAGE_REQUEST_LIMIT_BYTES,
  );
});

test("empty markdown is a single empty chunk", () => {
  assert.deepEqual(chunkMarkdownForPost(""), [""]);
});

test("long CJK markdown splits without cutting multibyte characters and every chunk fits the post limit", () => {
  const text = "中".repeat(MAX_POST_MARKDOWN_CHUNK_BYTES + 10);
  const chunks = chunkMarkdownForPost(text);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), text);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, "utf8") > 0);
    assert.ok(
      measurePostRequestBytes(chunk, {
        chatId: PLACEHOLDER_CHAT_ID,
        uuid: PLACEHOLDER_UUID,
      }) <= POST_MESSAGE_REQUEST_LIMIT_BYTES,
    );
  }
});

test("adversarial punctuation keeps every suffixed chunk within the post limit", () => {
  const text = '"\\\n'.repeat(20_000);
  const chunks = chunkMarkdownForPost(text);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), text);
  for (const [index, chunk] of chunks.entries()) {
    // 终态多片回答会追加换行与序号后缀，用真实标识长度校验整条请求体。
    const suffixed = `${chunk}\n（${index + 1}/${chunks.length}）`;
    assert.ok(
      measurePostRequestBytes(suffixed, {
        chatId: REALISTIC_CHAT_ID,
        uuid: REALISTIC_UUID,
      }) <= POST_MESSAGE_REQUEST_LIMIT_BYTES,
    );
  }
});

test("chunk boundaries prefer newlines and spaces over cutting a line", () => {
  const text = `${"a".repeat(100)}\n${"b".repeat(100)}`;
  const chunks = chunkMarkdownForPost(text, 150);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].endsWith("\n"));
  assert.equal(chunks.join(""), text);
});

test("realistic markdown with headings, GFM table and code fence stays in one chunk", () => {
  const markdown = [
    "## 标题",
    "",
    "| 列 A | 列 B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "```ts",
    'const value: string = "引号 \\\\ 反斜杠";',
    "```",
    "",
    "**加粗** 与 [链接](https://example.com)",
  ].join("\n");
  const chunks = chunkMarkdownForPost(markdown);
  assert.equal(chunks.length, 1);
  assert.ok(
    measurePostRequestBytes(markdown, {
      chatId: REALISTIC_CHAT_ID,
      uuid: REALISTIC_UUID,
    }) < POST_MESSAGE_REQUEST_LIMIT_BYTES,
  );
});
