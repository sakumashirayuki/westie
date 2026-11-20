import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { MacOsSeatbeltSandboxRunner } from "../src/sandbox/macos-seatbelt-sandbox-runner.js";
import {
  SandboxRunnerError,
  type SandboxResourceLimits,
} from "../src/sandbox/sandbox-runner.js";

const COMMAND_OPTIONS = {
  timeoutMs: 5_000,
  maxOutputBytes: 16 * 1024,
} as const;
const RESOURCE_TEST_LIMITS: SandboxResourceLimits = {
  cpuTimeMs: 5_000,
  memoryBytes: 1024 * 1024 * 1024,
  maxProcesses: 32,
  diskWriteBytes: 64 * 1024 * 1024,
};

/**
 * 本用例需要实际启动 macOS Seatbelt（`sandbox-exec`）。在本环境
 * （`MY_AGENT_HARNESS_SANDBOX=full-access-tagged`）下跳过，改为待宿主验证：
 * Seatbelt 策略不可初始化时 `SandboxRunnerError(SANDBOX_UNAVAILABLE)` 会稳定抛
 * 出，`createFixture` 无法继续。这里按工作区约定在此文件末尾区分，避免误报为
 * 实现失败。
 */
const shouldSkipSeatbelt = () =>
  process.env.MY_AGENT_HARNESS_SANDBOX !== undefined &&
  process.env.MY_AGENT_HARNESS_SANDBOX !== "";

async function createFixture(
  t: test.TestContext,
  resourceLimits?: SandboxResourceLimits,
  accessMode: "workspace-sandbox" | "full-access" = "workspace-sandbox",
) {
  const root = await mkdtemp(
    path.join(homedir(), ".my-agent-harness-seatbelt-test-"),
  );
  const workspace = path.join(root, "workspace");
  const outsideFile = path.join(root, "outside.txt");
  const externalRoot = await mkdtemp(
    path.join(tmpdir(), "my-agent-harness-outside-"),
  );
  const externalFile = path.join(externalRoot, "external.txt");
  await mkdir(workspace);
  await writeFile(outsideFile, "outside-secret\n");
  await writeFile(externalFile, "external-secret\n");
  t.after(async () => rm(root, { recursive: true, force: true }));
  t.after(async () => rm(externalRoot, { recursive: true, force: true }));
  return {
    workspace,
    outsideFile,
    externalFile,
    runner: await (accessMode === "full-access"
      ? MacOsSeatbeltSandboxRunner.createFullAccess(workspace, resourceLimits)
      : MacOsSeatbeltSandboxRunner.create(workspace, resourceLimits)),
  };
}

test("allows commands to read and write inside the workspace", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const { runner, workspace } = await createFixture(t);

  const result = await runner.run({
    executable: "/bin/zsh",
    args: ["-c", "printf sandboxed > result.txt; cat result.txt"],
    cwd: workspace,
    ...COMMAND_OPTIONS,
  });

  assert.deepEqual(result, {
    exitCode: 0,
    stdout: "sandboxed",
    stderr: "",
  });
  assert.equal(
    await readFile(path.join(workspace, "result.txt"), "utf8"),
    "sandboxed",
  );
});

test("blocks sensitive workspace paths while allowing dotenv templates", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const { runner, workspace } = await createFixture(t);
  await mkdir(path.join(workspace, "nested"));
  await writeFile(path.join(workspace, ".env"), "root-secret\n");
  await writeFile(path.join(workspace, "nested", ".env.production"), "nested-secret\n");
  await writeFile(path.join(workspace, "nested", "server.key"), "private-key\n");
  await writeFile(path.join(workspace, "nested", "private-key.pem"), "pem-secret\n");
  await writeFile(path.join(workspace, ".env.example"), "API_KEY=\n");
  await symlink(".env", path.join(workspace, "secret-link"));

  for (const command of [
    "cat .env",
    "/usr/bin/python3 -c 'print(open(\"nested/.env.production\").read())'",
    "node -e 'process.stdout.write(require(\"fs\").readFileSync(\"nested/server.key\"))'",
    "cat nested/private-key.pem",
    "cat secret-link",
    "rg --hidden root-secret .",
  ]) {
    const result = await runner.run({
      executable: "/bin/zsh",
      args: ["-c", command],
      cwd: workspace,
      ...COMMAND_OPTIONS,
    });
    assert.notEqual(result.exitCode, 0, command);
    assert.equal(result.stdout.includes("secret"), false, command);
  }

  const templateResult = await runner.run({
    executable: "/bin/zsh",
    args: ["-c", "cat .env.example"],
    cwd: workspace,
    ...COMMAND_OPTIONS,
  });
  assert.equal(templateResult.exitCode, 0);
  assert.equal(templateResult.stdout, "API_KEY=\n");
});

