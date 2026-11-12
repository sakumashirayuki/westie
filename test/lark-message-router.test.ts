import assert from "node:assert/strict";
import test from "node:test";

import { LarkMessageRouter } from "../src/application/lark-message-router.js";
import { LarkBindingTokenStore } from "../src/application/lark-binding-token-store.js";
import { ConversationBusyError, ConversationNotFoundError, SteeringQueueFullError } from "../src/domain/conversation.js";
import { MAX_STEERING_MESSAGE_BYTES } from "../src/protocol.js";

interface RegistryLike {
  start(command: { conversationId: string; input: string }): { runId: string };
}
interface QueueLike {
  enqueue(runId: string, content: string): number;
}
interface StoreLike {
  findByChatId(chatId: string): unknown;
  bind(binding: { chatId: string; openId: string; conversationId: string; createdAt: string }): unknown;
  unbindByChatId(chatId: string): boolean;
}
interface OutboundLike {
  enqueue(request: { chatId: string; content: string; uuid: string }): Promise<void>;
}
interface ConvStoreLike {
  getActiveRunId(conversationId: string): string | undefined;
}
interface ConversationServiceLike {
  getConversation(conversationId: string): Promise<{ title: string | null; workspace: { name: string } }>;
}
interface BridgeLike {
  register(runId: string, chatId: string): void;
}

interface Harness {
  router: LarkMessageRouter;
  sent: Array<{ chatId: string; content: string; uuid: string }>;
  registry: RegistryLike & { calls: unknown[] };
  tokenStore: LarkBindingTokenStore;
}

export function makeHarness(overrides: {
  allowedOpenIds?: ReadonlySet<string>;
  store?: Partial<StoreLike>;
  conversationStore?: Partial<ConvStoreLike>;
  conversationService?: Partial<ConversationServiceLike>;
  registry?: Partial<RegistryLike>;
  queue?: Partial<QueueLike>;
} = {}): Harness {
  const sent: Array<{ chatId: string; content: string; uuid: string }> = [];
  const outbound: OutboundLike = { enqueue: async (request) => { sent.push(request); } };
  const tokenStore = new LarkBindingTokenStore(() => 0);
  const store: Partial<StoreLike> = overrides.store ?? {};
  const conversationStore: Partial<ConvStoreLike> = overrides.conversationStore ?? {};
  const conversationService: Partial<ConversationServiceLike> = {
    getConversation: async () => ({ title: null, workspace: { name: "proj" } }),
    ...overrides.conversationService,
  };
  const registry: RegistryLike & { calls: unknown[] } = {
    calls: [],
    start(command) {
      this.calls.push(command);
      return { runId: "r-1" };
    },
    ...(overrides.registry as RegistryLike & { calls: unknown[] } | undefined),
  };
  const queue: QueueLike = {
    enqueue: () => 0,
    ...overrides.queue,
  } as never;
  const bridge: BridgeLike = { register: () => {} };
  const router = new LarkMessageRouter({
    store: store as never,
    tokenStore,
    allowedOpenIds: overrides.allowedOpenIds ?? new Set(),
    conversationService: conversationService as never,
    conversationStore: conversationStore as never,
    registry: registry as never,
    steeringQueue: queue as never,
    runBridge: bridge as never,
    outbound,
    now: () => "2026-01-01T00:00:00.000Z",
  } as never);
  return { router, sent, registry, tokenStore };
}

function p2p(
  chatId: string,
  text: string,
  messageId = "om-1",
): import("../src/application/lark-message-router.js").InboundMessageContext {
  return {
    chatId,
    chatType: "p2p",
    senderType: "user",
    senderOpenId: "ou-1",
    messageId,
    messageType: "text",
    text,
  };
}

test("ignores group chats and non-user senders", async () => {
  const h = makeHarness();
  await h.router.route({ ...p2p("oc-1", "hello"), chatType: "group" } as never);
  await h.router.route({ ...p2p("oc-1", "hello"), senderType: "bot" } as never);
  assert.equal(h.sent.length, 0);
});

test("non-text messages get a text-only reply and no run", async () => {
  const h = makeHarness();
  await h.router.route({
    ...p2p("oc-1", ""),
    messageType: "image",
    text: "not-used",
  } as never);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.content, /文本消息/);
  assert.equal(h.registry.calls.length, 0);
});

test("empty text is ignored without a reply", async () => {
  const h = makeHarness();
  await h.router.route(p2p("oc-1", "   "));
  assert.equal(h.sent.length, 0);
});

test("unbound ordinary text gets the binding guide and no conversation access", async () => {
  const h = makeHarness({ store: { findByChatId: () => undefined } });
  await h.router.route(p2p("oc-1", "hi"));
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.content, /绑定/);
  assert.equal(h.registry.calls.length, 0);
});

test("whitelist rejects a sender outside the list and does not bind or run", async () => {
  const h = makeHarness({ allowedOpenIds: new Set(["ou-other"]) });
  await h.router.route(p2p("oc-1", "hi"));
  assert.match(h.sent[0]!.content, /没有权限/);
  assert.equal(h.registry.calls.length, 0);
});

test("idle bound conversation starts a run and sends an ack", async () => {
  const h = makeHarness({
    store: {
      findByChatId: () => ({
        chatId: "oc-1", openId: "ou-1", conversationId: "c1", createdAt: "now",
      }),
    },
    conversationStore: { getActiveRunId: () => undefined },
  });
  await h.router.route(p2p("oc-1", "run tests"));
  assert.equal(h.registry.calls.length, 1);
  assert.deepEqual(h.registry.calls[0], { conversationId: "c1", input: "run tests" });
  assert.match(h.sent[0]!.content, /收到，已开始处理/);
});

