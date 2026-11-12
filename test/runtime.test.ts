import assert from "node:assert/strict";
import { HostSandboxRunner } from "../src/sandbox/host-sandbox-runner.js";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CachedWorkspaceRuntimeProvider } from "../src/application/workspace-runtime.js";
import { RetryingProvider } from "../src/providers/retrying-provider.js";
import {
  createDefaultTools,
  createDefaultWorkspaceRuntime,
  createProviderFromEnvironment,
} from "../src/runtime.js";

test("registers the default tools without duplicate names", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  // 用假 runner 替代 Seatbelt，仅验证工具装配与去重。
  const tools = await createDefaultTools(workspace, {
    webSearchApiKey: "test-tavily-key",
    sandboxRunner: {
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  });

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["get_current_time", "read", "grep", "glob", "write", "edit", "web_search", "web_fetch", "todo", "bash"],
  );
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
});

test("workspace runtime provider canonicalizes and shares concurrent initialization", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "agent-runtime-cache-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const workspace = join(parent, "workspace");
  const alias = join(parent, "workspace-alias");
  await mkdir(workspace);
  await symlink(workspace, alias);

  let createCount = 0;
  const provider = new CachedWorkspaceRuntimeProvider(async (workspaceRoot, executionMode) => {
    createCount += 1;
    await Promise.resolve();
    return { workspaceRoot, executionMode, sandboxRunner: new HostSandboxRunner(), tools: [] };
  });

  const [first, second, third] = await Promise.all([
    provider.get(workspace, "workspace_sandbox"),
    provider.get(alias, "workspace_sandbox"),
    provider.get(workspace, "workspace_sandbox"),
  ]);

  assert.equal(createCount, 1);
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(first.workspaceRoot, await realpath(workspace));
});

test("workspace runtime provider removes failed initialization from cache", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-retry-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  let createCount = 0;
  const provider = new CachedWorkspaceRuntimeProvider(async (workspaceRoot, executionMode) => {
    createCount += 1;
    if (createCount === 1) throw new Error("initialization failed");
    return { workspaceRoot, executionMode, sandboxRunner: new HostSandboxRunner(), tools: [] };
  });

  await assert.rejects(
    provider.get(workspace, "workspace_sandbox"),
    /initialization failed/,
  );
  assert.equal(
    (await provider.get(workspace, "workspace_sandbox")).workspaceRoot,
    await realpath(workspace),
  );
  assert.equal(createCount, 2);
});

test("workspace runtime provider isolates execution modes for one root", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-mode-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let createCount = 0;
  const provider = new CachedWorkspaceRuntimeProvider(
    async (workspaceRoot, executionMode) => {
      createCount += 1;
      return { workspaceRoot, executionMode, sandboxRunner: new HostSandboxRunner(), tools: [] };
    },
  );

  const sandbox = await provider.get(workspace, "workspace_sandbox");
  const fullAccess = await provider.get(workspace, "full_access");
  const sandboxAgain = await provider.get(workspace, "workspace_sandbox");

  assert.equal(createCount, 2);
  assert.equal(sandbox, sandboxAgain);
  assert.notEqual(sandbox, fullAccess);
  assert.equal(fullAccess.executionMode, "full_access");
});

test("workspace runtime provider rejects non-directory roots", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "agent-runtime-file-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const file = join(parent, "file.txt");
  await writeFile(file, "not a workspace");
  let createCount = 0;
  const provider = new CachedWorkspaceRuntimeProvider(async (workspaceRoot, executionMode) => {
    createCount += 1;
    return { workspaceRoot, executionMode, sandboxRunner: new HostSandboxRunner(), tools: [] };
  });

  await assert.rejects(
    provider.get(file, "workspace_sandbox"),
    /must be a directory/,
  );
  assert.equal(createCount, 0);
});

test("default workspace runtime gives bash the same canonical workspace root", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agent-runtime-root-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const workingDirectories: string[] = [];

  const provider = new CachedWorkspaceRuntimeProvider((workspaceRoot, executionMode) =>
    createDefaultWorkspaceRuntime(workspaceRoot, executionMode, {
      async sandboxRunnerFactory() {
        return {
          async run(command) {
            workingDirectories.push(command.cwd);
            return {
              exitCode: 0,
              stdout: command.cwd,
              stderr: "",
            };
          },
        };
      },
      webSearchApiKey: "test-tavily-key",
    })
  );
  const runtime = await provider.get(workspace, "workspace_sandbox");
  const bash = runtime.tools.find((tool) => tool.name === "bash");
  assert.notEqual(bash, undefined);

  const result = await bash!.execute({ command: "pwd" });

  assert.equal(runtime.workspaceRoot, await realpath(workspace));
  assert.deepEqual(workingDirectories, [runtime.workspaceRoot]);
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: runtime.workspaceRoot,
    stderr: "",
  });
});

