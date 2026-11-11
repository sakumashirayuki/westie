import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue } from "../src/protocol.js";
import { ToolRegistry } from "../src/tools.js";
import { createWebFetchTool } from "../src/tools/web-fetch.js";

interface FetchOutput {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
}

function out(result: { output: JsonValue }): FetchOutput {
  return result.output as unknown as FetchOutput;
}

function htmlResponse(body: string, opts: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(body, {
    status: opts.status ?? 200,
    headers: { "Content-Type": "text/html; charset=utf-8", ...opts.headers },
  });
}

function createTool(overrides: Partial<Parameters<typeof createWebFetchTool>[0]> = {}) {
  const fetchMock = overrides.fetch ?? (async () => htmlResponse("<h1>Hello</h1>"));
  const lookupMock = overrides.lookup ?? (async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  return createWebFetchTool({
    executionMode: "workspace_sandbox",
    fetch: fetchMock,
    lookup: lookupMock,
    ...overrides,
  });
}

test("fetches HTML and converts to text with pagination fields", async () => {
  const registry = new ToolRegistry([createTool({
    fetch: async () => htmlResponse("<h1>Hello</h1><p>World</p>"),
  })]);
  const result = await registry.execute("web_fetch", { url: "https://example.com/" });
  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.equal(out(result).content, "# Hello\nWorld");
    assert.equal(out(result).startLine, 1);
    assert.equal(out(result).totalLines, 2);
  }
});

test("returns the UTF-8, entity-decoded title for HTML", async () => {
  const registry = new ToolRegistry([createTool({
    fetch: async () =>
      htmlResponse("<html><head><title>Caf\u00e9 &amp; Bar</title></head><body>hi</body></html>"),
  })]);
  const result = await registry.execute("web_fetch", { url: "https://example.com/" });
  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.equal(out(result).title, "Caf\u00e9 & Bar");
  }
});

test("paginates with offset and limit", async () => {
  const lines = Array.from({ length: 10 }, (_, i) => `<p>line ${i}</p>`).join("");
  const registry = new ToolRegistry([createTool({ fetch: async () => htmlResponse(lines) })]);
  const result = await registry.execute("web_fetch", {
    url: "https://example.com/",
    offset: 3,
    limit: 2,
  });
  if (result.status === "success") {
    assert.equal(out(result).content, "line 2\nline 3");
    assert.equal(out(result).startLine, 3);
    assert.equal(out(result).endLine, 4);
  }
});

test("follows redirects with per-hop address checks", async () => {
  const calls: string[] = [];
  const registry = new ToolRegistry([createTool({
    fetch: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://start.example/") {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://end.example/page" },
        });
      }
      return htmlResponse("<p>done</p>");
    },
  })]);
  const result = await registry.execute("web_fetch", { url: "https://start.example/" });
  assert.deepEqual(calls, ["https://start.example/", "https://end.example/page"]);
  if (result.status === "success") {
    assert.equal(out(result).finalUrl, "https://end.example/page");
    assert.equal(out(result).content, "done");
  }
});

test("rejects private, loopback, and localhost addresses in sandbox mode", async () => {
  const blocked = [
    { host: "127.0.0.1", addresses: [{ address: "127.0.0.1", family: 4 }] },
    { host: "10.0.0.1", addresses: [{ address: "10.0.0.1", family: 4 }] },
    { host: "192.168.1.1", addresses: [{ address: "192.168.1.1", family: 4 }] },
    { host: "localhost", addresses: [{ address: "127.0.0.1", family: 4 }] },
    { host: "foo.local", addresses: [{ address: "192.168.1.2", family: 4 }] },
  ];
  for (const { host, addresses } of blocked) {
    const registry = new ToolRegistry([createTool({
      fetch: async () => htmlResponse("<p>x</p>"),
      lookup: async () => addresses,
    })]);
    const result = await registry.execute("web_fetch", { url: `http://${host}/` });
    assert.equal(result.status, "error", `expected ${host} to be rejected`);
    if (result.status === "error") {
      assert.equal(result.error.code, "FETCH_BLOCKED_ADDRESS");
    }
  }
});

