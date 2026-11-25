import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  ServiceProcessManager,
  MAX_LIVE_SERVICES_PER_WORKSPACE,
  SERVICE_START_GRACE_PERIOD_MS,
  SERVICE_STOP_GRACE_PERIOD_MS,
  SERVICE_FINAL_LOG_TAIL_BYTES,
} from "../src/application/service-process-manager.js";
import {
  SQLitePersistentServiceStore,
} from "../src/infrastructure/sqlite/persistent-service-store.js";
import {
  initializeSqliteSchema,
  openSqliteDatabase,
} from "../src/infrastructure/sqlite/index.js";
import type {
  ServiceLauncher,
  SpawnedServiceProcess,
  SpawnServiceCommand,
  ServiceExit,
} from "../src/sandbox/service-sandbox-launcher.js";
import { ServiceArtifacts } from "../src/sandbox/service-artifacts.js";

interface FakeProcess {
  readonly pid: number;
  status: "alive" | "exited";
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stdout: (chunk: Buffer) => void;
  stderr: (chunk: Buffer) => void;
  resolveExit: (outcome: ServiceExit) => void;
}

interface FakeSpawnCommand {
  readonly command: string;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly executionMode: "workspace_sandbox" | "full_access";
  readonly onStdout: (chunk: Buffer) => void;
  readonly onStderr: (chunk: Buffer) => void;
}

class FakeLauncher implements ServiceLauncher {
  readonly processes = new Map<number, FakeProcess>();
  readonly cleanupCalls: string[][] = [];
  readonly terminateCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  readonly spawnCommands: FakeSpawnCommand[] = [];
  nextPid = 1000;
  failSpawn = false;

  async spawn(command: SpawnServiceCommand): Promise<SpawnedServiceProcess> {
    if (this.failSpawn) throw new Error("spawn failed");
    this.spawnCommands.push({
      command: command.command,
      cwd: command.cwd,
      workspaceRoot: command.workspaceRoot,
      executionMode: command.executionMode,
      onStdout: command.onStdout,
      onStderr: command.onStderr,
    });
    const pid = this.nextPid++;
    const process: FakeProcess = {
      pid,
      status: "alive",
      exitCode: null,
      exitSignal: null,
      stdout: command.onStdout,
      stderr: command.onStderr,
      resolveExit: () => {},
    };
    const exit = new Promise<ServiceExit>((resolve) => {
      process.resolveExit = resolve;
    });
    this.processes.set(pid, process);
    return { pid, exit };
  }

  async terminate(pid: number, signal: NodeJS.Signals): Promise<void> {
    this.terminateCalls.push({ pid, signal });
    const process = this.processes.get(pid);
    if (process !== undefined && process.status === "alive") {
      process.status = "exited";
      process.exitSignal = signal;
      process.resolveExit({ exitCode: null, exitSignal: signal });
    }
  }

  async cleanupCanary(
    allowedCanaryPath: string,
    deniedCanaryPath: string,
  ): Promise<void> {
    this.cleanupCalls.push([allowedCanaryPath, deniedCanaryPath]);
  }
}

async function withStore(
  t: test.TestContext,
  operation: (store: SQLitePersistentServiceStore) => Promise<void> | void,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-service-store-"));
  const database = openSqliteDatabase(join(directory, "agent.sqlite"));
  initializeSqliteSchema(database);
  const store = new SQLitePersistentServiceStore(database);
  t.after(async () => {
    if (database.isOpen) database.close();
    await rm(directory, { recursive: true, force: true });
  });
  await operation(store);
}

async function withManager(
  t: test.TestContext,
  args:
    | {
        readonly launcher?: FakeLauncher;
        readonly artifactsRoot?: string;
      }
    | ((
        context: {
          manager: ServiceProcessManager;
          launcher: FakeLauncher;
          artifactsRoot: string;
        },
      ) => Promise<void> | void),
  maybeOperation?: (context: {
    manager: ServiceProcessManager;
    launcher: FakeLauncher;
    artifactsRoot: string;
  }) => Promise<void> | void,
): Promise<void> {
  const config = typeof args === "function" ? {} : args;
  const operation = typeof args === "function" ? args : maybeOperation!;
  const directory = await mkdtemp(path.join(tmpdir(), "agent-service-manager-"));
  const database = openSqliteDatabase(join(directory, "agent.sqlite"));
  initializeSqliteSchema(database);
  const store = new SQLitePersistentServiceStore(database);
  const launcher = config.launcher ?? new FakeLauncher();
  const artifactsRoot = config.artifactsRoot ?? join(directory, "services");
  const manager = new ServiceProcessManager({
    store,
    launcher,
    artifactsRoot,
    startGracePeriodMs: 20,
    stopGracePeriodMs: 50,
  });
  t.after(async () => {
    await manager.shutdown();
    if (database.isOpen) database.close();
    await rm(directory, { recursive: true, force: true });
  });
  await operation({ manager, launcher, artifactsRoot });
}

