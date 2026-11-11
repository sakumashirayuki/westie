import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryInteractionBroker,
  type ToolApprovalInteraction,
} from "../src/application/interaction-broker.js";

const interaction: ToolApprovalInteraction = {
  kind: "tool_approval",
  runId: "run-1",
  step: 1,
  toolCallId: "call-1",
  toolName: "bash",
  ruleId: "bash-confirm",
  argumentsDigest: "digest",
  argumentsSummary: { command: "pwd" },
  risk: "Runs a shell command.",
  impact: "Runs one command.",
  grantOptions: [
    { kind: "command_prefix", value: "pwd" },
    { kind: "tool" },
  ],
  conversationId: "conversation-1",
};

test("resolves one pending interaction and makes matching retries idempotent", async () => {
  const broker = new InMemoryInteractionBroker();
  const pending = broker.create(interaction);

  assert.equal(broker.pendingCount, 1);
  assert.deepEqual(
    broker.resolve(pending.interactionId, { decision: "approve" }),
    { status: "accepted" },
  );
  assert.deepEqual(await pending.wait(), {
    status: "responded",
    response: { decision: "approve" },
  });
  assert.deepEqual(
    broker.resolve(pending.interactionId, { decision: "approve" }),
    { status: "idempotent" },
  );
  assert.deepEqual(
    broker.resolve(pending.interactionId, { decision: "deny" }),
    { status: "conflict" },
  );

  pending.dispose();
  assert.equal(broker.pendingCount, 0);
  assert.deepEqual(
    broker.resolve(pending.interactionId, { decision: "approve" }),
    { status: "idempotent" },
  );
});

test("expires an interaction and rejects responses after expiry", async () => {
  const broker = new InMemoryInteractionBroker({ defaultTimeoutMs: 5 });
  const pending = broker.create(interaction);

  assert.deepEqual(await pending.wait(), { status: "expired" });
  assert.deepEqual(
    broker.resolve(pending.interactionId, { decision: "approve" }),
    { status: "gone" },
  );
  pending.dispose();
  assert.equal(broker.pendingCount, 0);
});

test("abort rejects the waiter with the original reason and clears pending state", async () => {
  const broker = new InMemoryInteractionBroker();
  const pending = broker.create(interaction);
  const controller = new AbortController();
  const reason = new Error("stop");
  const waiting = pending.wait(controller.signal);

  controller.abort(reason);

  await assert.rejects(waiting, (error) => error === reason);
  assert.equal(broker.pendingCount, 0);
  assert.deepEqual(
    broker.resolve(pending.interactionId, { decision: "approve" }),
    { status: "gone" },
  );
  pending.dispose();
});

test("concurrent responses are first-wins", async () => {
  const broker = new InMemoryInteractionBroker();
  const pending = broker.create(interaction);

  const results = await Promise.all([
    Promise.resolve().then(() =>
      broker.resolve(pending.interactionId, { decision: "approve" }),
    ),
    Promise.resolve().then(() =>
      broker.resolve(pending.interactionId, { decision: "deny" }),
    ),
  ]);

  assert.deepEqual(
    results.map((result) => result.status).sort(),
    ["accepted", "conflict"],
  );
  assert.equal((await pending.wait()).status, "responded");
  pending.dispose();
});

test("workspace grants can only be approved with their bound canonical path", async () => {
  const broker = new InMemoryInteractionBroker();
  const pending = broker.create({
    kind: "workspace_grant",
    reason: "outside_workspace",
    runId: "run-1",
    step: 1,
    toolCallId: "call-1",
    toolName: "read",
    conversationId: "conversation-1",
    requestedPath: "/canonical/requested.txt",
    canonicalPath: "/canonical/requested.txt",
    access: "read",
    scope: "once",
  });

  assert.deepEqual(broker.inspect(pending.interactionId), {
    status: "pending",
    interaction: pending.interaction,
  });
  assert.deepEqual(
    broker.resolve(pending.interactionId, { decision: "approve" }),
    { status: "invalid_response" },
  );
  assert.deepEqual(
    broker.resolve(pending.interactionId, {
      decision: "approve",
      selectedPath: "/canonical/other.txt",
    }),
    { status: "invalid_response" },
  );
  assert.deepEqual(
    broker.resolve(pending.interactionId, {
      decision: "approve",
      selectedPath: "/canonical/requested.txt",
    }),
    { status: "accepted" },
  );
  assert.deepEqual(await pending.wait(), {
    status: "responded",
    response: {
      decision: "approve",
      selectedPath: "/canonical/requested.txt",
    },
  });
  pending.dispose();
});

test("sensitive workspace grants can be approved without a file picker", async () => {
  const broker = new InMemoryInteractionBroker();
  const pending = broker.create({
    kind: "workspace_grant",
    reason: "sensitive_workspace_file",
    runId: "run-1",
    step: 1,
    toolCallId: "call-1",
    toolName: "read",
    conversationId: "conversation-1",
    requestedPath: "/workspace/.env",
    canonicalPath: "/workspace/.env",
    access: "read",
    scope: "once",
  });

  assert.deepEqual(
    broker.resolve(pending.interactionId, { decision: "approve" }),
    { status: "accepted" },
  );
  assert.deepEqual(await pending.wait(), {
    status: "responded",
    response: { decision: "approve" },
  });
  pending.dispose();
});

test("grant requires approve and a grantOptions member, and replays compare it", async () => {
  const broker = new InMemoryInteractionBroker();
  const pending = broker.create(interaction);

  assert.deepEqual(
    broker.resolve(pending.interactionId, {
      decision: "deny",
      grant: { kind: "command_prefix", value: "pwd" },
    }),
    { status: "invalid_response" },
  );
  assert.deepEqual(
    broker.resolve(pending.interactionId, {
      decision: "approve",
      grant: { kind: "command_prefix", value: "npm" },
    }),
    { status: "invalid_response" },
  );
  assert.deepEqual(
    broker.resolve(pending.interactionId, {
      decision: "approve",
      grant: { kind: "command_prefix", value: "pwd" },
    }),
    { status: "accepted" },
  );
  assert.deepEqual(
    broker.resolve(pending.interactionId, {
      decision: "approve",
      grant: { kind: "command_prefix", value: "pwd" },
    }),
    { status: "idempotent" },
  );
  assert.deepEqual(
    broker.resolve(pending.interactionId, {
      decision: "approve",
      grant: { kind: "tool" },
    }),
    { status: "conflict" },
  );
  assert.deepEqual(await pending.wait(), {
    status: "responded",
    response: {
      decision: "approve",
      grant: { kind: "command_prefix", value: "pwd" },
    },
  });
  pending.dispose();
});