test("resolves dotless hostnames and rejects them when they map to blocked addresses", async () => {
  const looked: string[] = [];
  const registry = new ToolRegistry([createTool({
    fetch: async () => htmlResponse("<p>x</p>"),
    lookup: async (hostname) => {
      looked.push(hostname);
      return [{ address: "10.0.0.5", family: 4 }];
    },
  })]);
  const result = await registry.execute("web_fetch", { url: "http://internal-service/" });
  assert.deepEqual(looked, ["internal-service"]);
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.error.code, "FETCH_BLOCKED_ADDRESS");
  }
});

test("rejects bracketed IPv6 loopback literals without a DNS lookup", async () => {
  const looked: string[] = [];
  const registry = new ToolRegistry([createTool({
    fetch: async () => htmlResponse("<p>x</p>"),
    lookup: async (hostname) => {
      looked.push(hostname);
      return [];
    },
  })]);
  const result = await registry.execute("web_fetch", { url: "http://[::1]:8080/" });
  assert.deepEqual(looked, []);
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.error.code, "FETCH_BLOCKED_ADDRESS");
  }
});

test("does not look up literal public IPs", async () => {
  const looked: string[] = [];
  const registry = new ToolRegistry([createTool({
    fetch: async () => htmlResponse("<p>x</p>"),
    lookup: async (hostname) => {
      looked.push(hostname);
      return [];
    },
  })]);
  const result = await registry.execute("web_fetch", { url: "http://93.184.216.34/" });
  assert.deepEqual(looked, []);
  assert.equal(result.status, "success");
});

test("rejects userinfo URLs", async () => {
  const registry = new ToolRegistry([createTool()]);
  const result = await registry.execute("web_fetch", {
    url: "https://user:pass@example.com/",
  });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.error.code, "FETCH_BLOCKED_ADDRESS");
  }
});

test("allows private addresses in full_access mode", async () => {
  const registry = new ToolRegistry([
    createWebFetchTool({
      executionMode: "full_access",
      fetch: async () => htmlResponse("<p>ok</p>"),
    }),
  ]);
  const result = await registry.execute("web_fetch", { url: "http://127.0.0.1/" });
  assert.equal(result.status, "success");
});

test("maps non-2xx to FETCH_FAILED", async () => {
  const registry = new ToolRegistry([createTool({
    fetch: async () => new Response("not found", { status: 404 }),
  })]);
  const result = await registry.execute("web_fetch", { url: "https://example.com/" });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.error.code, "FETCH_FAILED");
    assert.match(result.error.message, /HTTP 404/);
  }
});

test("aborts when body exceeds 2 MiB", async () => {
  const bigBody = "x".repeat(3 * 1024 * 1024);
  const registry = new ToolRegistry([createTool({
    fetch: async () => htmlResponse(bigBody),
  })]);
  const result = await registry.execute("web_fetch", { url: "https://example.com/" });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.error.code, "FETCH_FAILED");
  }
});

test("reports unsupported content type", async () => {
  const registry = new ToolRegistry([createTool({
    fetch: async () =>
      new Response("%PDF", { status: 200, headers: { "Content-Type": "application/pdf" } }),
  })]);
  const result = await registry.execute("web_fetch", { url: "https://example.com/doc.pdf" });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.error.code, "FETCH_UNSUPPORTED_CONTENT");
    assert.match(result.error.message, /application\/pdf/);
  }
});

test("enforces timeout", async () => {
  const registry = new ToolRegistry([createTool({
    timeoutMs: 5,
    fetch: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      }),
  })]);
  const result = await registry.execute("web_fetch", { url: "https://example.com/" });
  assert.equal(result.status, "error");
});

test("propagates run cancellation", async () => {
  const controller = new AbortController();
  const registry = new ToolRegistry([createTool({
    fetch: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  })]);
  const execution = registry.execute(
    "web_fetch",
    { url: "https://example.com/" },
    { signal: controller.signal },
  );
  controller.abort(new Error("run cancelled"));
  await assert.rejects(execution, /run cancelled/);
});