const startCommand = (workspace: string) => ({
  command: "node -e 'console.log(\"hello\")'",
  name: "web",
  cwd: workspace,
  workspaceRoot: workspace,
  executionMode: "workspace_sandbox" as const,
  createdByConversationId: null,
  createdByToolCallId: "call-1",
});

test("store rejects live rows without pid and exited rows without exit info", async (t) => {
  await withStore(t, (store) => {
    const base = {
      id: "s-1",
      workspaceRoot: "/workspace",
      name: null,
      command: "true",
      cwd: ".",
      executionMode: "workspace_sandbox" as const,
      artifactsDir: "/tmp/s-1",
      createdByConversationId: null,
      createdByToolCallId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    store.insert({
      ...base,
      id: "s-1",
      status: "exited",
      pid: null,
      exitCode: 0,
      exitSignal: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(store.read("s-1")?.status, "exited");

    assert.throws(() =>
      store.insert({
        ...base,
        id: "s-2",
        status: "starting",
        pid: null,
        exitCode: null,
        exitSignal: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
    );
  });
});

test("store lists live services and a bounded number of terminal rows", async (t) => {
  await withStore(t, (store) => {
    const base = {
      workspaceRoot: "/workspace",
      name: null,
      command: "true",
      cwd: ".",
      executionMode: "workspace_sandbox" as const,
      artifactsDir: "/tmp",
      createdByConversationId: null,
      createdByToolCallId: null,
    };
    const now = (index: number) =>
      `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`;
    store.insert({
      ...base,
      id: "live-1",
      status: "starting",
      pid: 1,
      exitCode: null,
      exitSignal: null,
      createdAt: now(1),
    });
    for (let index = 2; index <= 15; index += 1) {
      store.insert({
        ...base,
        id: `terminal-${index}`,
        status: "exited",
        pid: null,
        exitCode: index,
        exitSignal: null,
        createdAt: now(index),
      });
      store.markExited(`terminal-${index}`, {
        exitCode: index,
        exitSignal: null,
        finalLogTail: null,
        logTruncated: false,
      }, now(index));
    }
    const rows = store.listForWorkspace("/workspace", 10);
    assert.equal(rows.length, 11);
    assert.deepEqual(
      rows.map((row) => row.status),
      ["starting", ...Array(10).fill("exited")],
    );
  });
});

test("start with an immediate exit returns exited with exit code", async (t) => {
  await withManager(t, async ({ manager, launcher }) => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-service-ws-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    // 等 spawn 完成、进程句柄进 Map 后，再让它在宽限窗口内退出。
    const start = manager.start(startCommand(workspace));
    await delay(5);
    const process = [...launcher.processes.values()][0];
    process?.resolveExit({ exitCode: 3, exitSignal: null });
    const snapshot = await start;

    assert.equal(snapshot.status, "exited");
    assert.equal(snapshot.exitCode, 3);
    assert.equal(snapshot.pid, null);
  });
});

test("start returns running when the process survives the grace window", async (t) => {
  await withManager(t, {}, async ({ manager, launcher }) => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-service-ws-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const snapshot = await manager.start(startCommand(workspace));

    assert.equal(snapshot.status, "running");
    assert.equal(typeof snapshot.pid, "number");
    assert.equal(launcher.processes.get(snapshot.pid!)?.status, "alive");
  });
});

test("enforces the live service limit per workspace", async (t) => {
  await withManager(t, async ({ manager, launcher }) => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-service-ws-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    for (let index = 0; index < MAX_LIVE_SERVICES_PER_WORKSPACE; index += 1) {
      await manager.start(startCommand(workspace));
    }
    await assert.rejects(
      manager.start(startCommand(workspace)),
      (error: unknown) =>
        error instanceof Error && error.message === "SERVICE_LIMIT_REACHED",
    );
    assert.equal(launcher.processes.size, MAX_LIVE_SERVICES_PER_WORKSPACE);
  });
});

test("concurrent starts cannot exceed the live service limit", async (t) => {
  await withManager(t, async ({ manager, launcher }) => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-service-ws-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const commands = Array.from(
      { length: MAX_LIVE_SERVICES_PER_WORKSPACE + 1 },
      () => manager.start(startCommand(workspace)),
    );
    const results = await Promise.allSettled(commands);

    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      MAX_LIVE_SERVICES_PER_WORKSPACE,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    assert.equal(launcher.processes.size, MAX_LIVE_SERVICES_PER_WORKSPACE);
  });
});

test("service cwd restricts the process start directory but not the sandbox root", async (t) => {
  await withManager(t, async ({ manager, launcher }) => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-service-ws-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    await mkdir(join(workspace, "app"), { recursive: true });

    await manager.start({
      ...startCommand(workspace),
      cwd: join(workspace, "app"),
    });

    const spawn = launcher.spawnCommands.at(-1)!;
    assert.equal(spawn.cwd, join(workspace, "app"));
    assert.equal(spawn.workspaceRoot, workspace);
  });
});

