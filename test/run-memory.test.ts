import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  initializeSqliteSchema,
  openSqliteDatabase,
  SQLiteConversationStore,
} from "../src/infrastructure/sqlite/index.js";
import {
  GitProcessRunner,
  type GitRunner,
} from "../src/infrastructure/git-process-runner.js";
import { GitProjectService } from "../src/application/git-project-service.js";
import { ProjectInspection } from "../src/application/project-inspection.js";
import {
  createMemoryIdentifier,
  createMemoryRuntime,
} from "../src/infrastructure/run-memory.js";
import {
  memoryDirectoryName,
  ProjectMemoryStore,
} from "../src/infrastructure/memory-store.js";
import { createMemoryTool } from "../src/tools/memory.js";
import { ToolRegistry } from "../src/tools.js";
import { ConversationRunService } from "../src/application/conversation-run-service.js";
import { HostSandboxRunner } from "../src/sandbox/host-sandbox-runner.js";
import { createSQLiteTestStore } from "./support/sqlite-test-store.js";
import { finalTurn, providerFromTurnFactory, toolCallTurn } from "./support/provider.js";

const run = promisify(execFile);

/** 每个顶层用例各自构造项目识别服务，避免跨用例共享状态。 */
function projectInspection(): ProjectInspection {
  return new ProjectInspection(new GitProjectService(new GitProcessRunner({})));
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run("git", args, { cwd });
}

/** 创建一个主工作目录和两个 linked worktree 的临时仓库。 */
async function createRepository(t: test.TestContext): Promise<{
  readonly root: string;
  readonly repository: string;
  readonly worktreeA: string;
  readonly worktreeB: string;
  readonly subdirectory: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-memory-repo-")));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const repository = join(root, "app");
  await mkdir(repository, { recursive: true });
  await git(repository, "init", "-q", "-b", "main");
  await git(repository, "config", "user.email", "test@example.com");
  await git(repository, "config", "user.name", "Test");
  await writeFile(join(repository, "README.md"), "# app\n");
  await git(repository, "add", ".");
  await git(repository, "commit", "-q", "-m", "init");
  await mkdir(join(repository, "packages"), { recursive: true });
  const worktreeA = join(root, "worktrees", "a");
  const worktreeB = join(root, "worktrees", "b");
  await mkdir(join(root, "worktrees"), { recursive: true });
  await git(repository, "worktree", "add", "-q", "-b", "a", worktreeA);
  await git(repository, "worktree", "add", "-q", "-b", "b", worktreeB);
  return {
    root,
    repository,
    worktreeA,
    worktreeB,
    subdirectory: join(repository, "packages"),
  };
}

async function temporaryMemoryRoot(t: test.TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-memory-root-")));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("linked worktrees and the main directory share one memory directory", async (t) => {
  const repo = await createRepository(t);
  const memoryRoot = await temporaryMemoryRoot(t);
  const inspection = projectInspection();
  const main = await inspection.inspect(repo.repository);
  const worktreeA = await inspection.inspect(repo.worktreeA);
  const worktreeB = await inspection.inspect(repo.worktreeB);
  const subdirectory = await inspection.inspect(repo.subdirectory);
  assert.ok(main && worktreeA && worktreeB && subdirectory);
  assert.match(main.assignment.projectKey, /^git:/);
  assert.equal(worktreeA.assignment.projectKey, main.assignment.projectKey);
  assert.equal(worktreeB.assignment.projectKey, main.assignment.projectKey);
  assert.equal(subdirectory.assignment.projectKey, main.assignment.projectKey);

  const runtime = createMemoryRuntime({ rootDirectory: memoryRoot });
  const begun = (workspaceRoot: string, projectKey: string | null) => ({
    conversationId: "conversation",
    turnId: "turn",
    runId: "run",
    workspaceRoot,
    executionMode: "workspace_sandbox" as const,
    projectKey,
    projectRoot: main.assignment.projectRoot,
    workspaceKind: "worktree" as const,
  });
  const savedA = await runtime.loadMemory(begun(repo.worktreeA, main.assignment.projectKey));
  assert.ok(savedA.store);
  await savedA.store.write(
    "MEMORY.md",
    "- 集成测试需要先启动 Redis\n",
    null,
  );

  const loadedB = await runtime.loadMemory(
    begun(repo.worktreeB, main.assignment.projectKey),
  );
  assert.deepEqual(loadedB.status, { status: "ready" });
  assert.equal(loadedB.index, "- 集成测试需要先启动 Redis\n");
});