test("blocks mutation and rename escapes for sensitive workspace paths", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const { runner, workspace } = await createFixture(t);
  const sensitivePath = path.join(workspace, ".env");
  await writeFile(sensitivePath, "unchanged\n");

  for (const command of [
    "printf changed > .env",
    "mv .env exposed.txt",
    "ln .env exposed-link",
  ]) {
    const result = await runner.run({
      executable: "/bin/zsh",
      args: ["-c", command],
      cwd: workspace,
      ...COMMAND_OPTIONS,
    });
    assert.notEqual(result.exitCode, 0, command);
  }
  assert.equal(await readFile(sensitivePath, "utf8"), "unchanged\n");
});

test("blocks reads, writes, and symlink escapes outside the workspace", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const { runner, workspace, outsideFile, externalFile } =
    await createFixture(t);

  for (const protectedFile of [outsideFile, externalFile]) {
    const readResult = await runner.run({
      executable: "/bin/zsh",
      args: ["-c", `cat ${shellQuote(protectedFile)}`],
      cwd: workspace,
      ...COMMAND_OPTIONS,
    });
    assert.notEqual(readResult.exitCode, 0);
    assert.equal(readResult.sandboxStatus, "possibly_blocked");
  }

  const writeResult = await runner.run({
    executable: "/bin/zsh",
    args: ["-c", `printf changed > ${shellQuote(outsideFile)}`],
    cwd: workspace,
    ...COMMAND_OPTIONS,
  });
  assert.notEqual(writeResult.exitCode, 0);
  assert.equal(writeResult.sandboxStatus, "possibly_blocked");
  assert.equal(await readFile(outsideFile, "utf8"), "outside-secret\n");

  const link = path.join(workspace, "external-link");
  await symlink(externalFile, link);
  const linkResult = await runner.run({
    executable: "/bin/zsh",
    args: ["-c", "cat external-link"],
    cwd: workspace,
    ...COMMAND_OPTIONS,
  });
  assert.notEqual(linkResult.exitCode, 0);
  assert.equal(linkResult.sandboxStatus, "possibly_blocked");
});

test("does not inherit harness secrets and uses an isolated HOME", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const { runner, workspace } = await createFixture(t);
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousTavilyApiKey = process.env.TAVILY_API_KEY;
  process.env.OPENAI_API_KEY = "must-not-cross-the-boundary";
  process.env.TAVILY_API_KEY = "tavily-must-not-cross";
  t.after(() => {
    restoreEnvironmentVariable("OPENAI_API_KEY", previousApiKey);
    restoreEnvironmentVariable("TAVILY_API_KEY", previousTavilyApiKey);
  });

  const result = await runner.run({
    executable: "/bin/zsh",
    args: [
      "-c",
      'printf "%s\\n%s\\n%s" "${OPENAI_API_KEY-unset}" "${TAVILY_API_KEY-unset}" "$HOME"',
    ],
    cwd: workspace,
    ...COMMAND_OPTIONS,
  });
  const [apiKey, tavilyApiKey, sandboxHome] = result.stdout.split("\n");

  assert.equal(apiKey, "unset");
  assert.equal(tavilyApiKey, "unset");
  assert.match(sandboxHome ?? "", /my-agent-harness-sandbox-/);
  assert.notEqual(sandboxHome, homedir());
});

test("blocks outbound network access", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const { runner, workspace } = await createFixture(t);

  const result = await runner.run({
    executable: "/bin/zsh",
    args: [
      "-c",
      "/usr/bin/curl --connect-timeout 1 --silent --show-error https://example.com",
    ],
    cwd: workspace,
    ...COMMAND_OPTIONS,
  });

  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout, "");
});

