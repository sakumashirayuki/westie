import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { ToolExecutionError } from "../src/tools.js";
import { HostSandboxRunner } from "../src/sandbox/host-sandbox-runner.js";
import { createBashTool } from "../src/tools/bash.js";

async function createWorkspace(t: test.TestContext): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "bash-tool-"));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

/** 后台进程存活到远超单个测试的时长，因此它写出 marker 只可能是清理失败。 */
const BACKGROUND_LIFETIME_SECONDS = 30;
const OBSERVE_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 10;

/**
 * 起一个后台子进程：先由父 shell 记下它的 PID，子进程长睡后才写 marker。
 * 测试据此等到进程确实起来、再断言它被杀掉，而不依赖固定的时间窗口。
 */
function backgroundCommand(options: { readonly detached: boolean }): string {
  const subshell = `(sleep ${BACKGROUND_LIFETIME_SECONDS}; printf leaked > marker.txt)`;
  const spawn = options.detached
    ? `${subshell} >/dev/null 2>&1 &`
    : `${subshell} &`;
  const recordPid = 'printf %s "$!" > pid.txt';
  return options.detached
    ? `${spawn} ${recordPid}`
    : `${spawn} ${recordPid}; wait`;
}

async function readBackgroundPid(workspace: string): Promise<number> {
  const deadline = Date.now() + OBSERVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(
        (await readFile(path.join(workspace, "pid.txt"), "utf8")).trim(),
        10,
      );
      if (Number.isSafeInteger(pid) && pid > 1) return pid;
    } catch {
      // pid.txt 还没写出来，继续等。
    }
    await delay(POLL_INTERVAL_MS);
  }
  return assert.fail("The background process never recorded its PID.");
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + OBSERVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await delay(POLL_INTERVAL_MS);
  }
  assert.fail(
    `Background process ${pid} was still alive after ${OBSERVE_TIMEOUT_MS}ms; ` +
      "the process group was not cleaned up.",
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但不属于当前用户；只有 ESRCH 才是真的没了。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function assertMissing(filePath: string): Promise<void> {
  await assert.rejects(
    access(filePath),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

test("captures stdout, stderr, and a non-zero exit code", async (t) => {
  const tool = createBashTool(
    await createWorkspace(t),
    new HostSandboxRunner(),
  );

  const result = await tool.execute(
    { command: "printf 'hello'; printf 'warning' >&2; exit 7" },
    {},
  );

  assert.deepEqual(result, {
    exitCode: 7,
    stdout: "hello",
    stderr: "warning",
  });
});

test("runs commands from the real workspace root", async (t) => {
  const workspace = await createWorkspace(t);
  const tool = createBashTool(workspace, new HostSandboxRunner());

  const result = await tool.execute({ command: "pwd" }, {});

  assert.equal(
    (result as { stdout: string }).stdout.trim(),
    await realpath(workspace),
  );
});

test("can search workspace files with rg", async (t) => {
  const workspace = await createWorkspace(t);
  await writeFile(path.join(workspace, "example.txt"), "find-this-line\n");
  const tool = createBashTool(workspace, new HostSandboxRunner());

  const result = await tool.execute(
    { command: "rg -n 'find-this-line' ." },
    {},
  );

  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "./example.txt:1:find-this-line\n",
    stderr: "",
  });
});

test("rejects commands that exceed their timeout", async (t) => {
  const tool = createBashTool(
    await createWorkspace(t),
    new HostSandboxRunner(),
  );

  await assert.rejects(
    tool.execute({ command: "sleep 5", timeoutMs: 100 }, {}),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.code === "COMMAND_TIMEOUT",
  );
});

test("rejects commands whose combined output exceeds the limit", async (t) => {
  const tool = createBashTool(
    await createWorkspace(t),
    new HostSandboxRunner(),
  );

  await assert.rejects(
    tool.execute({ command: "yes output" }, {}),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.code === "COMMAND_OUTPUT_TOO_LARGE",
  );
});

test("aborts the process group and preserves the abort reason", async (t) => {
  const workspace = await createWorkspace(t);
  const tool = createBashTool(workspace, new HostSandboxRunner());
  const controller = new AbortController();
  const reason = new Error("cancelled by test");

  const execution = tool.execute(
    { command: backgroundCommand({ detached: false }) },
    { signal: controller.signal },
  );
  const pid = await readBackgroundPid(workspace);
  controller.abort(reason);

  await assert.rejects(execution, (error: unknown) => error === reason);
  await waitForProcessExit(pid);
  await assertMissing(path.join(workspace, "marker.txt"));
});

test("cleans up detached background processes after the shell exits", async (t) => {
  const workspace = await createWorkspace(t);
  const tool = createBashTool(workspace, new HostSandboxRunner());

  await tool.execute(
    { command: backgroundCommand({ detached: true }) },
    {},
  );

  await waitForProcessExit(await readBackgroundPid(workspace));
  await assertMissing(path.join(workspace, "marker.txt"));
});
