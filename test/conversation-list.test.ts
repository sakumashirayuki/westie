import assert from "node:assert/strict";
import { HostSandboxRunner } from "../src/sandbox/host-sandbox-runner.js";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import { ConversationRunService } from "../src/application/conversation-run-service.js";
import {
  InvalidConversationListRequestError,
  MAX_CONVERSATION_LIST_LIMIT,
  ConversationService,
} from "../src/application/conversation-service.js";
import { InMemoryInteractionBroker } from "../src/application/interaction-broker.js";
import { RunRegistry } from "../src/application/run-registry.js";
import { AgentController } from "../src/http/agent-controller.js";
import {
  initializeSqliteSchema,
  openSqliteDatabase,
  SQLiteConversationStore,
} from "../src/infrastructure/sqlite/index.js";
import { createAgentServer } from "../src/server.js";
import type { ConversationSummaryView } from "../src/domain/conversation.js";

test("lists lightweight conversation summaries in recently-updated order", async (t) => {
  const { database, store } = await createStore(t);
  const service = new ConversationService(store);
  const first = store.createConversation("/workspace/first", "workspace_sandbox");
  const second = store.createConversation("/workspace/second", "workspace_sandbox");
  const third = store.createConversation("/workspace/third", "workspace_sandbox");
  setUpdatedAt(database, first.id, "2026-07-28T01:00:00.000Z");
  setUpdatedAt(database, second.id, "2026-07-28T03:00:00.000Z");
  setUpdatedAt(database, third.id, "2026-07-28T02:00:00.000Z");

  const page = await service.listConversations();

  assert.deepEqual(
    page.items.map((conversation) => conversation.id),
    [second.id, third.id, first.id],
  );
  assert.equal(page.nextCursor, null);
  assert.deepEqual(page.items[0]?.workspace, {
    name: "second",
    canonicalPath: "/workspace/second",
  });
  assert.equal("turns" in page.items[0]!, false);
});

test("listing an identified project does not probe Git status", async (t) => {
  const { store } = await createStore(t);
  store.createConversation(
    "/workspace/project",
    "workspace_sandbox",
    { projectKey: "git:/workspace/.git", projectRoot: "/workspace" },
    "main",
  );
  const service = new ConversationService(store, {
    statusSource: {
      createProbeCache: () => {
        throw new Error("identified project should not be probed for a list");
      },
      identifyProject: async () => {
        throw new Error("identified project should not be re-identified");
      },
    },
  });

  const page = await service.listConversations();

  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.project?.key, "git:/workspace/.git");
});

test("paginates with an opaque cursor and a deterministic id tie-break", async (t) => {
  const { database, store } = await createStore(t);
  const service = new ConversationService(store);
  const conversations = [
    store.createConversation("/workspace/a", "workspace_sandbox"),
    store.createConversation("/workspace/b", "workspace_sandbox"),
    store.createConversation("/workspace/c", "workspace_sandbox"),
  ];
  for (const conversation of conversations) {
    setUpdatedAt(database, conversation.id, "2026-07-28T04:00:00.000Z");
  }
  const expected = conversations
    .map((conversation) => conversation.id)
    .sort((left, right) => right.localeCompare(left));

  const firstPage = await service.listConversations({ limit: 2 });
  assert.deepEqual(
    firstPage.items.map((conversation) => conversation.id),
    expected.slice(0, 2),
  );
  assert.notEqual(firstPage.nextCursor, null);

  const secondPage = await service.listConversations({
    limit: 2,
    cursor: firstPage.nextCursor!,
  });
  assert.deepEqual(
    secondPage.items.map((conversation) => conversation.id),
    expected.slice(2),
  );
  assert.equal(secondPage.nextCursor, null);
});