test("memory changes made through tools are loaded by later worktree sessions", async (t) => {
  const repo = await createRepository(t);
  const memoryRoot = await temporaryMemoryRoot(t);
  const inspection = projectInspection();
  const projectA = await inspection.inspect(repo.worktreeA);
  const projectB = await inspection.inspect(repo.worktreeB);
  assert.ok(projectA && projectB);
  assert.equal(projectA.assignment.projectKey, projectB.assignment.projectKey);

  const { store } = createSQLiteTestStore(t);
  const memory = createMemoryRuntime({ rootDirectory: memoryRoot });
  const original = "- 集成测试需要 Redis\n";
  const modified = "- 集成测试需要 PostgreSQL\n";
  let phase = 0;
  let step = 0;
  const service = new ConversationRunService({
    conversationStore: store,
    workspaceRuntimeProvider: {
      async get(workspaceRoot, executionMode) {
        return { workspaceRoot, executionMode, sandboxRunner: new HostSandboxRunner(), tools: [] };
      },
    },
    loadWorkspaceInstructions: async () => undefined,
    loadMemory: (begun, signal) => memory.loadMemory(begun, signal),
    provider: providerFromTurnFactory((request) => {
      const currentStep = step++;
      if (currentStep === 0) {
        assert.ok(request.tools.some((tool) => tool.name === "memory"));
        if (phase === 0 || phase === 3) {
          assert.doesNotMatch(request.systemPrompt, /集成测试需要/);
        } else {
          assert.ok(request.systemPrompt.includes(phase === 1 ? original : modified));
        }
      }
      if (phase === 3) return finalTurn("done");
      const fields = { file: "MEMORY.md", start_line: null, limit: null, content: null, expected_sha256: null };
      if (phase === 0 && currentStep === 0) {
        return toolCallTurn("memory", { ...fields, action: "write", content: original }, "create-memory");
      }
      if (phase > 0 && currentStep === 0) {
        return toolCallTurn("memory", { ...fields, action: "read" }, `read-memory-${phase}`);
      }
      const last = request.transcript.at(-1);
      assert.ok(last?.role === "tool");
      const result = last.results[0]?.result;
      assert.equal(result?.status, "success");
      if (phase > 0 && currentStep === 1) {
        assert.ok(result && result.status === "success");
        const output = result.output as { content: string; sha256: string };
        assert.equal(output.content, phase === 1 ? original : modified);
        return toolCallTurn("memory", {
          ...fields,
          action: phase === 1 ? "write" : "delete",
          content: phase === 1 ? modified : null,
          expected_sha256: output.sha256,
        }, `update-memory-${phase}`);
      }
      return finalTurn("done");
    }, { contextWindowTokens: 64_000, maxOutputTokens: 4_000 }),
  });

  for (phase = 0; phase < 4; phase += 1) {
    step = 0;
    const worktree = phase % 2 === 0 ? repo.worktreeA : repo.worktreeB;
    const assignment = phase % 2 === 0 ? projectA.assignment : projectB.assignment;
    const conversation = store.createConversation(worktree, "workspace_sandbox", assignment, "worktree");
    const run = service.startRun({
      conversationId: conversation.id,
      input: ["记住测试要求", "修改测试要求", "忘记测试要求", "查看测试要求"][phase]!,
    });
    const events = [];
    for await (const source of run.events) events.push(source.event);
    assert.ok(events.some((event) => event.type === "run.completed"), `phase ${phase} did not complete`);
    assert.equal(store.getConversation(conversation.id).turns[0]?.status, "completed");
  }
});

test("independent clones get separate memory directories", async (t) => {
  const repo = await createRepository(t);
  const memoryRoot = await temporaryMemoryRoot(t);
  const clone = join(repo.root, "clone");
  await run("git", ["clone", "-q", repo.repository, clone]);
  const inspection = projectInspection();
  const original = await inspection.inspect(repo.repository);
  const cloned = await inspection.inspect(clone);
  assert.ok(original && cloned);
  assert.notEqual(original.assignment.projectKey, cloned.assignment.projectKey);

  const runtime = createMemoryRuntime({ rootDirectory: memoryRoot });
  const store = new ProjectMemoryStore(
    memoryRoot,
    original.assignment.projectKey,
  );
  await store.write("MEMORY.md", "- only in the original\n", null);
  const begunRun = {
    conversationId: "conversation",
    turnId: "turn",
    runId: "run",
    workspaceRoot: clone,
    executionMode: "full_access" as const,
    projectKey: cloned.assignment.projectKey,
    projectRoot: cloned.assignment.projectRoot,
    workspaceKind: "main" as const,
  };
  const memory = await runtime.loadMemory(begunRun);
  assert.equal(memory.index, "");
  assert.deepEqual(await memory.store?.list(), []);
});

