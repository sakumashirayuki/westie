import { describe, expect, it } from "vitest";

import { parseAgentEvent, parseRunSnapshotData } from "./events";

const usage = {
  model: "test-model",
  inputTokens: 12480,
  cachedInputTokens: 10240,
  outputTokens: 142,
  reasoningTokens: 0,
};

const totals = {
  calls: 2,
  unmeasuredCalls: 0,
  inputTokens: 200,
  cachedInputTokens: 80,
  outputTokens: 30,
  reasoningTokens: 5,
};

const required = {
  v: 1,
  runId: "run-1",
  seq: 1,
  step: 1,
  type: "interaction.required",
  data: {},
  interactionId: "interaction-1",
  kind: "tool_approval",
  expiresAt: "2026-07-27T10:00:00.000Z",
  payload: {
    toolCallId: "call-1",
    toolName: "bash",
    ruleId: "bash-confirm",
    argumentsDigest: "digest",
    argumentsSummary: { command: "pwd" },
    risk: "Runs a shell command.",
    impact: "Runs one command.",
    grantOptions: [{ kind: "tool" }],
  },
};

const workspaceGrantRequired = {
  v: 1,
  runId: "run-1",
  seq: 1,
  step: 1,
  type: "interaction.required",
  data: {},
  interactionId: "interaction-grant-1",
  kind: "workspace_grant",
  expiresAt: "2026-07-27T10:00:00.000Z",
  payload: {
    reason: "outside_workspace",
    toolCallId: "call-2",
    toolName: "request_file_access",
    requestedPath: "/Users/me/data/input.csv",
    access: "read",
    scope: "once",
  },
};

describe("parseAgentEvent interactions", () => {
  it("accepts step completion without model thought", () => {
    expect(parseAgentEvent({
      v: 1,
      runId: "run-1",
      seq: 1,
      step: 1,
      type: "step.completed",
      data: { actionType: "tool" },
    })).toMatchObject({
      type: "step.completed",
      data: { actionType: "tool" },
    });
  });

  it("validates step.completed usage", () => {
    expect(parseAgentEvent({
      v: 1,
      runId: "run-1",
      seq: 1,
      step: 1,
      type: "step.completed",
      data: { actionType: "final", usage },
    })).toMatchObject({
      type: "step.completed",
      data: { actionType: "final", usage },
    });
  });

  it("validates run.completed usage", () => {
    expect(parseAgentEvent({
      v: 1,
      runId: "run-1",
      seq: 1,
      type: "run.completed",
      data: { steps: 1, stopReason: "final", usage: totals },
    })).toMatchObject({
      type: "run.completed",
      data: { usage: totals },
    });
  });

  it("validates run.error usage", () => {
    expect(parseAgentEvent({
      v: 1,
      runId: "run-1",
      seq: 1,
      type: "run.error",
      data: { code: "FAILED", message: "Failed.", usage: totals },
    })).toMatchObject({
      type: "run.error",
      data: { usage: totals },
    });
  });

  it("rejects missing run.completed usage", () => {
    expect(() => parseAgentEvent({
      v: 1,
      runId: "run-1",
      seq: 1,
      type: "run.completed",
      data: { steps: 1, stopReason: "final" },
    })).toThrow("run.completed usage is invalid");
  });

  it("rejects malformed step.completed usage", () => {
    expect(() => parseAgentEvent({
      v: 1,
      runId: "run-1",
      seq: 1,
      step: 1,
      type: "step.completed",
      data: { actionType: "final", usage: { ...usage, inputTokens: -1 } },
    })).toThrow("step.completed usage is invalid");
  });

  it("accepts required and responded interaction events", () => {
    expect(parseAgentEvent(required)).toMatchObject({
      type: "interaction.required",
      interactionId: "interaction-1",
      kind: "tool_approval",
    });
    expect(parseAgentEvent({
      ...required,
      seq: 2,
      type: "interaction.resolved",
      status: "responded",
      response: { decision: "approve" },
      payload: undefined,
      expiresAt: undefined,
    })).toMatchObject({
      type: "interaction.resolved",
      status: "responded",
      response: { decision: "approve" },
    });
  });

  it("accepts a single-file, read-only workspace grant lifecycle", () => {
    expect(parseAgentEvent(workspaceGrantRequired)).toMatchObject({
      type: "interaction.required",
      interactionId: "interaction-grant-1",
      kind: "workspace_grant",
      payload: {
        requestedPath: "/Users/me/data/input.csv",
        access: "read",
        scope: "once",
      },
    });
    expect(parseAgentEvent({
      ...workspaceGrantRequired,
      seq: 2,
      type: "interaction.resolved",
      status: "responded",
      response: { decision: "approve" },
      payload: undefined,
      expiresAt: undefined,
    })).toMatchObject({
      type: "interaction.resolved",
      kind: "workspace_grant",
      status: "responded",
      response: { decision: "approve" },
    });
  });

  it.each([
    { ...workspaceGrantRequired, payload: { ...workspaceGrantRequired.payload, requestedPath: "" } },
    { ...workspaceGrantRequired, payload: { ...workspaceGrantRequired.payload, access: "write" } },
    { ...workspaceGrantRequired, payload: { ...workspaceGrantRequired.payload, scope: "conversation" } },
    { ...workspaceGrantRequired, payload: { ...workspaceGrantRequired.payload, toolCallId: 1 } },
    { ...workspaceGrantRequired, payload: { ...workspaceGrantRequired.payload, reason: "unknown" } },
  ])("rejects malformed workspace grant requests", (value) => {
    expect(() => parseAgentEvent(value)).toThrow();
  });

  it.each([
    { ...required, interactionId: "" },
    { ...required, kind: "unknown" },
    { ...required, payload: { ...required.payload, toolCallId: 1 } },
    {
      ...required,
      type: "interaction.resolved",
      status: "responded",
      response: undefined,
    },
    {
      ...required,
      type: "interaction.resolved",
      status: "expired",
      response: { decision: "deny" },
    },
  ])("rejects malformed interaction events", (value) => {
    expect(() => parseAgentEvent(value)).toThrow();
  });
});