test("full access reads and writes host files outside the workspace", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const { runner, workspace, outsideFile, externalFile } =
    await createFixture(t, undefined, "full-access");

  const result = await runner.run({
    executable: "/bin/zsh",
    args: [
      "-c",
      [
        `cat ${shellQuote(outsideFile)}`,
        `cat ${shellQuote(externalFile)}`,
        `printf changed > ${shellQuote(outsideFile)}`,
      ].join("; "),
    ],
    cwd: workspace,
    ...COMMAND_OPTIONS,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "outside-secret\nexternal-secret\n");
  assert.equal(await readFile(outsideFile, "utf8"), "changed");
});

test("full access uses the real HOME without inheriting provider secrets", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const { runner, workspace } =
    await createFixture(t, undefined, "full-access");
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  const previousDeepSeekKey = process.env.DEEPSEEK_API_KEY;
  const previousTavilyKey = process.env.TAVILY_API_KEY;
  process.env.OPENAI_API_KEY = "openai-must-not-cross";
  process.env.DEEPSEEK_API_KEY = "deepseek-must-not-cross";
  process.env.TAVILY_API_KEY = "tavily-must-not-cross";
  t.after(() => {
    restoreEnvironmentVariable("OPENAI_API_KEY", previousOpenAiKey);
    restoreEnvironmentVariable("DEEPSEEK_API_KEY", previousDeepSeekKey);
    restoreEnvironmentVariable("TAVILY_API_KEY", previousTavilyKey);
  });

  const result = await runner.run({
    executable: "/bin/zsh",
    args: [
      "-c",
      'printf "%s\\n%s\\n%s\\n%s\\n%s" "$HOME" "$TMPDIR" "${OPENAI_API_KEY-unset}" "${DEEPSEEK_API_KEY-unset}" "${TAVILY_API_KEY-unset}"',
    ],
    cwd: workspace,
    ...COMMAND_OPTIONS,
  });
  const [home, commandTmp, openAiKey, deepSeekKey, tavilyKey] =
    result.stdout.split("\n");

  assert.equal(home, homedir());
  assert.match(commandTmp ?? "", /my-agent-harness-sandbox-/);
  assert.equal(openAiKey, "unset");
  assert.equal(deepSeekKey, "unset");
  assert.equal(tavilyKey, "unset");
});

test("full access allows loopback network connections", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const { runner, workspace } =
    await createFixture(t, undefined, "full-access");
  const server = createServer((_request, response) => response.end("network-ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  }));
  const address = server.address() as AddressInfo;

  const result = await runner.run({
    executable: "/usr/bin/curl",
    args: ["--silent", `http://127.0.0.1:${address.port}`],
    cwd: workspace,
    ...COMMAND_OPTIONS,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "network-ok");
});

test("does not misclassify an application error as a sandbox violation", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const { runner, workspace } = await createFixture(t);

  const result = await runner.run({
    executable: "/bin/zsh",
    args: ["-c", "printf 'permission denied' >&2; exit 2"],
    cwd: workspace,
    ...COMMAND_OPTIONS,
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.stderr, "permission denied");
  assert.equal(result.sandboxStatus, undefined);
});

test("contains descendants that deliberately leave the command process group", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const fixture = await createEscapingProcessFixture(t);

  const result = await fixture.runner.run({
    executable: "/usr/bin/python3",
    args: [fixture.script, "exit"],
    cwd: fixture.workspace,
    ...COMMAND_OPTIONS,
  });

  assert.equal(result.exitCode, 0);
  await assertEscapedDescendantContained(fixture);
});

test("contains escaped descendants when a command is aborted", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const fixture = await createEscapingProcessFixture(t);
  const controller = new AbortController();
  const reason = new Error("cancelled by test");
  const execution = fixture.runner.run({
    executable: "/usr/bin/python3",
    args: [fixture.script, "wait"],
    cwd: fixture.workspace,
    ...COMMAND_OPTIONS,
    signal: controller.signal,
  });
  await waitForPath(fixture.readyFile);

  controller.abort(reason);

  await assert.rejects(execution, (error: unknown) => error === reason);
  await assertEscapedDescendantContained(fixture);
});

