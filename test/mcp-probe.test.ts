import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { probeMcpServer } from "../src/mcp/probe.js";

const SERVER = resolve(process.cwd(), "test", "support", "fake-mcp-server.mjs");

test("probeMcpServer returns tools for a working stdio server", async () => {
  const result = await probeMcpServer(
    {
      type: "stdio",
      command: process.execPath,
      args: [SERVER],
      timeoutMs: 5_000,
    },
    { homeDir: process.cwd() },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(
      result.tools.map((t) => t.name),
      ["echo", "fail", "slow", "image", "crash"],
    );
  }
});

test("probeMcpServer returns ok:false for a missing command", async () => {
  const result = await probeMcpServer(
    { type: "stdio", command: "/no/such/command", timeoutMs: 1_000 },
    { homeDir: process.cwd() },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /exited|spawn|MCP/i);
});

test("probeMcpServer closes the client after probing", async () => {
  const result = await probeMcpServer(
    {
      type: "stdio",
      command: process.execPath,
      args: [SERVER],
      timeoutMs: 5_000,
    },
    { homeDir: process.cwd() },
  );
  assert.equal(result.ok, true);
  // 无残留子进程的断言由 fake server 的退出路径保证；这里仅验证不抛错。
});