test("uses a default page size of 50 and rejects invalid pagination", async (t) => {
  const { store } = await createStore(t);
  const service = new ConversationService(store);
  for (let index = 0; index < 51; index += 1) {
    store.createConversation(`/workspace/${index}`, "workspace_sandbox");
  }

  const page = await service.listConversations();
  assert.equal(page.items.length, 50);
  assert.notEqual(page.nextCursor, null);

  // 分页参数在校验阶段同步抛出，调用方不需要 await 就能拒绝非法请求。
  for (const limit of [0, -1, 1.5, MAX_CONVERSATION_LIST_LIMIT + 1]) {
    assert.throws(
      () => service.listConversations({ limit }),
      InvalidConversationListRequestError,
    );
  }
  for (const cursor of [
    "",
    "not+base64url",
    "x".repeat(513),
    cursorFor({ v: 2, updatedAt: "2026-07-28T00:00:00.000Z", id: "id" }),
    cursorFor({ v: 1, updatedAt: "not-a-date", id: "id" }),
    cursorFor({ v: 1, updatedAt: "2026-07-28T00:00:00.000Z", id: "" }),
    cursorFor({
      v: 1,
      updatedAt: "2026-07-28T00:00:00.000Z",
      id: "id",
      extra: true,
    }),
  ]) {
    assert.throws(
      () => service.listConversations({ cursor }),
      InvalidConversationListRequestError,
    );
  }
});