test("a session without a saved project identity is identified at run start", async (t) => {
  const repo = await createRepository(t);
  const memoryRoot = await temporaryMemoryRoot(t);
  const inspection = projectInspection();
  const runtime = createMemoryRuntime({
    rootDirectory: memoryRoot,
    identify: createMemoryIdentifier({ projectInspection: inspection }),
  });
  const memory = await runtime.loadMemory({
    conversationId: "conversation",
    turnId: "turn",
    runId: "run",
    workspaceRoot: repo.worktreeB,
    executionMode: "workspace_sandbox",
    projectKey: null,
    projectRoot: null,
    workspaceKind: null,
  });
  assert.equal(memory.status.status, "ready");
  assert.ok(memory.store);
  const direct = await inspection.inspect(repo.worktreeB);
  assert.ok(direct);
  assert.equal(
    memory.store.directory,
    join(memoryRoot, memoryDirectoryName(direct.assignment.projectKey)),
  );
});

test("a known repository workspace never falls back to directory memory when Git is unavailable", async (t) => {
  const repo = await createRepository(t);
  const memoryRoot = await temporaryMemoryRoot(t);
  const failingRunner: GitRunner = {
    executable: "git",
    async run() {
      return { exitCode: 1, stdout: "", stderr: "git unavailable" };
    },
  };
  const failingInspection = new ProjectInspection(
    new GitProjectService(failingRunner),
  );
  const runtime = createMemoryRuntime({
    rootDirectory: memoryRoot,
    identify: createMemoryIdentifier({ projectInspection: failingInspection }),
  });
  const begunRun = (workspaceKind: "worktree") => ({
    conversationId: "conversation",
    turnId: "turn",
    runId: "run",
    workspaceRoot: repo.worktreeA,
    executionMode: "workspace_sandbox" as const,
    projectKey: null,
    projectRoot: null,
    workspaceKind,
  });
  const unavailable = await runtime.loadMemory(begunRun("worktree"));
  assert.deepEqual(unavailable.status, { status: "unavailable", reason: "identity" });
  assert.equal(unavailable.store, undefined);
});

test("a plain directory falls back to dir: identity when it is not a Git repository", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-memory-plain-")));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const memoryRoot = await temporaryMemoryRoot(t);
  const runtime = createMemoryRuntime({
    rootDirectory: memoryRoot,
    identify: createMemoryIdentifier({ projectInspection: projectInspection() }),
  });
  const memory = await runtime.loadMemory({
    conversationId: "conversation",
    turnId: "turn",
    runId: "run",
    workspaceRoot: root,
    executionMode: "workspace_sandbox",
    projectKey: null,
    projectRoot: null,
    workspaceKind: "directory",
  });
  assert.equal(memory.status.status, "ready");
});

test("the index reports truncation and invalid UTF-8 as unavailable", async (t) => {
  const memoryRoot = await temporaryMemoryRoot(t);
  const runtime = createMemoryRuntime({ rootDirectory: memoryRoot });
  const projectKey = "git:/repo/truncated/.git";
  const store = new ProjectMemoryStore(memoryRoot, projectKey);
  await mkdir(store.directory, { recursive: true });
  await writeFile(
    join(store.directory, "MEMORY.md"),
    Array.from({ length: 250 }, (_, index) => `- ${index + 1}`).join("\n"),
  );
  const begunRun = {
    conversationId: "conversation",
    turnId: "turn",
    runId: "run",
    workspaceRoot: "/repo",
    executionMode: "workspace_sandbox" as const,
    projectKey,
    projectRoot: "/repo",
    workspaceKind: "main" as const,
  };
  const truncated = await runtime.loadMemory(begunRun);
  assert.deepEqual(truncated.status, { status: "truncated", nextLine: 201 });
  assert.equal(truncated.index.split("\n").length, 200);

  await writeFile(join(store.directory, "MEMORY.md"), Buffer.from([0xc3, 0x28]));
  const invalid = await runtime.loadMemory(begunRun);
  assert.deepEqual(invalid.status, { status: "unavailable", reason: "encoding" });
  assert.equal(invalid.index, "");
});

test("cancelling during memory loading aborts the run instead of returning empty memory", async (t) => {
  const memoryRoot = await temporaryMemoryRoot(t);
  const runtime = createMemoryRuntime({ rootDirectory: memoryRoot });
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    runtime.loadMemory({
      conversationId: "conversation",
      turnId: "turn",
      runId: "run",
      workspaceRoot: "/repo",
      executionMode: "workspace_sandbox",
      projectKey: "git:/repo/app/.git",
      projectRoot: "/repo",
      workspaceKind: "main",
    }, controller.signal),
    /cancelled/,
  );
});

