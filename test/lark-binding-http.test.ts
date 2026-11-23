import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ConversationService } from "../src/application/conversation-service.js";
import { ConversationRunService } from "../src/application/conversation-run-service.js";
import { InMemoryInteractionBroker } from "../src/application/interaction-broker.js";
import { LarkBindingTokenStore } from "../src/application/lark-binding-token-store.js";
import { RunRegistry } from "../src/application/run-registry.js";
import { AgentController } from "../src/http/agent-controller.js";
import { LarkBindingRoutes } from "../src/http/lark-binding-routes.js";
import { createAgentServer } from "../src/server.js";
import {
  initializeSqliteSchema,
  LarkBindingStore,
  openSqliteDatabase,
  SQLiteConversationStore,
} from "../src/infrastructure/sqlite/index.js";

test("lark capability, binding issue/get/unbind round-trip over HTTP", async (t) => {
  const database = openSqliteDatabase(":memory:");
  initializeSqliteSchema(database);
  const conversationStore = new SQLiteConversationStore(database);
  const larkBindingStore = new LarkBindingStore(database);
  const conversation = conversationStore.createConversation(
    "/workspace/lark",
    "workspace_sandbox",
  );
  const conversationService = new ConversationService(conversationStore);
  const conversationRunService = new ConversationRunService({
    conversationStore,
    loadWorkspaceInstructions: async () => undefined,
    workspaceRuntimeProvider: {
      async get(workspaceRoot, executionMode) {
        return { workspaceRoot, executionMode, sandboxRunner: { run: async () => { throw new Error("n/a"); } } as never, tools: [] };
      },
    },
    provider: {
      model: "test",
      async *stream() {
        throw new Error("provider should not be called");
      },
    },
  });
  const controller = new AgentController({
    conversationService,
    conversationRunService,
    registry: new RunRegistry({ runService: conversationRunService }),
    interactionBroker: new InMemoryInteractionBroker(),
    larkBindingRoutes: new LarkBindingRoutes({
      bindingStore: larkBindingStore,
      tokenStore: new LarkBindingTokenStore(() => 1_700_000_000_000),
      conversationService,
      bridgeEnabled: true,
    }),
    larkBindingStore,
  });
  const server = createAgentServer(controller);
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); database.close(); }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  // capability
  const cap = await (await fetch(`${origin}/v1/agent/lark/capability`)).json();
  assert.deepEqual(cap, { enabled: true });

  // 列表携带 larkBound 装饰字段（未绑定为 false）。
  const list = await (await fetch(`${origin}/v1/agent/conversations`)).json() as { items: Array<{ larkBound: boolean }> };
  assert.equal((list.items[0] as { larkBound: boolean }).larkBound, false);

  // 签发绑定码。
  const code = await (
    await fetch(
      `${origin}/v1/agent/conversations/${conversation.id}/lark-binding/code`,
      { method: "POST" },
    )
  ).json() as { code: string; expiresAt: string };
  assert.match(code.code, /^WST-/);
  assert.ok(typeof code.expiresAt === "string");

  // 通过数据库完成一次绑定，GET 返回已绑定。
  larkBindingStore.bind({
    chatId: "oc-1",
    openId: "ou-1",
    conversationId: conversation.id,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const bound = await (
    await fetch(
      `${origin}/v1/agent/conversations/${conversation.id}/lark-binding`,
    )
  ).json() as { bound: boolean; createdAt?: string };
  assert.deepEqual(bound, { bound: true, createdAt: "2026-01-01T00:00:00.000Z" });
  const listAfter = await (await fetch(`${origin}/v1/agent/conversations`)).json() as { items: Array<{ larkBound: boolean }> };
  assert.equal(listAfter.items[0].larkBound, true);

  // 解绑。
  const unbind = await fetch(
    `${origin}/v1/agent/conversations/${conversation.id}/lark-binding`,
    { method: "DELETE" },
  );
  assert.equal(unbind.status, 200);
  const after = await (
    await fetch(`${origin}/v1/agent/conversations/${conversation.id}/lark-binding`)
  ).json() as { bound: boolean };
  assert.deepEqual(after, { bound: false });

  // 不存在的会话返回 404。
  const missing = await fetch(
    `${origin}/v1/agent/conversations/no-such/lark-binding/code`,
    { method: "POST" },
  );
  assert.equal(missing.status, 404);
});

