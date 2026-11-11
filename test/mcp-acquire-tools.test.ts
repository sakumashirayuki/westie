import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { acquireMcpToolSet } from "../src/mcp/acquire-tools.js";
import { McpServerPool } from "../src/mcp/server-pool.js";
import type { WorkspaceMcpDiagnostic } from "../src/infrastructure/workspace-mcp-config.js";

const SERVER = resolve(process.cwd(), "test", "support", "fake-mcp-server.mjs");

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("returns ready-made tools from the merged config and reports diagnostics", async (t) => {
  const workspaceRoot = await tempDir(t, "mcp-acquire-ws-");
  const homeDir = await tempDir(t, "mcp-acquire-home-");
  await mkdir(join(homeDir, ".agents"), { recursive: true });
  await writeFile(
    join(homeDir, ".agents", "mcp.json"),
    JSON.stringify({
      servers: {
        fake: { type: "stdio", command: process.execPath, args: [SERVER] },
        broken: { type: "stdio", command: "/no/such/command" },
      },
    }),
  );
  const reported: WorkspaceMcpDiagnostic[] = [];
  await using pool = new McpServerPool({ homeDir });
  const tools = await acquireMcpToolSet(pool, workspaceRoot, {
    homeDir,
    env: {},
    report: (diagnostics) => reported.push(...diagnostics),
  });
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["crash", "echo", "fail", "image", "slow"].map((name) => `mcp__fake__${name}`),
  );
  assert.deepEqual(
    reported.map((d) => [d.code, d.server]),
    [["MCP_SERVER_UNAVAILABLE", "broken"]],
  );
});

test("returns no tools when nothing is configured", async (t) => {
  const workspaceRoot = await tempDir(t, "mcp-acquire-ws-");
  const homeDir = await tempDir(t, "mcp-acquire-home-");
  await using pool = new McpServerPool({ homeDir });
  const tools = await acquireMcpToolSet(pool, workspaceRoot, {
    homeDir,
    env: {},
    report: () => {},
  });
  assert.deepEqual(tools, []);
});

test("an unexpected failure yields no tools and one diagnostic instead of throwing", async (t) => {
  const workspaceRoot = await tempDir(t, "mcp-acquire-ws-");
  const homeDir = await tempDir(t, "mcp-acquire-home-");
  const reported: WorkspaceMcpDiagnostic[] = [];
  const pool = {
    async acquire() {
      throw new Error("pool exploded");
    },
    async close() {},
  } as unknown as McpServerPool;
  const tools = await acquireMcpToolSet(pool, workspaceRoot, {
    homeDir,
    env: {},
    report: (diagnostics) => reported.push(...diagnostics),
  });
  assert.deepEqual(tools, []);
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.code, "MCP_SERVER_UNAVAILABLE");
  assert.match(reported[0]!.message, /pool exploded/);
});
