import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openSqliteDatabase } from "../src/infrastructure/sqlite/index.js";
import { HostSandboxRunner } from "../src/sandbox/host-sandbox-runner.js";
import {
  startAgentServer,
  type RunningAgentServer,
} from "../src/server-bootstrap.js";

const SHUTDOWN_TIMEOUT_MS = 8_000;
const PROVIDER_HOST = "api.deepseek.com";

// node --test 为每个测试文件单独起进程，这里改 process.env 和 globalThis.fetch
// 不会影响其他测试文件。信号处理已移到 server-main.ts，装配层只返回关闭句柄，
// 因此用例直接等待 startAgentServer() 返回的 close()，不再 process.emit("SIGTERM")。
test("shutdown cancels an in-flight run and persists it before closing the database", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agent-shutdown-")),
  );
  const databasePath = join(directory, "agent.sqlite");
  const port = await findFreePort();
  Object.assign(process.env, {
    HOME: directory,
    HOST: "127.0.0.1",
    PORT: String(port),
    AGENT_DATABASE_PATH: databasePath,
    AGENT_MODEL_CONTEXT_TOKENS: "64000",
    AGENT_MODEL_MAX_OUTPUT_TOKENS: "4000",
    LLM_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-key",
    DEEPSEEK_MODEL: "deepseek-test",
    TAVILY_API_KEY: "test-key",
  });

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
      sandboxRunnerFactory: async () => new HostSandboxRunner(),
      hostDirectoryPicker: {
        async pickDirectory() {
          return { status: "selected", path: directory };
        },
      },
    });
    const origin = `http://127.0.0.1:${port}`;

    // 侧栏的 runs:watch 长连接：之前的 shutdown 就是等它结束而卡死的。
    const watch = await realFetch(`${origin}/v1/agent/runs:watch`, {
      signal: clients.signal,
    });
    assert.equal(watch.status, 200);

    const inspected = await realFetch(
      `${origin}/v1/agent/conversations:select-workspace`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "inspect" }),
      },
    );
    assert.equal(inspected.status, 200);
    const { selectionToken } = await inspected.json() as { selectionToken: string };
    const created = await realFetch(`${origin}/v1/agent/conversations:open`, {
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
      `${origin}/v1/agent/conversations/${conversationId}/runs:stream`,
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
    assert.equal(readRun(databasePath, runId).status, "running");

    // 关闭在进程内可能先写入终态、后关库；close() 返回时清理全部完成。
    const closing = server.close();
    const persisted = await waitFor(
      () => {
        const row = readRun(databasePath, runId);
        return row.status === "running" ? undefined : row;
      },
      SHUTDOWN_TIMEOUT_MS,
    );
    assert.deepEqual(persisted, { status: "cancelled", activeRunId: null });
    await closing;
    // 残留连接已被关闭、服务不再接受连接、数据库已关闭并可重新打开。
    await assert.rejects(realFetch(`${origin}/v1/agent/conversations`));
    readRun(databasePath, runId);
  } finally {
    clients.abort();
    globalThis.fetch = realFetch;
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`eval server closes gracefully on ${signal}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "eval-shutdown-"));
    const port = await findFreePort();
    const child = spawn(process.execPath, ["scripts/eval-server.mjs", directory], {
      env: {
        ...process.env,
        HOME: directory,
        HOST: "127.0.0.1",
        PORT: String(port),
        AGENT_DATABASE_PATH: join(directory, "agent.sqlite"),
        AGENT_MODEL_CONTEXT_TOKENS: "64000",
        AGENT_MODEL_MAX_OUTPUT_TOKENS: "4000",
        LLM_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_MODEL: "deepseek-test",
        TAVILY_API_KEY: "test-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    try {
      await waitFor(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Eval server exited before ready: ${output}`);
        }
        return output.includes("Eval server:") ? true : undefined;
      }, SHUTDOWN_TIMEOUT_MS);
      child.kill(signal);
      const result = await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          const timeout = setTimeout(() => reject(new Error("Eval shutdown timed out")), SHUTDOWN_TIMEOUT_MS);
          timeout.unref();
          void closed.then(() => clearTimeout(timeout));
        }),
      ]);
      assert.deepEqual(result, [0, null], output);
      await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/agent/conversations`));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      await rm(directory, { recursive: true, force: true });
    }
  });
}

function readRun(databasePath: string, runId: string) {
  const database = openSqliteDatabase(databasePath);
  try {
    const run = database.prepare(
      "SELECT status FROM runs WHERE id = $runId",
    ).get({ "$runId": runId });
    const conversation = database.prepare(
      "SELECT active_run_id FROM conversations",
    ).get();
    return {
      status: run?.status,
      activeRunId: conversation?.active_run_id,
    };
  } finally {
    database.close();
  }
}

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`condition not met within ${timeoutMs}ms (shutdown hung?)`);
}

async function findFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