test("busy bound conversation enqueues steering and acks", async () => {
  const h = makeHarness({
    store: {
      findByChatId: () => ({
        chatId: "oc-1", openId: "ou-1", conversationId: "c1", createdAt: "now",
      }),
    },
    conversationStore: { getActiveRunId: () => "r-active" },
    queue: { enqueue: (_runId, _content) => 1 },
  });
  await h.router.route(p2p("oc-1", "add lint"));
  assert.equal(h.registry.calls.length, 0);
  assert.match(h.sent[0]!.content, /追加消息/);
});

test("ConversationBusyError during start falls back to steering", async () => {
  // getActiveRunId 先返回一次 undefined（进入空闲分支），registry.start 抛忙，
  // 回退的 #steer 再次读取 active run 并成功入队。
  let calls = 0;
  const h = makeHarness({
    store: {
      findByChatId: () => ({
        chatId: "oc-1", openId: "ou-1", conversationId: "c1", createdAt: "now",
      }),
    },
    conversationStore: {
      getActiveRunId: () => (calls++ === 0 ? undefined : "r-active"),
    },
    registry: {
      start: () => {
        throw new ConversationBusyError("c1");
      },
    },
    queue: { enqueue: () => 1 },
    conversationService: {
      getConversation: async () => ({ title: null, workspace: { name: "proj" } }),
    },
  });
  await h.router.route(p2p("oc-1", "run"));
  assert.equal(h.registry.calls.length, 0);
  assert.match(h.sent.map((item) => item.content).join(" "), /追加消息/);
});

test("steering queue full replies with a clear message", async () => {
  const h = makeHarness({
    store: {
      findByChatId: () => ({
        chatId: "oc-1", openId: "ou-1", conversationId: "c1", createdAt: "now",
      }),
    },
    conversationStore: { getActiveRunId: () => "r-active" },
    queue: {
      enqueue() {
        throw new SteeringQueueFullError();
      },
    },
  });
  await h.router.route(p2p("oc-1", "add"));
  assert.match(h.sent[0]!.content, /已满/);
});

test("deleted conversation is treated as unbound and binding removed", async () => {
  const h = makeHarness({
    store: {
      findByChatId: () => ({
        chatId: "oc-1", openId: "ou-1", conversationId: "c1", createdAt: "now",
      }),
      unbindByChatId: () => true,
    },
    conversationStore: {
      getActiveRunId: () => {
        throw new ConversationNotFoundError("c1");
      },
    },
  });
  await h.router.route(p2p("oc-1", "run"));
  assert.match(h.sent[0]!.content, /已不存在/);
});

test("binding code consumption via the same store is single-use", () => {
  const tokenStore = new LarkBindingTokenStore(() => 0);
  const issued = tokenStore.issue("c1");
  const consumed = tokenStore.consume(issued.code, "oc-1");
  assert.equal(consumed.status, "valid");
  if (consumed.status !== "valid") throw new Error("expected valid");
  assert.equal(consumed.entry.conversationId, "c1");
  assert.equal(tokenStore.consume(issued.code, "oc-2").status, "invalid");
});

test("binding conflict restores the code so the original code stays valid", async () => {
  const h = makeHarness({
    store: {
      findByChatId: () => undefined,
      bind: () => ({ status: "chat_already_bound" }),
    },
  });
  const issued = h.tokenStore.issue("c1");
  await h.router.route(p2p("oc-1", issued.code));
  assert.match(h.sent[0]!.content, /已绑定其他会话/);
  // 冲突不消费码：原码在有效期内仍可用于重试。
  assert.equal(h.tokenStore.consume(issued.code, "oc-1").status, "valid");
});

test("binding to a deleted conversation restores the code and explains the failure", async () => {
  const h = makeHarness({
    store: {
      findByChatId: () => undefined,
      bind: () => {
        throw new ConversationNotFoundError("c1");
      },
    },
  });
  const issued = h.tokenStore.issue("c1");
  await h.router.route(p2p("oc-1", issued.code));
  assert.match(h.sent[0]!.content, /原会话已不存在/);
  assert.equal(h.tokenStore.consume(issued.code, "oc-1").status, "valid");
});

test("oversized inbound text on the idle path is rejected without starting a run", async () => {
  const h = makeHarness({
    store: {
      findByChatId: () => ({
        chatId: "oc-1", openId: "ou-1", conversationId: "c1", createdAt: "now",
      }),
    },
    conversationStore: { getActiveRunId: () => undefined },
  });
  const oversized = "x".repeat(MAX_STEERING_MESSAGE_BYTES + 1);
  await h.router.route(p2p("oc-1", oversized));
  assert.equal(h.registry.calls.length, 0);
  assert.match(h.sent[0]!.content, /16 KiB/);
});

test("oversized inbound text on the busy path is rejected without enqueuing steering", async () => {
  let enqueueCalls = 0;
  const h = makeHarness({
    store: {
      findByChatId: () => ({
        chatId: "oc-1", openId: "ou-1", conversationId: "c1", createdAt: "now",
      }),
    },
    conversationStore: { getActiveRunId: () => "r-active" },
    queue: {
      enqueue: () => {
        enqueueCalls += 1;
        return 1;
      },
    },
  });
  const oversized = "字".repeat(MAX_STEERING_MESSAGE_BYTES / 3 + 1);
  await h.router.route(p2p("oc-1", oversized));
  assert.equal(enqueueCalls, 0);
  assert.match(h.sent[0]!.content, /16 KiB/);
});
