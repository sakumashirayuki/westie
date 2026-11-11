import assert from "node:assert/strict";
import test from "node:test";

import {
  createMcpTool,
  createMcpTools,
  mcpToolName,
  truncateBytes,
} from "../src/tools/mcp-tool.js";
import { ToolExecutionError, ToolRegistry } from "../src/tools.js";
import { z } from "zod";
import type { McpCallResult } from "../src/mcp/types.js";

// 一个轻量假 client，只实现 callTool。
type CallTool = (
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<McpCallResult>;

// fakeClient 接受一个返回任意结构化对象的函数，测试里写 content 块时不必拼完整
// McpContentBlock；这里用宽松类型桥接。
function fakeClient(
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): CallTool {
  return (name, args) =>
    callTool(name, args) as Promise<McpCallResult>;
}

const remoteTool = {
  name: "create_issue",
  description: "Create an issue.",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  },
  title: "Create Issue",
  readOnlyHint: false,
  destructiveHint: true,
};

test("names a tool mcp__<server>__<tool> and sanitizes", () => {
  assert.equal(mcpToolName("github", "create_issue"), "mcp__github__create_issue");
  assert.equal(mcpToolName("a", "x.y z"), "mcp__a__x_y_z");
});

test("skips a tool whose input schema does not convert to a ZodObject", async () => {
  const tool = createMcpTool({
    server: "s",
    remoteTool: { name: "x", inputSchema: { type: "string" } },
    callTool: fakeClient(async () => ({})),
    timeoutMs: 1000,
  });
  assert.equal(tool, undefined);
});

test("maps a text result and trims description", async () => {
  const tool = createMcpTool({
    server: "github",
    remoteTool,
    callTool: fakeClient(async () => ({
      content: [{ type: "text", text: "issue-1" }],
    })),
    timeoutMs: 1000,
  });
  assert.notEqual(tool, undefined);
  assert.equal(tool!.looseInputSchema, true);
  assert.equal(tool!.name, "mcp__github__create_issue");
  assert.match(tool!.impact, /Calls "create_issue" on MCP server github/);

  const result = await tool!.execute({ title: "hello" }, {});
  assert.deepEqual(result, {
    server: "github",
    tool: "create_issue",
    content: [{ type: "text", text: "issue-1" }],
  });
});

test("throws MCP_TOOL_ERROR when isError is true", async () => {
  const tool = createMcpTool({
    server: "github",
    remoteTool,
    callTool: fakeClient(async () => ({
      isError: true,
      content: [{ type: "text", text: "boom happened" }],
    })),
    timeoutMs: 1000,
  });
  await assert.rejects(
    tool!.execute({ title: "x" }, {}),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.code === "MCP_TOOL_ERROR" &&
      error.message === "boom happened",
  );
});

test("omits image bytes and truncates long text", async () => {
  const tool = createMcpTool({
    server: "github",
    remoteTool: {
      name: "images",
      inputSchema: { type: "object", properties: {} },
    },
    callTool: fakeClient(async () => ({
      content: [
        { type: "image", mimeType: "image/png", data: "abc" },
        { type: "text", text: "a".repeat(50_000) },
      ],
    })),
    timeoutMs: 1000,
  });
  const result = (await tool!.execute({}, {})) as {
    content: Array<Record<string, unknown>>;
  };
  assert.equal(result.content[0]?.type, "image");
  assert.equal(result.content[0]?.omitted, true);
  // 文本被截断并追加 truncated 标记。
  assert.ok(result.content.some((b) =>
    b.type === "text" && String(b.text).includes("truncated")
  ));
});

test("truncateBytes stays within the byte budget on multibyte text", () => {
  assert.equal(truncateBytes("abcdef", 3), "abc");
  assert.ok(Buffer.byteLength(truncateBytes("中文测试", 3), "utf8") <= 3);
});

test("rejects a tool name longer than 64 characters", () => {
  const tool = createMcpTool({
    server: "s".repeat(70),
    remoteTool,
    callTool: fakeClient(async () => ({})),
    timeoutMs: 1000,
  });
  assert.equal(tool, undefined);
});

test("maps a transport failure to MCP_SERVER_UNAVAILABLE", async () => {
  const tool = createMcpTool({
    server: "github",
    remoteTool,
    callTool: fakeClient(async () => {
      throw new Error("MCP server closed the connection.");
    }),
    timeoutMs: 1000,
  });
  await assert.rejects(
    tool!.execute({ title: "x" }, {}),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.code === "MCP_SERVER_UNAVAILABLE" &&
      error.message.includes("github") &&
      error.message.includes("closed the connection"),
  );
});

test("passes the run signal through and rethrows on cancellation", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const tool = createMcpTool({
    server: "github",
    remoteTool,
    callTool: async (_name, _args, _timeoutMs, signal) => {
      receivedSignal = signal;
      controller.abort(new Error("run cancelled"));
      throw signal!.reason;
    },
    timeoutMs: 1000,
  });
  await assert.rejects(
    tool!.execute({ title: "x" }, { signal: controller.signal }),
    (error: unknown) =>
      !(error instanceof ToolExecutionError) &&
      error instanceof Error && error.message === "run cancelled",
  );
  assert.equal(receivedSignal, controller.signal);
});

test("createMcpTools skips a sanitized name collision with a diagnostic", () => {
  const client = {
    async callTool() {
      return { content: [] };
    },
  } as unknown as import("../src/mcp/client.js").McpClient;
  const source = (name: string, schema: Record<string, unknown> = { type: "object" }) => ({
    server: "s",
    tool: { name, inputSchema: schema },
    client,
    timeoutMs: 1000,
  });
  const set = createMcpTools([
    source("list.items"),
    source("list/items"),
    source("bad", { type: "string" }),
    source("ok"),
  ]);
  assert.deepEqual(set.tools.map((tool) => tool.name), [
    "mcp__s__list_items",
    "mcp__s__ok",
  ]);
  assert.equal(set.diagnostics.length, 2);
  assert.ok(set.diagnostics.every((d) => d.code === "MCP_TOOL_SKIPPED"));
  assert.match(set.diagnostics[0]!.message, /"list\/items".*collides.*mcp__s__list_items/);
  assert.match(set.diagnostics[1]!.message, /"bad".*not an object schema/);
  // 两个 Tool 名字互不重复，ToolRegistry 不会抛 Duplicate tool name。
  assert.doesNotThrow(() => new ToolRegistry(set.tools));
});