describe("parseAgentEvent model.retrying", () => {
  const envelope = (data: unknown) => ({
    v: 1,
    runId: "run-1",
    seq: 3,
    type: "model.retrying",
    step: 1,
    data,
  });

  it("accepts a well-formed retry notice", () => {
    const data = { attempt: 2, maxAttempts: 5, delayMs: 1500, reason: "rate_limited" };
    expect(parseAgentEvent(envelope(data))).toMatchObject({ type: "model.retrying", data });
  });

  it.each([
    ["zero attempt", { attempt: 0, maxAttempts: 5, delayMs: 0, reason: "timeout" }],
    ["negative delay", { attempt: 2, maxAttempts: 5, delayMs: -1, reason: "timeout" }],
    ["unknown reason", { attempt: 2, maxAttempts: 5, delayMs: 0, reason: "quota" }],
    ["missing field", { attempt: 2, delayMs: 0, reason: "timeout" }],
  ])("rejects %s", (_name, data) => {
    expect(() => parseAgentEvent(envelope(data))).toThrow("model.retrying data is invalid.");
  });
});

describe("project memory status parsing", () => {
  it("accepts valid run.started memory states and rejects malformed ones", () => {
    expect(parseAgentEvent({
      v: 1,
      runId: "run-1",
      seq: 1,
      type: "run.started",
      data: { memory: { status: "truncated", nextLine: 201 } },
    })).toMatchObject({ data: { memory: { status: "truncated", nextLine: 201 } } });
    expect(parseAgentEvent({
      v: 1,
      runId: "run-1",
      seq: 1,
      type: "run.started",
      data: { memory: { status: "unavailable", reason: "read" } },
    })).toMatchObject({ data: { memory: { status: "unavailable", reason: "read" } } });
    expect(parseAgentEvent({
      v: 1,
      runId: "run-1",
      seq: 1,
      type: "run.started",
      data: {},
    })).toMatchObject({ data: {} });
    expect(() => parseAgentEvent({
      v: 1,
      runId: "run-1",
      seq: 1,
      type: "run.started",
      data: { memory: { status: "truncated" } },
    })).toThrow(/memory/);
    expect(() => parseAgentEvent({
      v: 1,
      runId: "run-1",
      seq: 1,
      type: "run.started",
      data: { memory: { status: "unavailable", reason: "/absolute/path" } },
    })).toThrow(/memory/);
  });
});

describe("parseRunSnapshotData memory", () => {
  it("keeps a valid memory state and rejects an unknown reason", () => {
    const base = {
      status: "running",
      waitingForSubAgents: false,
      children: [],
      pendingInteractions: [],
    };
    expect(parseRunSnapshotData({ ...base, memory: { status: "truncated", nextLine: 201 } }).memory)
      .toEqual({ status: "truncated", nextLine: 201 });
    expect(parseRunSnapshotData(base).memory).toBeUndefined();
    expect(() => parseRunSnapshotData({ ...base, memory: { status: "unavailable", reason: "/tmp" } }))
      .toThrow(/memory/);
  });
});
