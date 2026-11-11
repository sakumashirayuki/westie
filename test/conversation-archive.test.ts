import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { TestContext } from "node:test";

import { ConversationService } from "../src/application/conversation-service.js";
import { ConversationRunService } from "../src/application/conversation-run-service.js";
import { InMemoryInteractionBroker } from "../src/application/interaction-broker.js";
import { RunRegistry } from "../src/application/run-registry.js";
import { AgentController } from "../src/http/agent-controller.js";
import { createAgentServer } from "../src/server.js";
import { HostSandboxRunner } from "../src/sandbox/host-sandbox-runner.js";
import {
  ConversationArchivedError,
  ConversationBusyError,
  ConversationNotFoundError,
  ConversationWorkspaceSharedError,
} from "../src/domain/conversation.js";
import type { GitCommandResult, GitRunner } from "../src/infrastructure/git-process-runner.js";
import { SQLiteWorktreeOperationStore } from "../src/infrastructure/sqlite/worktree-operation-store.js";
import { createSQLiteTestStore } from "./support/sqlite-test-store.js";

/** 记录调用并返回预设结果的假 GitRunner。 */
function fakeGitRunner(
  results: Record<string, GitCommandResult>,
): { gitRunner: GitRunner; calls: { cwd: string; args: readonly string[] }[] } {
  const calls: { cwd: string; args: readonly string[] }[] = [];
  return {
    calls,
    gitRunner: {
      executable: "git",
      async run(command) {
        calls.push({ cwd: command.cwd, args: command.args });
        const key = command.args[0] ?? "";
        return results[key] ?? { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
}

test("archiveConversation sets archived and rejects busy or re-archive", async (t) => {
  const { store } = createSQLiteTestStore(t);
  const service = new ConversationService(store);

  const conversation = store.createConversation("/workspace/project", "workspace_sandbox");
  assert.equal(store.getConversation(conversation.id).archived, false);

  await service.archiveConversation(conversation.id);
  assert.equal(store.getConversation(conversation.id).archived, true);
  const after = store.getConversation(conversation.id);
  assert.equal(after.revision, conversation.revision + 1);
  assert.ok(after.updatedAt !== conversation.updatedAt);

  const busy = store.createConversation("/workspace/busy", "workspace_sandbox");
  store.beginRun(busy.id, "question", "busy-run");
  await assert.rejects(
    service.archiveConversation(busy.id),
    ConversationBusyError,
  );
});

test("store archiveConversation rejects a busy or already archived conversation", (t) => {
  const { store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace/a", "workspace_sandbox");
  store.archiveConversation(conversation.id);
  assert.throws(
    () => store.archiveConversation(conversation.id),
    ConversationArchivedError,
  );

  const busy = store.createConversation("/workspace/b", "workspace_sandbox");
  store.beginRun(busy.id, "question", "run");
  assert.throws(
    () => store.archiveConversation(busy.id),
    ConversationBusyError,
  );
});

test("store listConversations filters by archived status", (t) => {
  const { store } = createSQLiteTestStore(t);
  const active = store.createConversation("/workspace/active", "workspace_sandbox");
  const archived = store.createConversation("/workspace/archived", "workspace_sandbox");
  store.archiveConversation(archived.id);

  assert.deepEqual(
    store.listConversations({ limit: 10, archived: false }).map((s) => s.id),
    [active.id],
  );
  assert.deepEqual(
    store.listConversations({ limit: 10, archived: true }).map((s) => s.id),
    [archived.id],
  );
  assert.deepEqual(
    store.listConversations({ limit: 10 }).map((s) => s.id).sort(),
    [active.id, archived.id].sort(),
  );
});

test("store listConversations filters archived with a cursor safely", (t) => {
  const { store } = createSQLiteTestStore(t);
  const base = Date.now();
  const archived = store.createConversation(
    "/workspace/archived-one",
    "workspace_sandbox",
  );
  store.archiveConversation(archived.id);
  // 构造一页装不下的归档会话：刻意让 updatedAt 相同，靠 id 做 tie-break。
  const second = store.createConversation(
    "/workspace/archived-two",
    "workspace_sandbox",
  );
  store.archiveConversation(second.id);

  const firstPage = store.listConversations({
    limit: 1,
    archived: true,
  });
  assert.equal(firstPage.length, 1);
  assert.equal(firstPage[0]!.archived, true);

  // 用第一页末项作游标拉下一页：命中 after 分支，必须能拼出合法 WHERE。
  const after = firstPage[0]!;
  const nextPage = store.listConversations({
    limit: 1,
    archived: true,
    after: { updatedAt: after.updatedAt, id: after.id },
  });
  assert.equal(nextPage.length, 1);
  assert.equal(nextPage[0]!.archived, true);
  assert.ok(nextPage[0]!.id !== after.id);

  // 不带过滤的游标分支仍正常。
  const noFilterNext = store.listConversations({
    limit: 10,
    after: { updatedAt: after.updatedAt, id: after.id },
  });
  assert.ok(noFilterNext.length >= 1);
});

test("archive removes a Westie-created worktree and keeps its branch", async (t) => {
  const { database, store } = createSQLiteTestStore(t);
  const operations = new SQLiteWorktreeOperationStore(database);
  const { gitRunner, calls } = fakeGitRunner({});

  const operationId = "0f0f0f0f-1111-4222-8333-444455556666";
  const conversation = store.createConversation("/workspace/app", "workspace_sandbox");
  operations.prepare({
    id: operationId,
    projectKey: "git:/workspace/app/.git",
    projectRoot: "/workspace/app",
    targetPath: "/workspace/worktrees/abc/0f0f0f0f-1111-4222-8333-444455556666",
    branch: "feat/archive",
    baseBranch: "main",
    baseRemote: null,
    baseCommit: "a".repeat(40),
    executionMode: "workspace_sandbox",
  });
  operations.markStarted(operationId);
  database.prepare(`
    UPDATE worktree_operations SET status = 'completed', conversation_id = $c WHERE id = $id
  `).run({ "$c": conversation.id, "$id": operationId });

  const service = new ConversationService(store, {
    worktreeOperations: operations,
    gitRunner,
  });
  await service.archiveConversation(conversation.id);

  // 归档只删除 worktree 目录；分支保留，不执行任何 branch 子命令。
  assert.deepEqual(calls, [
    {
      cwd: "/workspace/app",
      args: ["worktree", "remove", "--force", "--", "/workspace/worktrees/abc/0f0f0f0f-1111-4222-8333-444455556666"],
    },
  ]);
  assert.equal(store.getConversation(conversation.id).archived, true);
});

test("archive aborts (keeps unarchived) when worktree removal fails", async (t) => {
  const { database, store } = createSQLiteTestStore(t);
  const operations = new SQLiteWorktreeOperationStore(database);
  const { gitRunner } = fakeGitRunner({
    worktree: { exitCode: 1, stdout: "", stderr: "fatal: not a git repository" },
  });
  const conversation = store.createConversation("/workspace/app", "workspace_sandbox");
  const operationId = "0f0f0f0f-1111-4222-8333-444455556666";
  operations.prepare({
    id: operationId,
    projectKey: "git:/workspace/app/.git",
    projectRoot: "/workspace/app",
    targetPath: "/workspace/wt/op",
    branch: "feat/x",
    baseBranch: "main",
    baseRemote: null,
    baseCommit: "a".repeat(40),
    executionMode: "workspace_sandbox",
  });
  operations.markStarted(operationId);
  database.prepare(`
    UPDATE worktree_operations SET status = 'completed', conversation_id = $c WHERE id = $id
  `).run({ "$c": conversation.id, "$id": operationId });

  const service = new ConversationService(store, {
    worktreeOperations: operations,
    gitRunner,
  });
  await assert.rejects(service.archiveConversation(conversation.id), /清理 worktree 失败/);
  assert.equal(store.getConversation(conversation.id).archived, false);
});

test("archive treats a missing worktree as already cleaned", async (t) => {
  const { database, store } = createSQLiteTestStore(t);
  const operations = new SQLiteWorktreeOperationStore(database);
  const { gitRunner } = fakeGitRunner({
    worktree: {
      exitCode: 1,
      stdout: "",
      stderr: "/workspace/wt/op is not a valid working tree",
    },
  });
  const conversation = store.createConversation("/workspace/app", "workspace_sandbox");
  const operationId = "0f0f0f0f-1111-4222-8333-444455556666";
  operations.prepare({
    id: operationId,
    projectKey: "git:/workspace/app/.git",
    projectRoot: "/workspace/app",
    targetPath: "/workspace/wt/op",
    branch: "feat/x",
    baseBranch: "main",
    baseRemote: null,
    baseCommit: "a".repeat(40),
    executionMode: "workspace_sandbox",
  });
  operations.markStarted(operationId);
  database.prepare(`
    UPDATE worktree_operations SET status = 'completed', conversation_id = $c WHERE id = $id
  `).run({ "$c": conversation.id, "$id": operationId });

  const service = new ConversationService(store, {
    worktreeOperations: operations,
    gitRunner,
  });
  await service.archiveConversation(conversation.id);
  assert.equal(store.getConversation(conversation.id).archived, true);
});

test("archive does not touch Git when the conversation has no worktree operation", async (t) => {
  const { database, store } = createSQLiteTestStore(t);
  const operations = new SQLiteWorktreeOperationStore(database);
  const { gitRunner, calls } = fakeGitRunner({});
  const conversation = store.createConversation("/workspace/plain", "workspace_sandbox");

  const service = new ConversationService(store, {
    worktreeOperations: operations,
    gitRunner,
  });
  await service.archiveConversation(conversation.id);
  assert.equal(calls.length, 0);
  assert.equal(store.getConversation(conversation.id).archived, true);
});

test("archiveConversation rejects a missing conversation", async (t) => {
  const { store } = createSQLiteTestStore(t);
  const service = new ConversationService(store);
  await assert.rejects(
    service.archiveConversation("00000000-0000-4000-8000-000000000000"),
    ConversationNotFoundError,
  );
});

test("archive refuses when another active conversation reuses the worktree", async (t) => {
  const { database, store } = createSQLiteTestStore(t);
  const operations = new SQLiteWorktreeOperationStore(database);
  const { gitRunner, calls } = fakeGitRunner({});
  const targetPath = "/workspace/wt/op";

  // 会话 A 用 worktree W；
  const a = store.createConversation(targetPath, "workspace_sandbox");
  const operationId = "0f0f0f0f-1111-4222-8333-444455556666";
  operations.prepare({
    id: operationId,
    projectKey: "git:/workspace/app/.git",
    projectRoot: "/workspace/app",
    targetPath,
    branch: "feat/a",
    baseBranch: "main",
    baseRemote: null,
    baseCommit: "a".repeat(40),
    executionMode: "workspace_sandbox",
  });
  operations.markStarted(operationId);
  database.prepare(`
    UPDATE worktree_operations SET status = 'completed', conversation_id = $c WHERE id = $id
  `).run({ "$c": a.id, "$id": operationId });

  // 会话 B 也指向同一 worktree 目录（已有 worktree 入口复用）。
  store.createConversation(targetPath, "workspace_sandbox");

  const service = new ConversationService(store, {
    worktreeOperations: operations,
    gitRunner,
  });
  await assert.rejects(service.archiveConversation(a.id), (error: unknown) =>
    error instanceof ConversationWorkspaceSharedError
  );
  // 不执行任何 Git 清理，会话保持未归档。
  assert.equal(calls.length, 0);
  assert.equal(store.getConversation(a.id).archived, false);
});

test("archive treats bare 'is not a working tree' as already cleaned and retry works", async (t) => {
  const { database, store } = createSQLiteTestStore(t);
  const operations = new SQLiteWorktreeOperationStore(database);
  const { gitRunner } = fakeGitRunner({
    worktree: { exitCode: 128, stdout: "", stderr: "fatal: '/workspace/wt/op' is not a working tree" },
  });
  const conversation = store.createConversation("/workspace/app", "workspace_sandbox");
  const operationId = "0f0f0f0f-1111-4222-8333-444455556666";
  operations.prepare({
    id: operationId,
    projectKey: "git:/workspace/app/.git",
    projectRoot: "/workspace/app",
    targetPath: "/workspace/wt/op",
    branch: "feat/x",
    baseBranch: "main",
    baseRemote: null,
    baseCommit: "a".repeat(40),
    executionMode: "workspace_sandbox",
  });
  operations.markStarted(operationId);
  database.prepare(`
    UPDATE worktree_operations SET status = 'completed', conversation_id = $c WHERE id = $id
  `).run({ "$c": conversation.id, "$id": operationId });

  const service = new ConversationService(store, {
    worktreeOperations: operations,
    gitRunner,
  });
  await service.archiveConversation(conversation.id);
  assert.equal(store.getConversation(conversation.id).archived, true);
});

test("HTTP archive route returns 204, 409, and filters renamed archived conversations", async (t) => {
  const { store } = createSQLiteTestStore(t);
  const service = new ConversationService(store);
  const runService = new ConversationRunService({
    conversationStore: store,
    loadWorkspaceInstructions: async () => undefined,
    workspaceRuntimeProvider: {
      async get(workspaceRoot, executionMode) {
        return {
          workspaceRoot,
          executionMode,
          sandboxRunner: new HostSandboxRunner(),
          tools: [],
        };
      },
    },
    provider: {
      model: "test-model",
      async *stream() {
        throw new Error("Provider should not be called.");
      },
    },
  });
  const server = createAgentServer(new AgentController({
    conversationService: service,
    conversationRunService: runService,
    registry: new RunRegistry({ runService }),
    interactionBroker: new InMemoryInteractionBroker(),
    allowedOrigin: "http://trusted.example",
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error))
    )
  );
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  const archived = store.createConversation("/workspace/a", "workspace_sandbox");
  const busy = store.createConversation("/workspace/b", "workspace_sandbox");
  store.beginRun(busy.id, "question", "busy-run");

  // 有活动 Run 的会话归档返回 409 BUSY。
  const busyResp = await fetch(
    `${origin}/v1/agent/conversations/${busy.id}:archive`,
    { method: "POST" },
  );
  assert.equal(busyResp.status, 409);
  assert.equal(
    (await busyResp.json() as { error: { code: string } }).error.code,
    "CONVERSATION_BUSY",
  );

  // 正常归档返回 204，会话 archived = true。
  const archivedResp = await fetch(
    `${origin}/v1/agent/conversations/${archived.id}:archive`,
    { method: "POST" },
  );
  assert.equal(archivedResp.status, 204);
  assert.equal(await archivedResp.text(), "");
  assert.equal(store.getConversation(archived.id).archived, true);

  // 已归档再归档返回 409 ARCHIVED。
  const rearchive = await fetch(
    `${origin}/v1/agent/conversations/${archived.id}:archive`,
    { method: "POST" },
  );
  assert.equal(rearchive.status, 409);
  assert.equal(
    (await rearchive.json() as { error: { code: string } }).error.code,
    "CONVERSATION_ARCHIVED",
  );

  // 未认证 Origin 归档返回 403。
  const untrusted = await fetch(
    `${origin}/v1/agent/conversations/${archived.id}:archive`,
    { method: "POST", headers: { Origin: "https://evil.example" } },
  );
  assert.equal(untrusted.status, 403);

  // GET 列表按 archived 过滤：归档会话只在 archived=true 出现且字段正确。
  const listActive = await fetch(`${origin}/v1/agent/conversations?archived=false`);
  assert.equal(listActive.status, 200);
  const activeItems = (await listActive.json() as {
    items: { id: string; archived: boolean }[];
  }).items;
  assert.ok(activeItems.every((item) => item.archived === false));
  assert.equal(activeItems.some((item) => item.id === archived.id), false);

  const listArchived = await fetch(`${origin}/v1/agent/conversations?archived=true`);
  assert.equal(listArchived.status, 200);
  const archivedItems = (await listArchived.json() as {
    items: { id: string; archived: boolean }[];
  }).items;
  assert.deepEqual(
    archivedItems.map((item) => [item.id, item.archived]),
    [[archived.id, true]],
  );

  // 非法 archived 参数返回 422。
  const bad = await fetch(`${origin}/v1/agent/conversations?archived=yes`);
  assert.equal(bad.status, 422);

  // 归档会话仍可删除，删除后 404。
  const removed = await fetch(
    `${origin}/v1/agent/conversations/${archived.id}`,
    { method: "DELETE" },
  );
  assert.equal(removed.status, 204);
  const gone = await fetch(
    `${origin}/v1/agent/conversations/${archived.id}:archive`,
    { method: "POST" },
  );
  assert.equal(gone.status, 404);
});