test("the memory tool reads, writes and deletes with conflict safety", async (t) => {
  const memoryRoot = await temporaryMemoryRoot(t);
  const store = new ProjectMemoryStore(memoryRoot, "git:/repo/app/.git");
  const tool = createMemoryTool(store);

  const empty = await tool.execute({
    action: "list",
    file: null,
    start_line: null,
    limit: null,
    content: null,
    expected_sha256: null,
  });
  // 记忆目录还不存在时没有文件；一旦目录存在，list 总包含启动索引。
  assert.deepEqual(empty, { files: [] });

  const created = await tool.execute({
    action: "write",
    file: "testing.md",
    start_line: null,
    limit: null,
    content: "# 集成测试\n执行测试前启动 Redis。\n",
    expected_sha256: null,
  }) as { file: string; sha256: string };
  assert.equal(created.file, "testing.md");
  assert.deepEqual(
    await tool.execute({
      action: "list",
      file: null,
      start_line: null,
      limit: null,
      content: null,
      expected_sha256: null,
    }),
    { files: ["MEMORY.md", "testing.md"] },
  );

  const read = await tool.execute({
    action: "read",
    file: "testing.md",
    start_line: null,
    limit: null,
    content: null,
    expected_sha256: null,
  }) as { content: string; sha256: string; nextLine: string | null };
  assert.equal(read.content, "# 集成测试\n执行测试前启动 Redis。\n");
  assert.equal(read.sha256, created.sha256);
  assert.equal(read.nextLine, null);

  await assert.rejects(
    tool.execute({
      action: "delete",
      file: "testing.md",
      start_line: null,
      limit: null,
      content: null,
      expected_sha256: "0".repeat(64),
    }),
    (error: { code?: string }) => error.code === "EDIT_CONFLICT",
  );
  assert.deepEqual(await tool.execute({
    action: "delete",
    file: "testing.md",
    start_line: null,
    limit: null,
    content: null,
    expected_sha256: read.sha256,
  }), { file: "testing.md", deleted: true });
});

test("BegunConversationRun carries the stored project assignment", (t) => {
  const database = openSqliteDatabase(":memory:");
  initializeSqliteSchema(database);
  const store = new SQLiteConversationStore(database);
  t.after(() => store.close());
  const conversation = store.createConversation(
    "/repo/worktrees/a",
    "workspace_sandbox",
    { projectKey: "git:/repo/app/.git", projectRoot: "/repo/app" },
    "worktree",
  );
  const begun = store.beginRun(conversation.id, "run integration tests", "run-1");
  assert.equal(begun.projectKey, "git:/repo/app/.git");
  assert.equal(begun.projectRoot, "/repo/app");
  assert.equal(begun.workspaceKind, "worktree");

  const legacy = store.createConversation("/plain/dir", "full_access");
  const legacyBegun = store.beginRun(legacy.id, "hello", "run-2");
  assert.equal(legacyBegun.projectKey, null);
  assert.equal(legacyBegun.projectRoot, null);
  assert.equal(legacyBegun.workspaceKind, null);
});

test("the memory tool rejects non-regular entries and over-long names with clear codes", async (t) => {
  const memoryRoot = await temporaryMemoryRoot(t);
  const store = new ProjectMemoryStore(memoryRoot, "git:/repo/edge/.git");
  const tool = createMemoryTool(store);
  const write = (file: string) => tool.execute({
    action: "write",
    file,
    start_line: null,
    limit: null,
    content: "- x\n",
    expected_sha256: null,
  });

  // 目录占用同名记忆文件：明确冲突而不是通用失败，也不会覆盖该条目。
  await mkdir(join(store.directory, "folder.md"), { recursive: true });
  await assert.rejects(write("folder.md"), (error: { code?: string }) =>
    error.code === "EDIT_CONFLICT");

  // 名字上限按 UTF-8 字节计：schema 先拒绝，避免写临时文件时才 ENAMETOOLONG。
  const registry = new ToolRegistry([createMemoryTool(store)]);
  const tooLong = `${"n".repeat(215)}.md`;
  const rejected = await registry.execute("memory", {
    action: "write",
    file: tooLong,
    start_line: null,
    limit: null,
    content: "- x\n",
    expected_sha256: null,
  });
  assert.equal(rejected.status, "error");
  assert.equal(
    rejected.status === "error" ? rejected.error.code : undefined,
    "INVALID_TOOL_INPUT",
  );

  // 上限内的长名字可以正常写入（名字加临时后缀仍在文件系统上限内）。
  const allowed = await registry.execute("memory", {
    action: "write",
    file: `${"n".repeat(190)}.md`,
    start_line: null,
    limit: null,
    content: "- x\n",
    expected_sha256: null,
  });
  assert.equal(allowed.status, "success");
});
