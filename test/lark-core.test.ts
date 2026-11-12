import assert from "node:assert/strict";
import test from "node:test";

import {
  LarkBindingTokenStore,
  MAX_BINDING_FAILURES_PER_WINDOW,
} from "../src/application/lark-binding-token-store.js";
import { normalizeBindingCode } from "../src/application/lark-message-router.js";
import { LarkOutbound, MAX_OUTBOUND_CHUNK_BYTES } from "../src/application/lark-outbound.js";

test("binding code format is WST- + 6 chars from the non-confusable alphabet", () => {
  let ms = 1000;
  const store = new LarkBindingTokenStore(() => (ms += 1000));
  const issued = store.issue("conversation-1");
  assert.match(issued.code, /^WST-[A-Z2-9]{6}$/);
  assert.ok(!/O|I|0|1/.test(issued.code));
});

test("binding code is single-use and correct on resubmission fails", () => {
  let ms = 1000;
  const store = new LarkBindingTokenStore(() => (ms += 1000));
  const issued = store.issue("c1");
  const first = store.consume(issued.code, "chat-1");
  assert.equal(first.status, "valid");
  if (first.status !== "valid") throw new Error("expected a valid consumption");
  assert.deepEqual(
    { code: first.entry.code, conversationId: first.entry.conversationId },
    { code: issued.code, conversationId: "c1" },
  );
  assert.equal(typeof first.entry.expiresAt, "number");
  // 二次使用无效（已消费）。
  assert.equal(store.consume(issued.code, "chat-2").status, "invalid");
});

test("restored binding code becomes valid again after a failed bind", () => {
  let ms = 1000;
  const store = new LarkBindingTokenStore(() => (ms += 1000));
  const issued = store.issue("c1");
  const consumed = store.consume(issued.code, "chat-1");
  if (consumed.status !== "valid") throw new Error("expected a valid consumption");
  // 模拟绑定落库失败后还码。
  store.restore(consumed.entry);
  const again = store.consume(issued.code, "chat-1");
  assert.equal(again.status, "valid");
});

test("restore does not override a freshly issued code for the same conversation", () => {
  let ms = 1000;
  const store = new LarkBindingTokenStore(() => (ms += 1000));
  const first = store.issue("c1");
  const consumed = store.consume(first.code, "chat-1");
  if (consumed.status !== "valid") throw new Error("expected a valid consumption");
  // 用户在冲突后重新签发：新码优先，旧码即使被还回也保持失效。
  const reissued = store.issue("c1");
  store.restore(consumed.entry);
  assert.equal(store.consume(first.code, "chat-1").status, "invalid");
  assert.equal(store.consume(reissued.code, "chat-1").status, "valid");
});

test("restore never revives an expired code", () => {
  let ms = 5_000;
  const store = new LarkBindingTokenStore(() => (ms += 1));
  const issued = store.issue("c1");
  const consumed = store.consume(issued.code, "chat-1");
  if (consumed.status !== "valid") throw new Error("expected a valid consumption");
  ms += 10 * 60 * 1000;
  store.restore(consumed.entry);
  assert.equal(store.consume(issued.code, "chat-1").status, "invalid");
});

test("expired binding code is invalid and does not consume a fresh one on retry", () => {
  let ms = 5_000;
  const store = new LarkBindingTokenStore(() => (ms += 1));
  const issued = store.issue("c1");
  // 快进到过期之后。
  ms += 10 * 60 * 1000;
  // 同一码过期后：先失败，再重新签发后成功。
  assert.equal(store.consume(issued.code, "chat-1").status, "invalid");
  const reissued = store.issue("c1");
  assert.equal(
    store.consume(reissued.code, "chat-1").status,
    "valid",
  );
});

test("re-issuing for a conversation invalidates the old code", () => {
  let ms = 1000;
  const store = new LarkBindingTokenStore(() => (ms += 1000));
  const first = store.issue("c1");
  const _second = store.issue("c1");
  assert.equal(store.consume(first.code, "chat-1").status, "invalid");
});

test("enumeration protection blocks a chat after too many failures", () => {
  let ms = 1000;
  const store = new LarkBindingTokenStore(() => (ms += 1000));
  for (let index = 0; index < MAX_BINDING_FAILURES_PER_WINDOW; index += 1) {
    assert.equal(store.consume("WST-AAAAAA", "chat-1").status, "invalid");
  }
  assert.equal(store.isBlocked("chat-1"), true);
  // 其它 chat 不受影响。
  assert.equal(store.isBlocked("chat-2"), false);
});

test("normalizeBindingCode trims, uppercases and drops spaces", () => {
  assert.equal(normalizeBindingCode("  wst-8f3k2q  "), "WST-8F3K2Q");
  assert.equal(normalizeBindingCode("wst 8f 3k 2q"), "WST-8F3K2Q");
  assert.equal(normalizeBindingCode(" hello "), null);
});

test("outbound chunking splits by byte budget without cutting multibyte characters", () => {
  const outbound = new LarkOutbound({
    client: { sendMessage: async () => ({ status: "sent" }) },
  });
  const text = "中".repeat(MAX_OUTBOUND_CHUNK_BYTES + 10);
  const chunks = outbound.chunkText(text);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, "utf8") <= MAX_OUTBOUND_CHUNK_BYTES);
    assert.ok(Buffer.byteLength(chunk, "utf8") > 0);
  }
  assert.equal(chunks.join(""), text);
});

test("outbound serializes per chat and retries with constant uuid", async () => {
  let sends = 0;
  const attempts: string[] = [];
  const client = {
    sendMessage: async (request: { chatId: string; content: string; uuid: string }) => {
      attempts.push(request.uuid);
      sends += 1;
      // 第一次失败，重试成功。
      return sends === 1
        ? { status: "failed" as const, code: -1 as const, message: "temp" }
        : { status: "sent" as const };
    },
  };
  const outbound = new LarkOutbound({ client, now: () => 0 });
  await outbound.enqueue({
    chatId: "oc-1",
    content: "hi",
    uuid: "westie-ack-u",
  });
  // 重试时 uuid 保持不变。
  assert.deepEqual(attempts, ["westie-ack-u", "westie-ack-u"]);
});

test("close aborts retry waits and settles the chain without waiting out delays", async () => {
  const client = {
    sendMessage: async () => ({
      status: "failed" as const,
      code: -1 as const,
      message: "down",
    }),
  };
  const outbound = new LarkOutbound({ client, now: () => 0 });
  // 首次发送失败后进入 2 秒重试等待；不 close 的话整条链要跑满 72 秒。
  const settled = outbound.enqueue({
    chatId: "oc-1",
    content: "hi",
    uuid: "westie-ack-u",
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  outbound.close();
  const startedAt = Date.now();
  await settled;
  assert.ok(Date.now() - startedAt < 1_000, "chain should settle promptly after close");
});

test("enqueue after close drops the message without calling the client", async () => {
  const calls: string[] = [];
  const client = {
    sendMessage: async (request: { uuid: string }) => {
      calls.push(request.uuid);
      return { status: "sent" as const };
    },
  };
  const outbound = new LarkOutbound({ client });
  outbound.close();
  await outbound.enqueue({ chatId: "oc-1", content: "hi", uuid: "westie-dropped" });
  assert.deepEqual(calls, []);
});
