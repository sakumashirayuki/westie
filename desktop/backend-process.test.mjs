// backend-process.mjs 的进程级用例：用可控的假 Node 可执行文件验证 ready、
// 早退、超时、父通道断开与退出协调，不启动真实后端。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildBackendEnvironment,
  parseReadyUrl,
  resolveRuntimeRoot,
  startBackend,
} from "./backend-process.mjs";

// 模拟后端入口按其 basename 的行为分支：fakeNode 收到 runtime 目录下的
// desktop/backend-entry.mjs 作为参数，读取同目录的 fake-mode.json 决定行为。
const FAKE_NODE = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const entry = process.argv[2];
const modePath = join(dirname(entry), "fake-mode.json");
const mode = JSON.parse(readFileSync(modePath, "utf8"));
const send = (message) => process.send(message);
if (mode.behavior === "ready") {
  console.log("fake backend started");
}
if (mode.behavior === "early-exit") {
  console.error("boom");
  process.exit(3);
}
if (mode.behavior === "never-ready") {
  setInterval(() => {}, 1000);
} else if (mode.behavior === "invalid-url") {
  send({ type: "ready", url: "http://example.com:8080" });
  setInterval(() => {}, 1000);
} else {
  send({ type: "ready", url: "http://127.0.0.1:49152" });
  process.on("message", (message) => {
    if (message.type !== "shutdown") return;
    if (mode.behavior === "hang-on-shutdown") {
      setInterval(() => {}, 1000);
      return;
    }
    writeFileSync(join(dirname(entry), "shutdown.txt"), "closed");
    process.exit(mode.exitCode ?? 0);
  });
  // 父通道断开等同于一次关闭请求。
  process.on("disconnect", () => {
    writeFileSync(join(dirname(entry), "disconnect.txt"), "closed");
    process.exit(mode.exitCode ?? 0);
  });
}
`;

test("ready url accepted only from loopback http origins", () => {
  assert.equal(parseReadyUrl("http://127.0.0.1:49152"), "http://127.0.0.1:49152");
  assert.equal(parseReadyUrl("http://127.0.0.1:49152/path"), "http://127.0.0.1:49152");
  assert.equal(parseReadyUrl("http://localhost:49152"), undefined);
  assert.equal(parseReadyUrl("https://127.0.0.1:49152"), undefined);
  assert.equal(parseReadyUrl("http://127.0.0.1:0"), undefined);
  assert.equal(parseReadyUrl(undefined), undefined);
});

test("backend environment ignores host, port, database and cors from config", () => {
  const environment = buildBackendEnvironment({
    inheritedEnvironment: {
      PATH: "/usr/bin",
      HOST: "0.0.0.0",
      PORT: "8080",
      AGENT_DATABASE_PATH: "/tmp/elsewhere.sqlite",
      CORS_ALLOW_ORIGIN: "http://localhost:5173",
      DEEPSEEK_API_KEY: "inherited",
    },
    userConfigText: [
      "HOST=0.0.0.0",
      "PORT=not-a-port",
      "AGENT_DATABASE_PATH=/tmp/elsewhere.sqlite",
      "CORS_ALLOW_ORIGIN=http://localhost:5173",
      "DEEPSEEK_API_KEY=from-file",
      "PATH=/opt/custom/bin",
    ].join("\n"),
    databasePath: "/Users/me/Library/Application Support/westie/agent-harness.sqlite",
  });

  assert.equal(environment.HOST, "127.0.0.1");
  assert.equal(environment.PORT, "3000");
  assert.equal(
    environment.AGENT_DATABASE_PATH,
    "/Users/me/Library/Application Support/westie/agent-harness.sqlite",
  );
  assert.equal(environment.CORS_ALLOW_ORIGIN, undefined);
  assert.equal(environment.DEEPSEEK_API_KEY, "from-file");
  const entries = environment.PATH.split(":");
  assert.equal(entries[0], "/opt/custom/bin");
  assert.ok(entries.includes("/opt/homebrew/bin"));
  assert.ok(entries.includes("/usr/bin"));
  assert.equal(new Set(entries).size, entries.length);
});

test("runtime root resolves staging for dev and Resources for packaged", () => {
  assert.equal(
    resolveRuntimeRoot({ isPackaged: false, resourcesPath: "/repo/.desktop-runtime" }),
    "/repo/.desktop-runtime/dev-runtime",
  );
  assert.equal(
    resolveRuntimeRoot({ isPackaged: true, resourcesPath: "/Applications/westie.app/Contents/Resources" }),
    "/Applications/westie.app/Contents/Resources/runtime",
  );
});

test("ready then shutdown writes the log and resolves stop", async () => {
  const fixture = await createFixture("ready");
  try {
    const backend = await startBackend({
      runtimeRoot: fixture.runtimeRoot,
      environment: fixture.environment,
      logPath: fixture.logPath,
    });
    assert.equal(backend.url, "http://127.0.0.1:49152");
    await backend.stop();
    await backend.stop();
    assert.equal(await readFile(join(fixture.entryDirectory, "shutdown.txt"), "utf8"), "closed");
    const log = await readFile(fixture.logPath, "utf8");
    assert.match(log, /fake backend started/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("early exit before ready reports the log path", async () => {
  const fixture = await createFixture("early-exit");
  try {
    await assert.rejects(
      startBackend({
        runtimeRoot: fixture.runtimeRoot,
        environment: fixture.environment,
        logPath: fixture.logPath,
      }),
      (error) => {
        assert.match(error.message, /exited before ready \(exit 3\)/);
        assert.ok(error.message.includes(fixture.logPath));
        return true;
      },
    );
    assert.match(await readFile(fixture.logPath, "utf8"), /boom/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("missing backend executable reports a startup error promptly", async () => {
  const fixture = await createFixture("ready", { nodeMissing: true });
  try {
    await assert.rejects(
      startBackend({
        runtimeRoot: fixture.runtimeRoot,
        environment: fixture.environment,
        logPath: fixture.logPath,
        startTimeoutMs: 300,
      }),
      /Backend failed to start: spawn .* ENOENT/,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("missing ready message times out", async () => {
  const fixture = await createFixture("never-ready");
  try {
    await assert.rejects(
      startBackend({
        runtimeRoot: fixture.runtimeRoot,
        environment: fixture.environment,
        logPath: fixture.logPath,
        startTimeoutMs: 300,
      }),
      /no ready message within 300ms/,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("invalid ready url is rejected", async () => {
  const fixture = await createFixture("invalid-url");
  try {
    await assert.rejects(
      startBackend({
        runtimeRoot: fixture.runtimeRoot,
        environment: fixture.environment,
        logPath: fixture.logPath,
      }),
      /invalid URL/,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("parent channel disconnect makes the backend clean up", async () => {
  const fixture = await createFixture("ready");
  try {
    const backend = await startBackend({
      runtimeRoot: fixture.runtimeRoot,
      environment: fixture.environment,
      logPath: fixture.logPath,
    });
    // 模拟 Electron 主进程退出：关闭 IPC 通道但不发送 shutdown。
    backend.disconnect();
    await backend.exited;
    assert.equal(
      await readFile(join(fixture.entryDirectory, "disconnect.txt"), "utf8"),
      "closed",
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("shutdown that hangs is killed after the exit timeout", async () => {
  const fixture = await createFixture("hang-on-shutdown");
  try {
    const backend = await startBackend({
      runtimeRoot: fixture.runtimeRoot,
      environment: fixture.environment,
      logPath: fixture.logPath,
      exitTimeoutMs: 300,
    });
    await assert.rejects(backend.stop(), /did not exit within 300ms after shutdown and was killed/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("non-zero exit after shutdown is reported", async () => {
  const fixture = await createFixture("ready", { exitCode: 2 });
  try {
    const backend = await startBackend({
      runtimeRoot: fixture.runtimeRoot,
      environment: fixture.environment,
      logPath: fixture.logPath,
    });
    await assert.rejects(backend.stop(), /exited abnormally \(exit 2\)/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function createFixture(behavior, { exitCode, nodeMissing = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "westie-desktop-"));
  const runtimeRoot = join(directory, "runtime");
  const entryDirectory = join(runtimeRoot, "desktop");
  await mkdir(join(runtimeRoot, "bin"), { recursive: true });
  await mkdir(entryDirectory, { recursive: true });
  if (!nodeMissing) {
    const nodePath = join(runtimeRoot, "bin", "node");
    await writeFile(nodePath, FAKE_NODE);
    await chmod(nodePath, 0o755);
  }
  await writeFile(join(entryDirectory, "backend-entry.mjs"), "// fixture\n");
  await writeFile(
    join(entryDirectory, "fake-mode.json"),
    JSON.stringify({ behavior, exitCode }),
  );
  return {
    directory,
    runtimeRoot,
    entryDirectory,
    logPath: join(directory, "logs", "backend.log"),
    environment: { PATH: process.env.PATH },
  };
}
