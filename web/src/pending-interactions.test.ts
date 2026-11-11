import { describe, expect, it } from "vitest";

import type { ConversationTurnState } from "./conversation-state";
import { selectPendingInteractions } from "./pending-interactions";
import { initialRunState, type StepTrace } from "./run-state";

const pendingApproval = {
  interactionId: "approval-1",
  status: "pending" as const,
  expiresAt: "2026-08-25T10:00:00.000Z",
  ruleId: "default:bash:confirm",
  argumentsDigest: "9b2",
  risk: "Bash can execute arbitrary commands.",
  impact: "Runs one zsh command.",
  grantOptions: [{ kind: "command_prefix" as const, value: "npm test" }],
};

const pendingGrant = {
  interactionId: "grant-1",
  toolCallId: "call-read",
  toolName: "read",
  status: "pending" as const,
  expiresAt: "2026-08-25T10:00:00.000Z",
  requestedPath: "/Users/me/data/input.csv",
  reason: "outside_workspace" as const,
  access: "read" as const,
  scope: "once" as const,
};

function runningTurn(steps: StepTrace[]): ConversationTurnState {
  return {
    id: "turn-1",
    userMessage: "跑一下测试",
    subAgentRuns: {},
    subAgentDescriptions: {},
    run: { ...initialRunState, status: "running", steps },
  };
}

describe("selectPendingInteractions", () => {
  it("collects pending interactions across steps in trace order", () => {
    const pending = selectPendingInteractions(runningTurn([
      {
        number: 1,
        actionType: "tool",
        assistantText: "",
        workspaceGrants: [pendingGrant],
        tools: [],
      },
      {
        number: 3,
        actionType: "tool",
        assistantText: "",
        workspaceGrants: [],
        tools: [{
          id: "call-bash",
          name: "bash",
          status: "approval_required",
          arguments: { command: "npm test" },
          approval: pendingApproval,
        }],
      },
    ]));

    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({
      kind: "workspace_grant",
      interactionId: "grant-1",
      step: 1,
    });
    expect(pending[1]).toMatchObject({
      kind: "tool_approval",
      interactionId: "approval-1",
      step: 3,
    });
  });

  it("ignores resolved and expired interactions", () => {
    const pending = selectPendingInteractions(runningTurn([{
      number: 1,
      actionType: "tool",
      assistantText: "",
      workspaceGrants: [{ ...pendingGrant, status: "expired" }],
      tools: [{
        id: "call-bash",
        name: "bash",
        status: "success",
        arguments: { command: "npm test" },
        approval: {
          ...pendingApproval,
          status: "responded",
          decision: "approve",
        },
        result: { exitCode: 0 },
      }],
    }]));

    expect(pending).toEqual([]);
  });

  it("returns nothing once the run is no longer running", () => {
    const steps: StepTrace[] = [{
      number: 1,
      actionType: "tool",
      assistantText: "",
      workspaceGrants: [pendingGrant],
      tools: [],
    }];

    expect(selectPendingInteractions(undefined)).toEqual([]);
    expect(selectPendingInteractions({
      id: "turn-1",
      userMessage: "跑一下测试",
      subAgentRuns: {},
      subAgentDescriptions: {},
      run: { ...initialRunState, status: "cancelled", steps },
    })).toEqual([]);
  });
});

describe("selectPendingInteractions with sub agents", () => {
  it("collects a child run's pending approval and labels its source", () => {
    const parentSteps: StepTrace[] = [{
      number: 2,
      actionType: "tool",
      assistantText: "",
      workspaceGrants: [],
      tools: [{
        id: "call-agent",
        name: "agent",
        status: "running",
        arguments: { description: "跑权限测试", task: "运行测试并汇报" },
      }],
    }];
    const childSteps: StepTrace[] = [{
      number: 1,
      actionType: "tool",
      assistantText: "",
      workspaceGrants: [],
      tools: [{
        id: "child-bash",
        name: "bash",
        status: "approval_required",
        arguments: { command: "npm test" },
        approval: pendingApproval,
      }],
    }];

    const pending = selectPendingInteractions({
      ...runningTurn(parentSteps),
      subAgentRuns: {
        "call-agent": { ...initialRunState, status: "running", steps: childSteps },
      },
    });

    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: "tool_approval",
      interactionId: "approval-1",
      step: 1,
      source: { toolCallId: "call-agent", description: "跑权限测试" },
    });
  });

  it("ignores children that are no longer running", () => {
    const childSteps: StepTrace[] = [{
      number: 1,
      actionType: "tool",
      assistantText: "",
      workspaceGrants: [],
      tools: [{
        id: "child-bash",
        name: "bash",
        status: "approval_required",
        arguments: {},
        approval: pendingApproval,
      }],
    }];

    expect(selectPendingInteractions({
      ...runningTurn([]),
      subAgentRuns: {
        "call-agent": { ...initialRunState, status: "error", steps: childSteps },
      },
    })).toEqual([]);
  });
});