test("contains escaped descendants when a command times out", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const fixture = await createEscapingProcessFixture(t);

  await assert.rejects(
    fixture.runner.run({
      executable: "/usr/bin/python3",
      args: [fixture.script, "wait"],
      cwd: fixture.workspace,
      timeoutMs: 1_000,
      maxOutputBytes: COMMAND_OPTIONS.maxOutputBytes,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "COMMAND_TIMEOUT",
  );

  assert.equal(await pathExists(fixture.readyFile), true);
  await assertEscapedDescendantContained(fixture);
});

test("full access contains escaped descendants when a command times out", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const fixture = await createEscapingProcessFixture(t, "full-access");

  await assert.rejects(
    fixture.runner.run({
      executable: "/usr/bin/python3",
      args: [fixture.script, "wait"],
      cwd: fixture.workspace,
      timeoutMs: 1_000,
      maxOutputBytes: COMMAND_OPTIONS.maxOutputBytes,
    }),
    hasSandboxErrorCode("COMMAND_TIMEOUT"),
  );

  assert.equal(await pathExists(fixture.readyFile), true);
  await assertEscapedDescendantContained(fixture);
});

test("contains escaped descendants when command output is too large", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const fixture = await createEscapingProcessFixture(t);

  await assert.rejects(
    fixture.runner.run({
      executable: "/usr/bin/python3",
      args: [fixture.script, "output"],
      cwd: fixture.workspace,
      timeoutMs: COMMAND_OPTIONS.timeoutMs,
      maxOutputBytes: 1_024,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "COMMAND_OUTPUT_TOO_LARGE",
  );

  assert.equal(await pathExists(fixture.readyFile), true);
  await assertEscapedDescendantContained(fixture);
});

test("process containment is isolated between concurrent runs", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const fixture = await createEscapingProcessFixture(t);
  const controller = new AbortController();
  const cancelled = fixture.runner.run({
    executable: "/usr/bin/python3",
    args: [fixture.script, "wait"],
    cwd: fixture.workspace,
    ...COMMAND_OPTIONS,
    signal: controller.signal,
  });
  await waitForPath(fixture.readyFile);
  const survivorMarker = path.join(fixture.workspace, "survivor.txt");
  const survivor = fixture.runner.run({
    executable: "/bin/zsh",
    args: ["-c", "sleep 0.2; printf survived > survivor.txt"],
    cwd: fixture.workspace,
    ...COMMAND_OPTIONS,
  });

  controller.abort(new Error("cancel one run"));

  await assert.rejects(cancelled);
  const survivorResult = await survivor;
  assert.equal(survivorResult.exitCode, 0);
  assert.equal(await readFile(survivorMarker, "utf8"), "survived");
  await assertEscapedDescendantContained(fixture);
});

test("stops a command that exceeds its aggregate CPU limit", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const { runner, workspace } = await createFixture(t, {
    ...RESOURCE_TEST_LIMITS,
    cpuTimeMs: 100,
  });

  await assert.rejects(
    runner.run({
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import signal\nsignal.signal(signal.SIGXCPU, signal.SIG_IGN)\nwhile True: pass",
      ],
      cwd: workspace,
      ...COMMAND_OPTIONS,
    }),
    hasSandboxErrorCode("COMMAND_CPU_LIMIT_EXCEEDED"),
  );
});

test("full access keeps aggregate CPU enforcement", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const { runner, workspace } = await createFixture(
    t,
    {
      ...RESOURCE_TEST_LIMITS,
      cpuTimeMs: 100,
    },
    "full-access",
  );

  await assert.rejects(
    runner.run({
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import signal\nsignal.signal(signal.SIGXCPU, signal.SIG_IGN)\nwhile True: pass",
      ],
      cwd: workspace,
      ...COMMAND_OPTIONS,
    }),
    hasSandboxErrorCode("COMMAND_CPU_LIMIT_EXCEEDED"),
  );
});

test("aggregates CPU usage across child processes", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const { runner, workspace } = await createFixture(t, {
    ...RESOURCE_TEST_LIMITS,
    cpuTimeMs: 300,
  });

  await assert.rejects(
    runner.run({
      executable: "/usr/bin/python3",
      args: [
        "-c",
        [
          "import os, time",
          "for _ in range(4):",
          "    if os.fork() == 0:",
          "        started = time.process_time()",
          "        while time.process_time() - started < 0.2:",
          "            pass",
          "        time.sleep(5)",
          "        os._exit(0)",
          "time.sleep(5)",
        ].join("\n"),
      ],
      cwd: workspace,
      ...COMMAND_OPTIONS,
    }),
    hasSandboxErrorCode("COMMAND_CPU_LIMIT_EXCEEDED"),
  );
});