test("different workspace runtimes keep file tools and bash cwd isolated", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "agent-runtime-isolation-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const firstWorkspace = join(parent, "first");
  const secondWorkspace = join(parent, "second");
  await mkdir(firstWorkspace);
  await mkdir(secondWorkspace);
  await writeFile(join(firstWorkspace, "marker.txt"), "first");
  await writeFile(join(secondWorkspace, "marker.txt"), "second");
  const bashWorkingDirectories: string[] = [];

  const provider = new CachedWorkspaceRuntimeProvider((workspaceRoot, executionMode) =>
    createDefaultWorkspaceRuntime(workspaceRoot, executionMode, {
      async sandboxRunnerFactory() {
        return {
          async run(command) {
            bashWorkingDirectories.push(command.cwd);
            return {
              exitCode: 0,
              stdout: command.cwd,
              stderr: "",
            };
          },
        };
      },
      webSearchApiKey: "test-tavily-key",
    })
  );
  const [first, second] = await Promise.all([
    provider.get(firstWorkspace, "workspace_sandbox"),
    provider.get(secondWorkspace, "workspace_sandbox"),
  ]);
  const firstRead = first.tools.find((tool) => tool.name === "read");
  const secondRead = second.tools.find((tool) => tool.name === "read");
  const firstBash = first.tools.find((tool) => tool.name === "bash");
  const secondBash = second.tools.find((tool) => tool.name === "bash");
  assert.ok(firstRead && secondRead && firstBash && secondBash);

  assert.deepEqual(await firstRead.execute({ path: "marker.txt" }), {
    content: "first",
    startLine: 1,
    endLine: 1,
    totalLines: 1,
  });
  assert.deepEqual(await secondRead.execute({ path: "marker.txt" }), {
    content: "second",
    startLine: 1,
    endLine: 1,
    totalLines: 1,
  });
  await firstBash.execute({ command: "pwd" });
  await secondBash.execute({ command: "pwd" });
  assert.deepEqual(bashWorkingDirectories, [
    first.workspaceRoot,
    second.workspaceRoot,
  ]);
  assert.notEqual(first.workspaceRoot, second.workspaceRoot);
});

test("wraps the environment provider in RetryingProvider", (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "test-key";
  process.env.DEEPSEEK_MODEL = "deepseek-test";
  const provider = createProviderFromEnvironment({
    contextWindowTokens: 128_000,
    maxOutputTokens: 4_096,
  });
  assert.ok(provider instanceof RetryingProvider);
  assert.equal(provider.model, "deepseek-test");
  assert.equal(provider.contextWindowTokens, 128_000);
  assert.equal(provider.maxOutputTokens, 4_096);
});

test("creates an openai-compatible provider from OPENAI_COMPATIBLE_* env vars", (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  process.env.LLM_PROVIDER = "openai-compatible";
  process.env.OPENAI_COMPATIBLE_API_KEY = "compat-key";
  process.env.OPENAI_COMPATIBLE_MODEL = "DeepSeek-V4-Pro";
  process.env.OPENAI_COMPATIBLE_BASE_URL = "http://127.0.0.1:8317/v1";
  const provider = createProviderFromEnvironment({
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_192,
  });
  assert.ok(provider instanceof RetryingProvider);
  assert.equal(provider.model, "DeepSeek-V4-Pro");
  assert.equal(provider.contextWindowTokens, 128_000);
  assert.equal(provider.maxOutputTokens, 8_192);
});

test("requires OPENAI_COMPATIBLE_BASE_URL for the openai-compatible provider", (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  process.env.LLM_PROVIDER = "openai-compatible";
  process.env.OPENAI_COMPATIBLE_API_KEY = "compat-key";
  process.env.OPENAI_COMPATIBLE_MODEL = "DeepSeek-V4-Pro";
  delete process.env.OPENAI_COMPATIBLE_BASE_URL;
  assert.throws(
    () => createProviderFromEnvironment(),
    /OPENAI_COMPATIBLE_BASE_URL/,
  );
});

test("passes DEEPSEEK_BASE_URL through to the DeepSeek provider", (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  process.env.LLM_PROVIDER = "deepseek";
  process.env.DEEPSEEK_API_KEY = "test-key";
  process.env.DEEPSEEK_MODEL = "deepseek-test";
  process.env.DEEPSEEK_BASE_URL = "http://127.0.0.1:8317/v1";
  const provider = createProviderFromEnvironment();
  assert.ok(provider instanceof RetryingProvider);
  assert.equal(provider.model, "deepseek-test");
});
