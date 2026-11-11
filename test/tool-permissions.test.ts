import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import { InMemoryInteractionBroker } from "../src/application/interaction-broker.js";
import { InMemoryWorkspaceGrantStore } from "../src/application/workspace-grant-store.js";
import { InMemoryToolGrantStore } from "../src/application/tool-grant-store.js";
import {
  AuthorizedToolExecutor,
  composePolicy,
  conversationGrantsUpgradeConfirm,
  createDefaultToolPermissionPolicy,
  FixedToolPermissionPolicy,
  fixedRules,
  fullAccessAllowsEverything,
} from "../src/tool-permissions.js";
import { defineTool, ToolRegistry } from "../src/tools.js";

const context = { workspaceRoot: "/workspace", runId: "run-1" };

test("default tool policy allows file/time/search/skill tools, confirms bash, and denies unknown tools", () => {
  const policy = createDefaultToolPermissionPolicy();
  const decisions = Object.fromEntries(
    ["get_current_time", "read", "write", "edit", "web_search", "web_fetch", "glob", "todo", "skill", "memory", "agent", "bash", "other"].map(
      (name) => [
        name,
        policy.evaluate(
          { name, input: {} },
          context,
        ).effect,
      ],
    ),
  );

  assert.deepEqual(decisions, {
    get_current_time: "allow",
    read: "allow",
    write: "allow",
    edit: "allow",
    web_search: "allow",
    web_fetch: "allow",
    glob: "allow",
    todo: "allow",
    skill: "allow",
    memory: "allow",
    agent: "allow",
    bash: "confirm",
    other: "deny",
  });
});

test("full access allows every tool without approval", () => {
  const policy = createDefaultToolPermissionPolicy();
  for (const name of ["read", "write", "edit", "bash", "other"]) {
    assert.deepEqual(
      policy.evaluate(
        { name, input: {} },
        { ...context, executionMode: "full_access" },
      ),
      { effect: "allow", ruleId: `full-access:${name}:allow` },
    );
  }
});

test("denied and unconfigured tools are hidden from the provider catalog", () => {
  const visible = defineTool({
    name: "visible",
    description: "Visible.",
    inputSchema: z.strictObject({}),
    execute() {
      return {};
    },
  });
  const denied = defineTool({
    name: "denied",
    description: "Denied.",
    inputSchema: z.strictObject({}),
    execute() {
      return {};
    },
  });
  const unconfigured = defineTool({
    name: "unconfigured",
    description: "Unconfigured.",
    inputSchema: z.strictObject({}),
    execute() {
      return {};
    },
  });
  const policy = new FixedToolPermissionPolicy({
    visible: { effect: "allow", ruleId: "visible" },
    denied: { effect: "deny", ruleId: "denied" },
  });

  assert.equal(policy.isVisible(visible, context), true);
  assert.equal(policy.isVisible(denied, context), false);
  assert.equal(policy.isVisible(unconfigured, context), false);
});

test("a direct sensitive-file confirmation grants one exact host read", async () => {
  const tool = defineTool({
    name: "read",
    description: "Read.",
    inputSchema: z.strictObject({}),
    execute() {
      return {};
    },
  });
  const prepared = new ToolRegistry([tool]).prepare("read", {});
  if ("type" in prepared) assert.fail("Expected a prepared tool call.");
  const broker = new InMemoryInteractionBroker();
  const grants = new InMemoryWorkspaceGrantStore();
  const executor = new AuthorizedToolExecutor({
    policy: new FixedToolPermissionPolicy({
      read: { effect: "allow", ruleId: "read" },
    }),
    interactionBroker: broker,
    workspaceGrantStore: grants,
  });
  const pending = executor.createWorkspaceGrant(
    prepared,
    {
      kind: "workspace_grant",
      reason: "sensitive_workspace_file",
      requestedPath: "/workspace/.env",
      canonicalPath: "/workspace/.env",
      access: "read",
      scope: "once",
    },
    {
      context: {
        workspaceRoot: "/workspace",
        runId: "run-1",
        conversationId: "conversation-1",
      },
      step: 1,
      toolCallId: "tool-call-1",
    },
  );
  assert.notEqual(pending, undefined);
  if (pending === undefined) assert.fail("Expected a pending interaction.");

  assert.equal(
    broker.resolve(pending.interactionId, { decision: "approve" }).status,
    "accepted",
  );
  assert.equal(executor.applyWorkspaceGrant(pending, await pending.wait()), true);
  assert.equal(grants.consumeRead({
    conversationId: "conversation-1",
    toolCallId: "tool-call-1",
    canonicalPath: "/workspace/.env",
  }), true);
  pending.dispose();
});

