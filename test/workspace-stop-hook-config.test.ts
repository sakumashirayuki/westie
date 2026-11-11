import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadStopHookConfig,
  StopHookConfigError,
} from "../src/infrastructure/workspace-stop-hook-config.js";

async function withWorkspace(
  run: (workspaceRoot: string) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "my-agent-harness-stop-hook-config-"),
  );
  try {
    await run(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function writeConfig(
  workspaceRoot: string,
  content: string,
): Promise<string> {
  const agentsDirectory = path.join(workspaceRoot, ".agents");
  await mkdir(agentsDirectory, { recursive: true });
  const configPath = path.join(agentsDirectory, "stop-hook.json");
  await writeFile(configPath, content, "utf8");
  return configPath;
}

test("returns undefined when the project has no stop hook config", async () => {
  await withWorkspace(async (workspaceRoot) => {
    assert.equal(await loadStopHookConfig(workspaceRoot), undefined);
  });
});

test("applies defaults for timeout and continuation limit", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writeConfig(
      workspaceRoot,
      JSON.stringify({ command: "node .agents/check.mjs" }),
    );
    assert.deepEqual(await loadStopHookConfig(workspaceRoot), {
      command: "node .agents/check.mjs",
      timeoutMs: 30_000,
      maxContinuations: 2,
    });
  });
});

test("reads timeout and continuation limit from the file", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writeConfig(
      workspaceRoot,
      JSON.stringify({
        command: "node .agents/check.mjs",
        timeoutMs: 5_000,
        maxContinuations: 0,
      }),
    );
    assert.deepEqual(await loadStopHookConfig(workspaceRoot), {
      command: "node .agents/check.mjs",
      timeoutMs: 5_000,
      maxContinuations: 0,
    });
  });
});

test("rejects unknown fields, empty command and out-of-range numbers", async () => {
  const invalid = [
    JSON.stringify({ command: "node check.mjs", extra: true }),
    JSON.stringify({}),
    JSON.stringify({ command: "   " }),
    JSON.stringify({ command: "node check.mjs", timeoutMs: 99 }),
    JSON.stringify({ command: "node check.mjs", timeoutMs: 120_001 }),
    JSON.stringify({ command: "node check.mjs", maxContinuations: 6 }),
    JSON.stringify({ command: "node check.mjs", maxContinuations: 1.5 }),
    JSON.stringify([]),
    "not json",
  ];
  for (const content of invalid) {
    await withWorkspace(async (workspaceRoot) => {
      await writeConfig(workspaceRoot, content);
      await assert.rejects(
        loadStopHookConfig(workspaceRoot),
        StopHookConfigError,
        content,
      );
    });
  }
});

test("rejects a symlinked config file", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const outside = await mkdtemp(
      path.join(tmpdir(), "my-agent-harness-stop-hook-outside-"),
    );
    try {
      const target = path.join(outside, "stop-hook.json");
      await writeFile(target, JSON.stringify({ command: "node check.mjs" }), "utf8");
      const agentsDirectory = path.join(workspaceRoot, ".agents");
      await mkdir(agentsDirectory, { recursive: true });
      await symlink(target, path.join(agentsDirectory, "stop-hook.json"));
      await assert.rejects(
        loadStopHookConfig(workspaceRoot),
        StopHookConfigError,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("rejects a symlinked .agents directory that leaves the workspace", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const outside = await mkdtemp(
      path.join(tmpdir(), "my-agent-harness-stop-hook-outside-"),
    );
    try {
      await writeFile(
        path.join(outside, "stop-hook.json"),
        JSON.stringify({ command: "node check.mjs" }),
        "utf8",
      );
      await symlink(outside, path.join(workspaceRoot, ".agents"));
      await assert.rejects(
        loadStopHookConfig(workspaceRoot),
        StopHookConfigError,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("rejects a config larger than 64 KiB", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writeConfig(
      workspaceRoot,
      JSON.stringify({ command: "x".repeat(64 * 1024) }),
    );
    await assert.rejects(
      loadStopHookConfig(workspaceRoot),
      StopHookConfigError,
    );
  });
});