test("SQLite listing does not read turns, runs, or transcript messages", async (t) => {
  const { database, store } = await createStore(t);
  const conversation = store.createConversation(
    "/workspace/project",
    "workspace_sandbox",
  );
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE transcript_messages;
    DROP TABLE runs;
    DROP TABLE turns;
  `);

  assert.deepEqual(store.listConversations({ limit: 10 }).map(omitStatus), [{
    id: conversation.id,
    revision: 0,
    executionMode: "workspace_sandbox",
    title: null,
    workspace: {
      name: "project",
      canonicalPath: "/workspace/project",
    },
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  }]);
});

test("GET conversations validates query parameters", async (t) => {
  const { database, store } = await createStore(t);
  const older = store.createConversation("/workspace/older", "workspace_sandbox");
  const newer = store.createConversation("/workspace/newer", "workspace_sandbox");
  setUpdatedAt(database, older.id, "2026-07-28T01:00:00.000Z");
  setUpdatedAt(database, newer.id, "2026-07-28T02:00:00.000Z");
  const conversationService = new ConversationService(store);
  const conversationRunService = new ConversationRunService({
    conversationStore: store,
    loadWorkspaceInstructions: async () => undefined,
    workspaceRuntimeProvider: {
      async get(workspaceRoot, executionMode) {
        return { workspaceRoot, executionMode, sandboxRunner: new HostSandboxRunner(), tools: [] };
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
    conversationService,
    conversationRunService,
    registry: new RunRegistry({ runService: conversationRunService }),
    interactionBroker: new InMemoryInteractionBroker(),
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error))
    )
  );
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  const firstResponse = await fetch(
    `${origin}/v1/agent/conversations?limit=1`,
  );
  assert.equal(firstResponse.status, 200);
  const firstPage = await firstResponse.json() as {
    items: {
      id: string;
      turns?: unknown;
      workspace: Record<string, unknown>;
      project: unknown;
      workspaceStatus?: unknown;
      workspaceKind?: unknown;
    }[];
    nextCursor: string | null;
  };
  assert.deepEqual(firstPage.items.map(omitStatus), [{
    id: newer.id,
    revision: 0,
    executionMode: "workspace_sandbox",
    title: null,
    workspace: {
      name: "newer",
    },
    createdAt: newer.createdAt,
    updatedAt: "2026-07-28T02:00:00.000Z",
  }]);
  assert.equal("canonicalPath" in firstPage.items[0]!.workspace, false);
  assert.equal(firstPage.items[0]!.project, null);
  assert.equal("workspaceStatus" in firstPage.items[0]!, false);
  assert.equal("workspaceKind" in firstPage.items[0]!, true);
  assert.notEqual(firstPage.nextCursor, null);

  const secondResponse = await fetch(
    `${origin}/v1/agent/conversations?limit=1&cursor=${
      encodeURIComponent(firstPage.nextCursor!)
    }`,
  );
  assert.equal(secondResponse.status, 200);
  assert.deepEqual(
    (await secondResponse.json() as { items: { id: string }[] }).items
      .map((item) => item.id),
    [older.id],
  );

  const removedCreate = await fetch(`${origin}/v1/agent/conversations`, {
    method: "POST",
  });
  assert.equal(removedCreate.status, 405);

  for (const query of [
    "limit=0",
    "limit=101",
    "limit=1.5",
    "limit=1&limit=2",
    "cursor=",
    "unknown=value",
  ]) {
    const response = await fetch(
      `${origin}/v1/agent/conversations?${query}`,
    );
    assert.equal(response.status, 422);
    assert.equal(
      (await response.json() as { error: { code: string } }).error.code,
      "INVALID_REQUEST",
    );
  }

  const methodNotAllowed = await fetch(
    `${origin}/v1/agent/conversations`,
    { method: "PUT" },
  );
  assert.equal(methodNotAllowed.status, 405);
  assert.equal(
    methodNotAllowed.headers.get("allow"),
    "GET, OPTIONS",
  );
});

test("DELETE conversation enforces deletion, busy, origin, and method contracts", async (t) => {
  const { store } = await createStore(t);
  const conversationService = new ConversationService(store);
  const conversationRunService = new ConversationRunService({
    conversationStore: store,
    loadWorkspaceInstructions: async () => undefined,
    workspaceRuntimeProvider: {
      async get(workspaceRoot, executionMode) {
        return { workspaceRoot, executionMode, sandboxRunner: new HostSandboxRunner(), tools: [] };
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
    conversationService,
    conversationRunService,
    registry: new RunRegistry({ runService: conversationRunService }),
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
  const deletable = store.createConversation(
    "/workspace/deletable",
    "workspace_sandbox",
  );
  const busy = store.createConversation("/workspace/busy", "workspace_sandbox");
  store.beginRun(busy.id, "question", "busy-run");

  const untrusted = await fetch(
    `${origin}/v1/agent/conversations/${deletable.id}`,
    { method: "DELETE", headers: { Origin: "https://evil.example" } },
  );
  assert.equal(untrusted.status, 403);
  assert.equal(
    (await untrusted.json() as { error: { code: string } }).error.code,
    "UNTRUSTED_ORIGIN",
  );
  assert.equal(store.getConversation(deletable.id).id, deletable.id);

  const busyResponse = await fetch(
    `${origin}/v1/agent/conversations/${busy.id}`,
    { method: "DELETE" },
  );
  assert.equal(busyResponse.status, 409);
  assert.equal(
    (await busyResponse.json() as { error: { code: string } }).error.code,
    "CONVERSATION_BUSY",
  );

  const deleted = await fetch(
    `${origin}/v1/agent/conversations/${deletable.id}`,
    { method: "DELETE" },
  );
  assert.equal(deleted.status, 204);
  assert.equal(await deleted.text(), "");

  const missing = await fetch(
    `${origin}/v1/agent/conversations/${deletable.id}`,
    { method: "DELETE" },
  );
  assert.equal(missing.status, 404);
  assert.equal(
    (await missing.json() as { error: { code: string } }).error.code,
    "CONVERSATION_NOT_FOUND",
  );

  const methodNotAllowed = await fetch(
    `${origin}/v1/agent/conversations/${busy.id}`,
    { method: "PUT" },
  );
  assert.equal(methodNotAllowed.status, 405);
  assert.equal(
    methodNotAllowed.headers.get("allow"),
    "GET, PATCH, DELETE, OPTIONS",
  );

  const options = await fetch(
    `${origin}/v1/agent/conversations/${busy.id}`,
    { method: "OPTIONS" },
  );
  assert.equal(options.status, 204);
  assert.equal(
    options.headers.get("access-control-allow-methods"),
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
});

test("OPTIONS preflight advertises PATCH for the conversation path", async (t) => {
  const { store } = await createStore(t);
  const conversationService = new ConversationService(store);
  const conversationRunService = new ConversationRunService({
    conversationStore: store,
    loadWorkspaceInstructions: async () => undefined,
    workspaceRuntimeProvider: {
      async get(workspaceRoot, executionMode) {
        return { workspaceRoot, executionMode, sandboxRunner: new HostSandboxRunner(), tools: [] };
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
    conversationService,
    conversationRunService,
    registry: new RunRegistry({ runService: conversationRunService }),
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

  const preflight = await fetch(
    `http://127.0.0.1:${port}/v1/agent/conversations/abc`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "http://trusted.example",
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "content-type",
      },
    },
  );
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "http://trusted.example",
  );
  // 跨域前端用 PATCH 改名，预检必须放行 PATCH，否则改名在跨域部署下不可用。
  assert.equal(
    preflight.headers.get("access-control-allow-methods"),
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
});