test("trusted Lark binding routes honor the configured allowedOrigin", async (t) => {
  const database = openSqliteDatabase(":memory:");
  initializeSqliteSchema(database);
  const conversationStore = new SQLiteConversationStore(database);
  const larkBindingStore = new LarkBindingStore(database);
  const conversation = conversationStore.createConversation(
    "/workspace/lark-origin",
    "workspace_sandbox",
  );
  const conversationService = new ConversationService(conversationStore);
  const conversationRunService = new ConversationRunService({
    conversationStore,
    loadWorkspaceInstructions: async () => undefined,
    workspaceRuntimeProvider: {
      async get(workspaceRoot, executionMode) {
        return { workspaceRoot, executionMode, sandboxRunner: { run: async () => { throw new Error("n/a"); } } as never, tools: [] };
      },
    },
    provider: {
      model: "test",
      async *stream() {
        throw new Error("provider should not be called");
      },
    },
  });
  const controller = new AgentController({
    conversationService,
    conversationRunService,
    registry: new RunRegistry({ runService: conversationRunService }),
    interactionBroker: new InMemoryInteractionBroker(),
    larkBindingRoutes: new LarkBindingRoutes({
      bindingStore: larkBindingStore,
      tokenStore: new LarkBindingTokenStore(),
      conversationService,
      bridgeEnabled: true,
      allowedOrigin: "http://localhost:5173",
    }),
    larkBindingStore,
  });
  const server = createAgentServer(controller);
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); database.close(); }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const codeUrl =
    `${origin}/v1/agent/conversations/${conversation.id}/lark-binding/code`;
  const bindingUrl =
    `${origin}/v1/agent/conversations/${conversation.id}/lark-binding`;

  // 显式允许的跨域 Origin 可以执行写操作；修复前 context 为空会误判 403。
  const allowed = await fetch(codeUrl, {
    method: "POST",
    headers: { Origin: "http://localhost:5173" },
  });
  assert.equal(allowed.status, 200);

  // 不可信 Origin 的写操作被守卫拦截。
  const evilIssue = await fetch(codeUrl, {
    method: "POST",
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(evilIssue.status, 403);
  assert.equal(
    (await evilIssue.json() as { error: { code: string } }).error.code,
    "UNTRUSTED_ORIGIN",
  );
  const evilUnbind = await fetch(bindingUrl, {
    method: "DELETE",
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(evilUnbind.status, 403);

  // GET 类端点声明为 public，任意 Origin 都能读。
  const evilCapability = await fetch(`${origin}/v1/agent/lark/capability`, {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(evilCapability.status, 200);

  // 可信 Origin 的解绑正常放行。
  const allowedUnbind = await fetch(bindingUrl, {
    method: "DELETE",
    headers: { Origin: "http://localhost:5173" },
  });
  assert.equal(allowedUnbind.status, 200);
});

test("rename response keeps the larkBound decoration in sync with the binding", async (t) => {
  const database = openSqliteDatabase(":memory:");
  initializeSqliteSchema(database);
  const conversationStore = new SQLiteConversationStore(database);
  const larkBindingStore = new LarkBindingStore(database);
  const conversation = conversationStore.createConversation(
    "/workspace/lark-rename",
    "workspace_sandbox",
  );
  const conversationService = new ConversationService(conversationStore);
  const conversationRunService = new ConversationRunService({
    conversationStore,
    loadWorkspaceInstructions: async () => undefined,
    workspaceRuntimeProvider: {
      async get(workspaceRoot, executionMode) {
        return { workspaceRoot, executionMode, sandboxRunner: { run: async () => { throw new Error("n/a"); } } as never, tools: [] };
      },
    },
    provider: {
      model: "test",
      async *stream() {
        throw new Error("provider should not be called");
      },
    },
  });
  const controller = new AgentController({
    conversationService,
    conversationRunService,
    registry: new RunRegistry({ runService: conversationRunService }),
    interactionBroker: new InMemoryInteractionBroker(),
    larkBindingRoutes: new LarkBindingRoutes({
      bindingStore: larkBindingStore,
      tokenStore: new LarkBindingTokenStore(),
      conversationService,
      bridgeEnabled: true,
    }),
    larkBindingStore,
  });
  const server = createAgentServer(controller);
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); database.close(); }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const itemUrl = `${origin}/v1/agent/conversations/${conversation.id}`;

  larkBindingStore.bind({
    chatId: "oc-rename",
    openId: "ou-1",
    conversationId: conversation.id,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  const renamed = await fetch(itemUrl, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "绑定后的新名字" }),
  });
  assert.equal(renamed.status, 200);
  assert.equal(
    (await renamed.json() as { larkBound: boolean }).larkBound,
    true,
  );

  larkBindingStore.unbindByConversationId(conversation.id);
  const renamedAgain = await fetch(itemUrl, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "解绑后的名字" }),
  });
  assert.equal(renamedAgain.status, 200);
  assert.equal(
    (await renamedAgain.json() as { larkBound: boolean }).larkBound,
    false,
  );
});