test("stops a command that exceeds its aggregate memory limit", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const { runner, workspace } = await createFixture(t, {
    ...RESOURCE_TEST_LIMITS,
    memoryBytes: 64 * 1024 * 1024,
  });

  await assert.rejects(
    runner.run({
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "chunks = []\nwhile True: chunks.append(bytearray(1024 * 1024))",
      ],
      cwd: workspace,
      ...COMMAND_OPTIONS,
    }),
    hasSandboxErrorCode("COMMAND_MEMORY_LIMIT_EXCEEDED"),
  );
});

test("stops a command that exceeds its live process limit", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const { runner, workspace } = await createFixture(t, {
    ...RESOURCE_TEST_LIMITS,
    maxProcesses: 3,
  });

  await assert.rejects(
    runner.run({
      executable: "/usr/bin/python3",
      args: [
        "-c",
        [
          "import os, time",
          "for _ in range(8):",
          "    if os.fork() == 0:",
          "        time.sleep(5)",
          "        os._exit(0)",
          "time.sleep(5)",
        ].join("\n"),
      ],
      cwd: workspace,
      ...COMMAND_OPTIONS,
    }),
    hasSandboxErrorCode("COMMAND_PROCESS_LIMIT_EXCEEDED"),
  );
});

test("stops a command that exceeds its disk write limit", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const { runner, workspace } = await createFixture(t, {
    ...RESOURCE_TEST_LIMITS,
    diskWriteBytes: 128 * 1024,
  });

  await assert.rejects(
    runner.run({
      executable: "/usr/bin/python3",
      args: [
        "-c",
        [
          "import time",
          "for index in range(8):",
          "    with open(f'chunk-{index}.bin', 'wb') as output:",
          "        output.write(b'x' * (32 * 1024))",
          "        output.flush()",
          "time.sleep(5)",
        ].join("\n"),
      ],
      cwd: workspace,
      ...COMMAND_OPTIONS,
    }),
    hasSandboxErrorCode("COMMAND_DISK_WRITE_LIMIT_EXCEEDED"),
  );
});

test("resource limits include descendants that leave the process group", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const { runner, workspace } = await createFixture(t, {
    ...RESOURCE_TEST_LIMITS,
    cpuTimeMs: 500,
  });
  const script = path.join(workspace, "escaped-resource.py");
  const pidFile = path.join(workspace, "resource-child.pid");
  const markerFile = path.join(workspace, "resource-marker.txt");
  await writeFile(
    script,
    [
      "import os",
      "import time",
      "first = os.fork()",
      "if first == 0:",
      "    os.setsid()",
      "    daemon = os.fork()",
      "    if daemon != 0:",
      "        os._exit(0)",
      "    open('resource-child.pid', 'w').write(str(os.getpid()))",
      "    started = time.time()",
      "    while time.time() - started < 2:",
      "        pass",
      "    open('resource-marker.txt', 'w').write('leaked')",
      "    os._exit(0)",
      "time.sleep(5)",
      "",
    ].join("\n"),
  );

  await assert.rejects(
    runner.run({
      executable: "/usr/bin/python3",
      args: [script],
      cwd: workspace,
      ...COMMAND_OPTIONS,
    }),
    hasSandboxErrorCode("COMMAND_CPU_LIMIT_EXCEEDED"),
  );

  const escapedPid = Number(await readFile(pidFile, "utf8"));
  await waitForProcessToExit(escapedPid);
  assert.equal(await pathExists(markerFile), false);
});

