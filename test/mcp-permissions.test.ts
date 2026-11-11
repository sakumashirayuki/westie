import assert from "node:assert/strict";
import test from "node:test";

import {
  composePolicy,
  createDefaultToolPermissionPolicy,
  fixedRules,
  mcpToolsNeedConfirmation,
} from "../src/tool-permissions.js";
import { InMemoryToolGrantStore } from "../src/application/tool-grant-store.js";

const sandbox = { workspaceRoot: "/w", runId: "r1" };

test("mcp__ tools are confirm in workspace_sandbox", () => {
  const policy = createDefaultToolPermissionPolicy();
  const decision = policy.evaluate(
    { name: "mcp__github__create_issue", input: {} },
    sandbox,
  );
  assert.equal(decision.effect, "confirm");
  assert.equal(decision.ruleId, "default:mcp:confirm");
});

test("mcp__ tools are allow in full_access", () => {
  const policy = createDefaultToolPermissionPolicy();
  const decision = policy.evaluate(
    { name: "mcp__github__create_issue", input: {} },
    { ...sandbox, executionMode: "full_access" },
  );
  assert.equal(decision.effect, "allow");
});

test("a conversation tool grant turns mcp confirm into allow", () => {
  const grants = new InMemoryToolGrantStore();
  grants.grant({
    conversationId: "c1",
    toolName: "mcp__github__create_issue",
    scope: { kind: "tool" },
  });
  const policy = createDefaultToolPermissionPolicy({ toolGrantStore: grants });
  const decision = policy.evaluate(
    { name: "mcp__github__create_issue", input: {} },
    { ...sandbox, conversationId: "c1" },
  );
  assert.equal(decision.effect, "allow");
});

test("non-mcp unknown tools remain deny", () => {
  const policy = composePolicy([mcpToolsNeedConfirmation, fixedRules({})]);
  assert.equal(
    policy.evaluate({ name: "other", input: {} }, sandbox).effect,
    "deny",
  );
});

test("mcp prefix policy keeps inner decision when not deny", () => {
  const policy = composePolicy([
    mcpToolsNeedConfirmation,
    fixedRules({ bash: { effect: "confirm", ruleId: "c" } }),
  ]);
  assert.equal(
    policy.evaluate({ name: "bash", input: {} }, sandbox).effect,
    "confirm",
  );
});

test("mcp tools are visible even without a rule", () => {
  const policy = composePolicy([mcpToolsNeedConfirmation, fixedRules({})]);
  const tool = {
    name: "mcp__x__y",
    description: "",
    impact: "",
    inputSchema: { parse: () => ({}) },
    summarizeInput: () => null,
    async execute() {
      return null;
    },
  } as never;
  assert.equal(policy.isVisible(tool, sandbox), true);
});