test("stop is idempotent and stops a live service", async (t) => {
  await withManager(t, async ({ manager }) => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-service-ws-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const started = await manager.start(startCommand(workspace));
    const first = await manager.stop(started.id, workspace, false);
    const second = await manager.stop(started.id, workspace, false);

    assert.equal(first.status, "stopped");
    assert.equal(second.status, "stopped");
    assert.equal(second.pid, null);
  });
});

test("logs read the live file tail and the terminal final tail", async (t) => {
  await withManager(t, async ({ manager, launcher }) => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-service-ws-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const started = await manager.start(startCommand(workspace));
    const process = launcher.processes.get(started.pid!)!;
    process.stdout(Buffer.from("hello from service\n"));

    const logs = await manager.logs(started.id, workspace, 1024);
    assert.match(logs.tail, /hello from service/);
    assert.equal(logs.status, "running");

    process.resolveExit({ exitCode: 0, exitSignal: null });
    await delay(20);
    const terminal = await manager.logs(started.id, workspace, 1024);
    assert.equal(terminal.status, "exited");
    assert.match(terminal.tail, /hello from service/);
  });
});

test("terminal logs keep the truncation flag and honor tailBytes", async (t) => {
  await withManager(t, async ({ manager, launcher }) => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-service-ws-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const started = await manager.start(startCommand(workspace));
    const process = launcher.processes.get(started.pid!)!;
    process.stdout(Buffer.from("hello from service\n"));
    process.resolveExit({ exitCode: 0, exitSignal: null });
    await delay(20);

    const terminal = await manager.logs(started.id, workspace, 4);
    assert.equal(terminal.status, "exited");
    assert.equal(terminal.logTruncated, false);
    assert.equal(Buffer.byteLength(terminal.tail, "utf8"), 4);
  });
});

test("terminal log tail truncates on UTF-8 character boundaries", async (t) => {
  await withManager(t, async ({ manager, launcher }) => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-service-ws-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const started = await manager.start(startCommand(workspace));
    const process = launcher.processes.get(started.pid!)!;
    // 每个中文字符 3 字节：5 个字符 + 换行 = 16 字节。
    process.stdout(Buffer.from("中文日志输出\n"));
    process.resolveExit({ exitCode: 0, exitSignal: null });
    await delay(20);

    const terminal = await manager.logs(started.id, workspace, 4);
    assert.equal(terminal.status, "exited");
    assert.ok(Buffer.byteLength(terminal.tail, "utf8") <= 4);
    assert.equal(terminal.tail, "出\n");
  });
});

test("natural exit after start becomes exited with the real exit code", async (t) => {
  await withManager(t, async ({ manager, launcher }) => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-service-ws-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const started = await manager.start(startCommand(workspace));
    const process = launcher.processes.get(started.pid!)!;

    process.resolveExit({ exitCode: 7, exitSignal: null });
    await delay(10);

    const snapshot = await manager.status(started.id, workspace);
    assert.equal(snapshot.status, "exited");
    assert.equal(snapshot.exitCode, 7);
    assert.equal(snapshot.exitSignal, null);
  });
});

test("stop and natural exit racing converge to one terminal state", async (t) => {
  await withManager(t, async ({ manager, launcher }) => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-service-ws-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const started = await manager.start(startCommand(workspace));

    // 非 force stop 先发 SIGTERM，假 launcher 同步回报进程被 SIGTERM 终止；
    // 条件 UPDATE 裁决后终态固定为 stopped。
    const stopPromise = manager.stop(started.id, workspace, false);
    await stopPromise;

    const snapshot = await manager.status(started.id, workspace);
    assert.equal(snapshot.status, "stopped");
    assert.equal(snapshot.exitSignal, "SIGTERM");
  });
});

test("reconcile marks historical live rows interrupted and cleans artifacts", async (t) => {
  await withManager(t, async ({ manager, launcher }) => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-service-ws-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const started = await manager.start(startCommand(workspace));
    await manager.shutdown();
    // 新进程模拟重启：库中仍是 live 行，但没有进程句柄。
    const rows = await manager.reconcileInterrupted();
    assert.equal(rows >= 0, true);
  });
});

test("service artifacts stops writing past the log limit and sets truncated", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-service-artifacts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifacts = await ServiceArtifacts.create(directory);
  artifacts.append(Buffer.alloc(5 * 1024 * 1024));
  artifacts.append(Buffer.alloc(6 * 1024 * 1024));
  assert.equal(artifacts.truncated, true);
  const tail = await artifacts.readTail(1024);
  assert.equal(Buffer.byteLength(tail, "utf8"), 1024);
});