test("the conversation item path rejects unsupported methods with a correct Allow header", async (t) => {
  // PUT /v1/agent/conversations/:id 曾落进"兜底分支"，返回 200 会话详情。
  // 现在方法校验归路由，未知方法统一 405，Allow 由支持的方法生成。
  const { store } = await createStore(t);
  const conversationService = new ConversationService(store);
  const conversationRunService = new ConversationRunService({
    conversationStore: store,
    loadWorkspaceInstructions: async () => undefined,
    workspaceRuntimeProvider: {
      async get(workspaceRoot, executionMode) {
        return { workspaceRoot, executionMode, sandboxRunner: new HostSandboxRunner(), tools: [] };
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
    conversationService,
    conversationRunService,
    registry: new RunRegistry({ runService: conversationRunService }),
    interactionBroker: new InMemoryInteractionBroker(),
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error))
    )
  );
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const conversation = store.createConversation("/workspace/item", "workspace_sandbox");
  const url = `${base}/v1/agent/conversations/${conversation.id}`;

  for (const method of ["PUT", "POST", "HEAD"]) {
    const rejected = await fetch(url, { method });
    assert.equal(rejected.status, 405, `${method} should be 405`);
    assert.equal(
      rejected.headers.get("allow"),
      "GET, PATCH, DELETE, OPTIONS",
      `${method} should advertise the methods actually supported`,
    );
  }

  // 三种受支持的方法都仍然可用。
  const read = await fetch(url);
  assert.equal(read.status, 200);
  assert.equal((await read.json() as { id: string }).id, conversation.id);

  const renamed = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "路由收敛" }),
  });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json() as { title: string }).title, "路由收敛");

  const deleted = await fetch(url, { method: "DELETE" });
  assert.equal(deleted.status, 204);
});