test("a conversation grant turns confirm into allow", () => {
  const grantStore = new InMemoryToolGrantStore();
  grantStore.grant({
    conversationId: "conversation-1",
    toolName: "bash",
    scope: { kind: "command_prefix", value: "npm test" },
  });
  const policy = composePolicy([
    conversationGrantsUpgradeConfirm(grantStore),
    fixedRules({
      bash: { effect: "confirm", ruleId: "default:bash:confirm" },
    }),
  ]);
  const decision = policy.evaluate(
    { name: "bash", input: { command: "npm test --silent" } },
    {
      workspaceRoot: "/workspace",
      runId: "run-1",
      conversationId: "conversation-1",
    },
  );
  assert.deepEqual(decision, {
    effect: "allow",
    ruleId: "conversation-grant:bash:command_prefix:allow",
  });
});

test("a conversation grant cannot turn deny into allow", () => {
  const grantStore = new InMemoryToolGrantStore();
  grantStore.grant({
    conversationId: "conversation-1",
    toolName: "bash",
    scope: { kind: "tool" },
  });
  const policy = composePolicy([
    conversationGrantsUpgradeConfirm(grantStore),
    fixedRules({ bash: { effect: "deny", ruleId: "denied" } }),
  ]);
  const decision = policy.evaluate(
    { name: "bash", input: { command: "rm -rf" } },
    {
      workspaceRoot: "/workspace",
      runId: "run-1",
      conversationId: "conversation-1",
    },
  );
  assert.equal(decision.effect, "deny");
});

test("isVisible does not crash on empty input", () => {
  const grantStore = new InMemoryToolGrantStore();
  const policy = composePolicy([
    fullAccessAllowsEverything,
    conversationGrantsUpgradeConfirm(grantStore),
    fixedRules({}),
  ]);
  const tool = defineTool({
    name: "bash",
    description: "x",
    inputSchema: z.strictObject({}),
    execute() {
      return {};
    },
  });
  assert.equal(
    policy.isVisible(tool, { workspaceRoot: "/w", runId: "run-1" }),
    false,
  );
});

test("full access grant does not change the result", () => {
  const grantStore = new InMemoryToolGrantStore();
  grantStore.grant({
    conversationId: "conversation-1",
    toolName: "bash",
    scope: { kind: "tool" },
  });
  const policy = composePolicy([
    fullAccessAllowsEverything,
    conversationGrantsUpgradeConfirm(grantStore),
    fixedRules({ bash: { effect: "confirm", ruleId: "confirm" } }),
  ]);
  const decision = policy.evaluate(
    { name: "bash", input: {} },
    {
      workspaceRoot: "/workspace",
      runId: "run-1",
      executionMode: "full_access",
      conversationId: "conversation-1",
    },
  );
  assert.deepEqual(decision, {
    effect: "allow",
    ruleId: "full-access:bash:allow",
  });
});

test("the completion check tool needs a fresh approval in workspace mode", () => {
  const grantStore = new InMemoryToolGrantStore();
  // 假设 store 里已经有 stop_hook 的会话级授权，策略也不会把它抬成 allow。
  grantStore.grant({
    conversationId: "conversation-1",
    toolName: "stop_hook",
    scope: { kind: "tool" },
  });
  const policy = createDefaultToolPermissionPolicy({ toolGrantStore: grantStore });
  const scoped = { ...context, conversationId: "conversation-1" };

  assert.deepEqual(
    policy.evaluate({ name: "stop_hook", input: {} }, scoped),
    {
      effect: "confirm",
      ruleId: "default:stop_hook:confirm",
      reason:
        "The project's completion check script runs inside the macOS workspace sandbox.",
    },
  );
  assert.deepEqual(
    policy.evaluate(
      { name: "stop_hook", input: {} },
      { ...scoped, executionMode: "full_access" },
    ),
    { effect: "allow", ruleId: "full-access:stop_hook:allow" },
  );
});