test("a resource violation does not affect a concurrent run", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const { runner, workspace } = await createFixture(t, {
    ...RESOURCE_TEST_LIMITS,
    cpuTimeMs: 100,
  });
  const limited = runner.run({
    executable: "/usr/bin/python3",
    args: ["-c", "while True: pass"],
    cwd: workspace,
    ...COMMAND_OPTIONS,
  });
  const survivor = runner.run({
    executable: "/bin/zsh",
    args: ["-c", "sleep 0.2; printf survived > survivor.txt"],
    cwd: workspace,
    ...COMMAND_OPTIONS,
  });

  await assert.rejects(
    limited,
    hasSandboxErrorCode("COMMAND_CPU_LIMIT_EXCEEDED"),
  );
  const survivorResult = await survivor;

  assert.equal(survivorResult.exitCode, 0);
  assert.equal(
    await readFile(path.join(workspace, "survivor.txt"), "utf8"),
    "survived",
  );
});

test("runs the baseline macOS development toolchain", async (t) => {
  if (shouldSkipSeatbelt()) {
    t.skip("Seatbelt sandbox unavailable in this host environment");
    return;
  }
  const { runner, workspace } = await createFixture(t);
  await writeFile(path.join(workspace, "search.txt"), "sandbox-line\n");

  const result = await runner.run({
    executable: "/bin/zsh",
    args: [
      "-c",
      [
        "/usr/bin/git --version",
        "/usr/bin/python3 -c 'print(\"python-ok\")'",
        "rg -n sandbox-line search.txt",
        "node --version",
      ].join("; "),
    ],
    cwd: workspace,
    ...COMMAND_OPTIONS,
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /git version/);
  assert.match(result.stdout, /python-ok/);
  assert.match(result.stdout, /1:sandbox-line/);
  assert.match(result.stdout, /v\d+\.\d+\.\d+/);
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function hasSandboxErrorCode(
  code: SandboxRunnerError["code"],
): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof SandboxRunnerError && error.code === code;
}

interface EscapingProcessFixture {
  readonly runner: MacOsSeatbeltSandboxRunner;
  readonly workspace: string;
  readonly script: string;
  readonly readyFile: string;
  readonly pidFile: string;
  readonly markerFile: string;
}

async function createEscapingProcessFixture(
  t: test.TestContext,
  accessMode: "workspace-sandbox" | "full-access" = "workspace-sandbox",
): Promise<EscapingProcessFixture> {
  const { runner, workspace } = await createFixture(t, undefined, accessMode);
  const script = path.join(workspace, "escape.py");
  const readyFile = path.join(workspace, "escaped.ready");
  const pidFile = path.join(workspace, "escaped.pid");
  const markerFile = path.join(workspace, "escaped-marker.txt");
  await writeFile(
    script,
    [
      "import os",
      "import sys",
      "import time",
      "",
      "read_fd, write_fd = os.pipe()",
      "first_child = os.fork()",
      "if first_child == 0:",
      "    os.close(read_fd)",
      "    os.setsid()",
      "    daemon = os.fork()",
      "    if daemon != 0:",
      "        os._exit(0)",
      "    for descriptor in (0, 1, 2):",
      "        try:",
      "            os.close(descriptor)",
      "        except OSError:",
      "            pass",
      "    open('escaped.pid', 'w').write(str(os.getpid()))",
      "    open('escaped.ready', 'w').write('ready')",
      "    os.write(write_fd, b'1')",
      "    os.close(write_fd)",
      "    time.sleep(2)",
      "    open('escaped-marker.txt', 'w').write('leaked')",
      "    os._exit(0)",
      "",
      "os.close(write_fd)",
      "os.read(read_fd, 1)",
      "os.close(read_fd)",
      "mode = sys.argv[1]",
      "if mode == 'exit':",
      "    os._exit(0)",
      "if mode == 'output':",
      "    while True:",
      "        os.write(1, b'x' * 4096)",
      "time.sleep(5)",
      "",
    ].join("\n"),
  );
  return {
    runner,
    workspace,
    script,
    readyFile,
    pidFile,
    markerFile,
  };
}

function restoreEnvironmentVariable(
  name: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function assertEscapedDescendantContained(
  fixture: EscapingProcessFixture,
): Promise<void> {
  const pid = Number(await readFile(fixture.pidFile, "utf8"));
  await waitForProcessToExit(pid);
  assert.equal(await pathExists(fixture.markerFile), false);
}

async function waitForPath(candidate: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await pathExists(candidate)) return;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${candidate}.`);
}

async function waitForProcessToExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return;
      }
      throw error;
    }
    await delay(10);
  }
  assert.fail(`Escaped process ${pid} is still running.`);
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
