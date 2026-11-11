import assert from "node:assert/strict";
import test from "node:test";

import { ToolRegistry } from "../src/tools.js";
import { createWebSearchTool } from "../src/tools/web-search.js";

const sampleResults = Array.from({ length: 6 }, (_, index) => ({
  title: `Result ${index + 1}`,
  url: `https://example.com/${index + 1}`,
  content: `Content ${index + 1}`,
  score: 1 - index / 10,
  raw_content: null,
}));

test("web_search sends the fixed Tavily request and returns five normalized results", async () => {
  const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const tool = createWebSearchTool({
    apiKey: "test-key",
    async fetch(input, init) {
      requests.push({ input, init });
      return Response.json({ results: sampleResults });
    },
  });
  const registry = new ToolRegistry([tool]);

  const result = await registry.execute("web_search", { query: "  current news  " });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.input, "https://api.tavily.com/search");
  assert.deepEqual(requests[0]?.init?.headers, {
    Authorization: "Bearer test-key",
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    query: "current news",
    search_depth: "basic",
    max_results: 5,
    include_answer: false,
  });
  assert.ok(requests[0]?.init?.signal instanceof AbortSignal);
  assert.deepEqual(result, {
    type: "tool_result",
    tool: "web_search",
    status: "success",
    output: {
      results: sampleResults.slice(0, 5).map(({ title, url, content, score }) => ({
        title,
        url,
        content,
        score,
      })),
    },
  });
});

test("web_search accepts only a non-empty query", async () => {
  const registry = new ToolRegistry([
    createWebSearchTool({
      apiKey: "test-key",
      fetch: async () => Response.json({ results: [] }),
    }),
  ]);

  for (const input of [{}, { query: "   " }, { query: "x", maxResults: 1 }]) {
    const result = await registry.execute("web_search", input);
    assert.equal(result.status, "error");
    if (result.status === "error") {
      assert.equal(result.error.code, "INVALID_TOOL_INPUT");
    }
  }
});

test("web_search maps Tavily HTTP and response errors to TOOL_EXECUTION_FAILED", async () => {
  for (const fetch of [
    async () => new Response("rate limited", { status: 429 }),
    async () => Response.json({ results: [{ title: "missing fields" }] }),
  ]) {
    const registry = new ToolRegistry([
      createWebSearchTool({ apiKey: "test-key", fetch }),
    ]);
    const result = await registry.execute("web_search", { query: "query" });

    assert.deepEqual(result, {
      type: "tool_result",
      tool: "web_search",
      status: "error",
      error: {
        code: "TOOL_EXECUTION_FAILED",
        message: "Tool execution failed.",
      },
    });
  }
});

test("web_search enforces its request timeout", async () => {
  const registry = new ToolRegistry([
    createWebSearchTool({
      apiKey: "test-key",
      timeoutMs: 5,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    }),
  ]);

  const result = await registry.execute("web_search", { query: "query" });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.error.code, "TOOL_EXECUTION_FAILED");
  }
});

test("web_search propagates run cancellation", async () => {
  const controller = new AbortController();
  const registry = new ToolRegistry([
    createWebSearchTool({
      apiKey: "test-key",
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    }),
  ]);
  const execution = registry.execute(
    "web_search",
    { query: "query" },
    { signal: controller.signal },
  );

  controller.abort(new Error("run cancelled"));

  await assert.rejects(execution, /run cancelled/);
});