test("PATCH conversation renames, clears, and enforces its contracts", async (t) => {
  const { database, store } = await createStore(t);
  const conversationService = new ConversationService(store);
  const conversationRunService = new ConversationRunService({
    conversationStore: store,
    loadWorkspaceInstructions: async () => undefined,
    workspaceRuntimeProvider: {
      async get(workspaceRoot, executionMode) {
        return { workspaceRoot, executionMode, sandboxRunner: new HostSandboxRunner(), tools: [] };
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
    conversationService,
    conversationRunService,
    registry: new RunRegistry({ runService: conversationRunService }),
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
  const target = store.createConversation("/workspace/target", "workspace_sandbox");
  const busy = store.createConversation("/workspace/busy", "workspace_sandbox");
  store.beginRun(busy.id, "question", "busy-run");
  const path = (id: string) => `${origin}/v1/agent/conversations/${id}`;

  const renamed = await fetch(path(target.id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "  重命名后的会话  " }),
  });
  assert.equal(renamed.status, 200);
  const renamedBody = await renamed.json() as {
    title: string | null;
    revision: number;
    updatedAt: string;
    workspace: { name: string };
  };
  // 服务端去掉首尾空白；改名不改变 revision 与 updatedAt。
  assert.equal(renamedBody.title, "重命名后的会话");
  assert.equal(renamedBody.revision, target.revision);
  assert.equal(renamedBody.updatedAt, target.updatedAt);
  assert.equal(renamedBody.workspace.name, "target");

  // 列表里带出 title；位置仍由 updated_at 决定，改名没有改动 updated_at。
  setUpdatedAt(database, target.id, "2026-07-28T03:00:00.000Z");
  setUpdatedAt(database, busy.id, "2026-07-28T01:00:00.000Z");
  const listed = await conversationService.listConversations();
  assert.deepEqual(
    listed.items.map((item) => item.id),
    [target.id, busy.id],
  );
  assert.equal(
    store.getConversation(target.id).updatedAt,
    "2026-07-28T03:00:00.000Z",
  );
  assert.equal(
    listed.items.find((item) => item.id === target.id)?.title,
    "重命名后的会话",
  );

  const blank = await fetch(path(target.id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "   " }),
  });
  assert.equal(blank.status, 200);
  assert.equal((await blank.json() as { title: string | null }).title, null);

  const tooLong = await fetch(path(target.id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "x".repeat(121) }),
  });
  assert.equal(tooLong.status, 422);
  assert.equal(
    (await tooLong.json() as { error: { code: string } }).error.code,
    "INVALID_REQUEST",
  );

  const malformed = await fetch(path(target.id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: 42 }),
  });
  assert.equal(malformed.status, 422);

  const busyResponse = await fetch(path(busy.id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "运行中改名" }),
  });
  assert.equal(busyResponse.status, 409);
  assert.equal(
    (await busyResponse.json() as { error: { code: string } }).error.code,
    "CONVERSATION_BUSY",
  );
  assert.equal(store.getConversation(busy.id).title, null);

  const untrusted = await fetch(path(target.id), {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://evil.example",
    },
    body: JSON.stringify({ title: "恶意来源" }),
  });
  assert.equal(untrusted.status, 403);
  assert.equal(
    (await untrusted.json() as { error: { code: string } }).error.code,
    "UNTRUSTED_ORIGIN",
  );
  assert.equal(store.getConversation(target.id).title, null);

  const missing = await fetch(path("00000000-0000-4000-8000-000000000000"), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "不存在" }),
  });
  assert.equal(missing.status, 404);
  assert.equal(
    (await missing.json() as { error: { code: string } }).error.code,
    "CONVERSATION_NOT_FOUND",
  );
});

async function createStore(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "agent-conversation-list-"));
  const database = openSqliteDatabase(join(directory, "agent.sqlite"));
  initializeSqliteSchema(database);
  const store = new SQLiteConversationStore(database);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { database, store };
}

function setUpdatedAt(
  database: ReturnType<typeof openSqliteDatabase>,
  conversationId: string,
  updatedAt: string,
): void {
  database.prepare(`
    UPDATE conversations
    SET updated_at = $updatedAt
    WHERE id = $id
  `).run({ "$updatedAt": updatedAt, "$id": conversationId });
}

function cursorFor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** 列表写入的补充字段（项目归属、工作目录实时状态）在这里不参与比较。 */
function omitStatus(
  summary: ConversationSummaryView | Record<string, unknown>,
): Record<string, unknown> {
  const {
    project: _project,
    workspaceKind: _workspaceKind,
    workspaceStatus: _workspaceStatus,
    archived: _archived,
    larkBound: _larkBound,
    ...rest
  } = summary as ConversationSummaryView & { larkBound?: boolean };
  return rest;
}
