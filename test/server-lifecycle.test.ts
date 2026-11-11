import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { HostDirectoryPicker } from "../src/infrastructure/host-file-picker.js";
import { openSqliteDatabase } from "../src/infrastructure/sqlite/index.js";
import { HostSandboxRunner } from "../src/sandbox/host-sandbox-runner.js";
import {
  startAgentServer,
  type RunningAgentServer,
} from "../src/server-bootstrap.js";

const PROVIDER_HOST = "api.deepseek.com";

// node --test 为每个测试文件单独起进程，这里改 process.env 与 globalThis.fetch
// 不会影响其他测试文件。工具沙箱换成宿主机执行，目录选择器固定选回临时 HOME，
// 用例只验证宿主生命周期，不依赖本机 sandbox-exec 与系统窗口。
test("listening on port 0 returns a reachable url and close is idempotent", async () => {
  const directory = await prepareEnvironment();

  let server: RunningAgentServer | undefined;
  try {
    server = await startAgentServer({
      port: 0,
      sandboxRunnerFactory: async () => new HostSandboxRunner(),
      hostDirectoryPicker: pickWorkspace(directory),
    });

    // 端口由操作系统分配：URL 与实际监听地址一致，且不是配置端口。
    const url = new URL(server.url);
    assert.equal(url.protocol, "http:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.match(url.port, /^\d+$/);
    assert.notEqual(Number(url.port), 3000);
    const response = await fetch(`${server.url}/v1/agent/conversations`);
    assert.equal(response.status, 200);
    await response.text();

    // 两次 close 返回同一个 Promise。
    const first = server.close();
    const second = server.close();
    assert.equal(first, second);
    await first;

    // 关闭后端口释放、SQLite 可再次打开。
    await assert.rejects(fetch(`${server.url}/v1/agent/conversations`));
    openDatabase(join(directory, "agent.sqlite")).close();
  } finally {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("close cancels an in-flight run and persists its terminal state", async () => {
  const directory = await prepareEnvironment();

  // 去 provider 的请求一直挂着，只有被 abort 才结束：Run 停在模型调用里。
  const realFetch = globalThis.fetch;
  let providerRequested!: () => void;
  const providerRequest = new Promise<void>((resolve) => {
    providerRequested = resolve;
  });
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== PROVIDER_HOST) return realFetch(input, init);
    providerRequested();
    const signal = init?.signal ??
      (input instanceof Request ? input.signal : undefined);
    return new Promise<Response>((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };

  const clients = new AbortController();
  let server: RunningAgentServer | undefined;
  try {
    server = await startAgentServer({
      port: 0,
      sandboxRunnerFactory: async () => new HostSandboxRunner(),
      hostDirectoryPicker: pickWorkspace(directory),
    });
    const inspected = await realFetch(
      `${server.url}/v1/agent/conversations:select-workspace`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "inspect" }),
      },
    );
    assert.equal(inspected.status, 200);
    const { selectionToken } = await inspected.json() as { selectionToken: string };
    const created = await realFetch(`${server.url}/v1/agent/conversations:open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selectionToken,
        executionMode: "workspace_sandbox",
        workspace: { kind: "selected_directory" },
      }),
    });
    assert.equal(created.status, 201);
    const { id: conversationId } = await created.json() as { id: string };

    const run = await realFetch(
      `${server.url}/v1/agent/conversations/${conversationId}/runs:stream`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "hello" }),
        signal: clients.signal,
      },
    );
    assert.equal(run.status, 200);
    const runId = run.headers.get("x-run-id");
    assert.ok(runId);
    await Promise.race([
      providerRequest,
      run.text().then((body) => {
        throw new Error(`run ended before reaching the provider:\n${body}`);
      }),
    ]);

    await server.close();

    // Run 收到取消并写入终态；连接与数据库都已释放。
    const database = openDatabase(join(directory, "agent.sqlite"));
    try {
      const row = database.prepare(
        "SELECT status FROM runs WHERE id = $runId",
      ).get({ "$runId": runId });
      assert.equal(row?.status, "cancelled");
      const conversation = database.prepare(
        "SELECT active_run_id FROM conversations",
      ).get();
      assert.equal(conversation?.active_run_id, null);
    } finally {
      database.close();
    }
    await assert.rejects(fetch(`${server.url}/v1/agent/conversations`));
  } finally {
    clients.abort();
    globalThis.fetch = realFetch;
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

/** 临时 HOME、可写数据库和固定 Provider 配置；目录选择器固定选择 workspace 子目录。 */
async function prepareEnvironment(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agent-lifecycle-")),
  );
  Object.assign(process.env, {
    HOME: directory,
    HOST: "127.0.0.1",
    AGENT_DATABASE_PATH: join(directory, "agent.sqlite"),
    AGENT_MODEL_CONTEXT_TOKENS: "64000",
    AGENT_MODEL_MAX_OUTPUT_TOKENS: "4000",
    LLM_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-key",
    DEEPSEEK_MODEL: "deepseek-test",
    TAVILY_API_KEY: "test-key",
  });
  return directory;
}

/**
 * 选择工作区的接口会调用宿主目录选择器。测试固定选回临时 HOME 目录，
 * 避免触发 /usr/bin/osascript 弹出真实系统窗口并阻塞用例。
 */
function pickWorkspace(directory: string): HostDirectoryPicker {
  return {
    async pickDirectory() {
      return { status: "selected", path: directory };
    },
  };
}

function openDatabase(databasePath: string) {
  return openSqliteDatabase(databasePath);
}
