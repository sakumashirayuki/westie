import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryToolGrantStore } from "../src/application/tool-grant-store.js";

test("repeated grants of the same scope are idempotent", () => {
  const store = new InMemoryToolGrantStore();
  const grant = {
    conversationId: "conversation-1",
    toolName: "bash",
    scope: { kind: "command_prefix", value: "npm test" },
  } as const;
  store.grant(grant);
  store.grant(grant);

  assert.equal(
    store.isGranted("conversation-1", "bash", { command: "npm test --silent" }),
    true,
  );
});

test("grants do not cross conversations", () => {
  const store = new InMemoryToolGrantStore();
  store.grant({
    conversationId: "conversation-1",
    toolName: "bash",
    scope: { kind: "command_prefix", value: "npm test" },
  });

  assert.equal(
    store.isGranted("conversation-2", "bash", { command: "npm test" }),
    false,
  );
});

test("clear removes grants for one conversation only", () => {
  const store = new InMemoryToolGrantStore();
  store.grant({
    conversationId: "conversation-1",
    toolName: "bash",
    scope: { kind: "tool" },
  });
  store.grant({
    conversationId: "conversation-2",
    toolName: "bash",
    scope: { kind: "tool" },
  });

  store.clear("conversation-1");

  assert.equal(store.isGranted("conversation-1", "bash", { command: "x" }), false);
  assert.equal(store.isGranted("conversation-2", "bash", { command: "x" }), true);
});

test("a tool-scope grant matches any input for that tool", () => {
  const store = new InMemoryToolGrantStore();
  store.grant({
    conversationId: "conversation-1",
    toolName: "bash",
    scope: { kind: "tool" },
  });

  assert.equal(store.isGranted("conversation-1", "bash", { command: "rm -rf x" }), true);
  assert.equal(store.isGranted("conversation-1", "read", { path: "x" }), false);
});
