import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";

import { McpServerPool } from "../src/mcp/server-pool.js";
import type { WorkspaceMcpConfig } from "../src/infrastructure/workspace-mcp-config.js";
import { MemoryTransport } from "./support/mcp-transport.js";

const SERVER = resolve(process.cwd(), "test", "support", "fake-mcp-server.mjs");

async function workspace(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mcp-pool-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function config(): WorkspaceMcpConfig {
  return {
    servers: [
      {
        name: "fake",
        source: "workspace",
        config: {
          type: "stdio",
          command: process.execPath,
          args: [SERVER],
          timeoutMs: 1_000,
        },
      },
    ],
    diagnostics: [],
  };
}

test("reuses the cached connection across acquires with the same config", async (t) => {
  await using pool = new McpServerPool();
  const root = await workspace(t);
  const first = await pool.acquire(root, config());
  assert.equal(first.sources.length, 5);
  const second = await pool.acquire(root, config());
  assert.equal(second.sources.length, 5);
  assert.equal(second.diagnostics.length, 0);
});

test("reconnects when the config hash changes", async (t) => {
  await using pool = new McpServerPool();
  const root = await workspace(t);
  const first = await pool.acquire(root, config());
  assert.equal(first.sources.length, 5);
  // 变更 args（改变 config 哈希），应触发重连。
  const changed: WorkspaceMcpConfig = {
    servers: [{
      name: "fake",
      source: "workspace",
      config: {
        type: "stdio",
        command: process.execPath,
        args: [SERVER, "--page-size", "2"],
        timeoutMs: 1_000,
      },
    }],
    diagnostics: [],
  };
  const second = await pool.acquire(root, changed);
  assert.equal(second.sources.length, 5);
  assert.equal(second.diagnostics.length, 0);
});

test("unavailable server produces a diagnostic and does not break others", async (t) => {
  await using pool = new McpServerPool();
  const root = await workspace(t);
  const bad: WorkspaceMcpConfig = {
    servers: [{
      name: "fake",
      source: "workspace",
      config: { type: "stdio", command: "/no/such/command", timeoutMs: 1_000 },
    }],
    diagnostics: [],
  };
  const result = await pool.acquire(root, bad);
  assert.equal(result.sources.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.code, "MCP_SERVER_UNAVAILABLE");
});

test("a crashed server is detected on the next acquire and reconnected", async (t) => {
  await using pool = new McpServerPool();
  const root = await workspace(t);
  const first = await pool.acquire(root, config());
  const crash = first.sources.find((source) => source.tool.name === "crash")!;
  // crash 工具让 Server 进程退出；调用本身以断连失败。
  await assert.rejects(crash.client.callTool("crash", {}, 1_000));
  // 进程退出事件比错误响应晚到一点，等传输观察到关闭。
  const deadline = Date.now() + 2_000;
  while (!crash.client.closed && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(crash.client.closed, true);

  const second = await pool.acquire(root, config());
  assert.equal(second.diagnostics.length, 0);
  assert.equal(second.sources.length, 5);
  assert.notEqual(second.sources[0]!.client, crash.client);
  assert.equal(second.sources[0]!.client.closed, false);
});

// 下面几例用注入的假传输，观察连接池对传输生命周期的处理。
function fakeServerTransport(protocolVersion = "2025-06-18"): MemoryTransport {
  const transport = new MemoryTransport();
  const originalSend = transport.send.bind(transport);
  transport.send = async (request) => {
    await originalSend(request);
    // 假 Server：initialize 回版本号，tools/list 回一个工具。
    setTimeout(() => {
      if (request.method === "initialize") {
        transport.push({ kind: "response", id: request.id, result: { protocolVersion } });
      } else if (request.method === "tools/list") {
        transport.push({
          kind: "response",
          id: request.id,
          result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
        });
      }
    }, 0);
  };
  return transport;
}

test("closes the transport when the handshake fails", async (t) => {
  const transports: MemoryTransport[] = [];
  await using pool = new McpServerPool({
    createTransport() {
      const transport = fakeServerTransport("1900-01-01");
      transports.push(transport);
      return transport;
    },
  });
  const result = await pool.acquire(await workspace(t), config());
  assert.equal(result.sources.length, 0);
  assert.equal(result.diagnostics[0]?.code, "MCP_SERVER_UNAVAILABLE");
  assert.equal(transports.length, 1);
  // 握手失败后传输必须被关掉，否则 stdio 子进程会一直活着。
  assert.equal(transports[0]!.closeCalls, 1);
  assert.equal(transports[0]!.closed, true);
});

test("concurrent acquires for the same server share one connection attempt", async (t) => {
  let created = 0;
  await using pool = new McpServerPool({
    createTransport() {
      created += 1;
      return fakeServerTransport();
    },
  });
  const root = await workspace(t);
  const [first, second] = await Promise.all([
    pool.acquire(root, config()),
    pool.acquire(root, config()),
  ]);
  assert.equal(created, 1);
  assert.equal(first.sources[0]!.client, second.sources[0]!.client);
});

test("does not reuse a connection whose transport has closed", async (t) => {
  const transports: MemoryTransport[] = [];
  await using pool = new McpServerPool({
    createTransport() {
      const transport = fakeServerTransport();
      transports.push(transport);
      return transport;
    },
  });
  const root = await workspace(t);
  const first = await pool.acquire(root, config());
  // 模拟 Server 崩溃：传输自行关闭，配置与 dirty 标记都没变。
  await transports[0]!.close();
  const second = await pool.acquire(root, config());
  assert.equal(transports.length, 2);
  assert.notEqual(second.sources[0]!.client, first.sources[0]!.client);
});

test("resolves cwd against the home directory for user-level servers", async (t) => {
  const targets: Array<{ source: string; homeDir: string; workspaceRoot: string }> = [];
  const homeDir = "/tmp/fake-home";
  await using pool = new McpServerPool({
    homeDir,
    createTransport(target) {
      targets.push(target);
      return fakeServerTransport();
    },
  });
  const root = await workspace(t);
  const base = config().servers[0]!;
  await pool.acquire(root, {
    servers: [
      { ...base, name: "global", source: "user" },
      { ...base, name: "local", source: "workspace" },
    ],
    diagnostics: [],
  });
  const bySource = Object.fromEntries(targets.map((target) => [target.source, target]));
  assert.equal(bySource.user?.homeDir, homeDir);
  assert.equal(bySource.workspace?.workspaceRoot, root);
});

test("leaving the scope closes every pooled connection", async (t) => {
  const transports: MemoryTransport[] = [];
  const root = await workspace(t);
  {
    await using pool = new McpServerPool({
      createTransport() {
        const transport = fakeServerTransport();
        transports.push(transport);
        return transport;
      },
    });
    await pool.acquire(root, config());
    assert.equal(transports[0]!.closed, false);
  }
  assert.equal(transports[0]!.closed, true);
});

test("a concurrent acquire with a different config waits and connects with its own", async (t) => {
  const seen: string[] = [];
  await using pool = new McpServerPool({
    createTransport(target) {
      seen.push(target.config.args?.join(" ") ?? "");
      return fakeServerTransport();
    },
  });
  const root = await workspace(t);
  const base = config();
  const changed: WorkspaceMcpConfig = {
    servers: [{
      ...base.servers[0]!,
      config: { ...base.servers[0]!.config, args: [SERVER, "--page-size", "2"] },
    }],
    diagnostics: [],
  };
  const [first, second] = await Promise.all([
    pool.acquire(root, base),
    pool.acquire(root, changed),
  ]);
  assert.equal(seen.length, 2);
  assert.ok(seen[1]!.includes("--page-size"));
  assert.notEqual(first.sources[0]!.client, second.sources[0]!.client);
  // 池里留下的是最后一次配置的连接。
  const third = await pool.acquire(root, changed);
  assert.equal(third.sources[0]!.client, second.sources[0]!.client);
});
