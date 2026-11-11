import assert from "node:assert/strict";
import test from "node:test";

import { decodeEntities, htmlToText } from "../src/tools/html-to-text.js";

test("preserves headings as #-prefixed lines", () => {
  const html = "<h1>Title</h1><h3>Sub</h3>";
  assert.equal(htmlToText(html), "# Title\n### Sub");
});

test("collapses body blocks and preserves paragraphs", () => {
  const html = "<div><p>First</p><p>Second</p></div>";
  assert.equal(htmlToText(html), "First\nSecond");
});

test("renders list items with dashes", () => {
  const html = "<ul><li>a</li><li>b</li></ul>";
  assert.equal(htmlToText(html), "- a\n- b");
});

test("preserves link text and resolves relative hrefs", () => {
  const html = '<p>See <a href="/docs">docs</a> and <a href="page.html">page</a></p>';
  const text = htmlToText(html, "https://example.com/base/");
  assert.match(text, /See docs \(https:\/\/example\.com\/docs\) and page \(https:\/\/example\.com\/base\/page\.html\)/);
});

test("preserves pre whitespace", () => {
  const html = "<pre>  a\n b </pre>";
  assert.equal(htmlToText(html), "  a\n b ");
});

test("strips script and style contents", () => {
  const html = "<style>body{}</style><p>hi</p><script>alert(1)</script>";
  assert.equal(htmlToText(html), "hi");
});

test("decodes common entities", () => {
  assert.equal(decodeEntities("&amp; &lt; &gt; &quot; &apos; &nbsp;"), "& < > \" ' \u00a0");
});

test("extracts title from head", () => {
  const html = "<html><head><title>My Page</title></head><body>text</body></html>";
  assert.equal(htmlToText(html), "My Page\ntext");
});
