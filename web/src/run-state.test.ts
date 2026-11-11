import { describe, expect, it } from "vitest";

import type { AgentEvent } from "./events";
import { initialRunState, runReducer } from "./run-state";

type ReducerEvent = AgentEvent;

function event(value: object): ReducerEvent {
  return { v: 1, runId: "run-1", seq: 1, ...value } as ReducerEvent;
}

describe("runReducer", () => {
  it("builds step and tool traces, streams the answer, then calibrates it", () => {
    let state = runReducer(initialRunState, { type: "start" });
    state = runReducer(state, { type: "event", event: event({ type: "step.started", step: 1, data: {} }) });
    state = runReducer(state, { type: "event", event: event({
      type: "tool.started",
      step: 1,
      data: { toolCallId: "tool-1", name: "clock", arguments: { zone: "Asia/Shanghai" } },
    }) });
    state = runReducer(state, { type: "event", event: event({
      type: "tool.completed",
      step: 1,
      data: { toolCallId: "tool-1", name: "clock", status: "success", result: "12:00", durationMs: 8 },
    }) });
    state = runReducer(state, { type: "event", event: event({
      type: "answer.delta",
      step: 1,
      data: { text: "It is " },
    }) });
    state = runReducer(state, { type: "event", event: event({
      type: "answer.delta",
      step: 1,
      data: { text: "almost noon." },
    }) });

    expect(state.answer).toBe("It is almost noon.");
    expect(state.answerStatus).toBe("streaming");

    state = runReducer(state, { type: "event", event: event({
      type: "answer.completed",
      step: 1,
      data: { answer: "It is noon." },
    }) });

    expect(state.answer).toBe("It is noon.");
    expect(state.answerStatus).toBe("completed");
    expect(state.steps[0]?.tools[0]).toMatchObject({ status: "success", result: "12:00", durationMs: 8 });
  });

  it("keeps parallel tools in first-appearance order when they finish in reverse", () => {
    let state = runReducer(initialRunState, { type: "start" });
    for (const value of [
      { type: "step.started", step: 1, data: {} },
      { type: "step.completed", step: 1, data: { actionType: "tool" } },
      { type: "tool.started", step: 1, data: { toolCallId: "read-1", name: "read", arguments: { path: "README.md" } } },
      { type: "tool.started", step: 1, data: { toolCallId: "grep-1", name: "grep", arguments: { pattern: "TODO" } } },
      { type: "tool.completed", step: 1, data: { toolCallId: "grep-1", name: "grep", status: "success", result: { matches: [] }, durationMs: 4 } },
      { type: "tool.completed", step: 1, data: { toolCallId: "read-1", name: "read", status: "success", result: { content: "text" }, durationMs: 8 } },
    ] as const) {
      state = runReducer(state, { type: "event", event: event(value) });
    }

    expect(state.steps[0]?.tools).toMatchObject([
      { id: "read-1", name: "read", status: "success", result: { content: "text" } },
      { id: "grep-1", name: "grep", status: "success", result: { matches: [] } },
    ]);
  });

  it("records a completed step without model thought", () => {
    const state = runReducer(initialRunState, { type: "event", event: event({
      type: "step.completed",
      step: 1,
      data: { actionType: "final" },
    }) });

    expect(state.steps[0]).toEqual({
      number: 1,
      actionType: "final",
      assistantText: "",
      tools: [],
      workspaceGrants: [],
    });
    expect(state.answerKind).toBe("final");
  });

  it("marks tool-step text before replacing it with the next step output", () => {
    let state = runReducer(initialRunState, { type: "start" });
    state = runReducer(state, { type: "event", event: event({
      type: "step.started",
      step: 1,
      data: {},
    }) });
    state = runReducer(state, { type: "event", event: event({
      type: "answer.delta",
      step: 1,
      data: { text: "I will inspect the file." },
    }) });

    expect(state).toMatchObject({
      answer: "I will inspect the file.",
      answerStatus: "streaming",
      answerKind: "pending",
      steps: [{ assistantText: "I will inspect the file." }],
    });

    state = runReducer(state, { type: "event", event: event({
      type: "step.completed",
      step: 1,
      data: { actionType: "tool" },
    }) });

    expect(state).toMatchObject({
      answer: "I will inspect the file.",
      answerStatus: "completed",
      answerKind: "tool",
      steps: [{
        actionType: "tool",
        assistantText: "I will inspect the file.",
      }],
    });

    state = runReducer(state, { type: "event", event: event({
      type: "step.started",
      step: 2,
      data: {},
    }) });

    expect(state).toMatchObject({
      answer: "I will inspect the file.",
      answerStatus: "completed",
      answerKind: "tool",
      steps: [{ assistantText: "I will inspect the file." }, { number: 2 }],
    });

    state = runReducer(state, { type: "event", event: event({
      type: "answer.delta",
      step: 2,
      data: { text: "根据文件内容，" },
    }) });
    state = runReducer(state, { type: "event", event: event({
      type: "answer.delta",
      step: 2,
      data: { text: "问题已经定位。" },
    }) });

    expect(state).toMatchObject({
      answer: "根据文件内容，问题已经定位。",
      answerStatus: "streaming",
      answerKind: "pending",
      steps: [
        { assistantText: "I will inspect the file." },
        { assistantText: "根据文件内容，问题已经定位。" },
      ],
    });
  });

  it("keeps the latest tool explanation when the next tool step has no text", () => {
    let state = runReducer(initialRunState, { type: "start" });
    state = runReducer(state, { type: "event", event: event({
      type: "answer.delta",
      step: 1,
      data: { text: "I will inspect the file." },
    }) });
    state = runReducer(state, { type: "event", event: event({
      type: "step.completed",
      step: 1,
      data: { actionType: "tool" },
    }) });
    state = runReducer(state, { type: "event", event: event({
      type: "step.started",
      step: 2,
      data: {},
    }) });
    state = runReducer(state, { type: "event", event: event({
      type: "step.completed",
      step: 2,
      data: { actionType: "tool" },
    }) });

    expect(state).toMatchObject({
      answer: "I will inspect the file.",
      answerStatus: "completed",
      answerKind: "tool",
      steps: [
        { assistantText: "I will inspect the file." },
        { assistantText: "", actionType: "tool" },
      ],
    });
  });

  it.each([
    { action: { type: "cancel" } as const, status: "cancelled" },
    {
      action: {
        type: "fail",
        error: { kind: "transport" as const, message: "Disconnected." },
      } as const,
      status: "error",
    },
  ])("keeps an interrupted answer preview after $status", ({ action, status }) => {
    let state = runReducer(initialRunState, { type: "start" });
    state = runReducer(state, { type: "event", event: event({
      type: "answer.delta",
      step: 1,
      data: { text: "Partial answer" },
    }) });
    state = runReducer(state, action);

    expect(state).toMatchObject({
      status,
      answer: "Partial answer",
      answerStatus: "interrupted",
    });
  });

  it("clears the previous answer when a new run starts", () => {
    const previous = {
      ...initialRunState,
      status: "completed" as const,
      answer: "Previous answer",
      answerStatus: "completed" as const,
      answerKind: "final" as const,
    };

    expect(runReducer(previous, { type: "start" })).toMatchObject({
      status: "running",
      answer: "",
      answerStatus: "idle",
    });
  });

  it("keeps a preview when run.error interrupts answer streaming", () => {
    let state = runReducer(initialRunState, { type: "start" });
    state = runReducer(state, { type: "event", event: event({
      type: "answer.delta",
      step: 1,
      data: { text: "Partial answer" },
    }) });
    state = runReducer(state, { type: "event", event: event({
      type: "run.error",
      data: { code: "FAILED", message: "Failed.", usage: emptyUsage() },
    }) });

    expect(state).toMatchObject({
      status: "error",
      answer: "Partial answer",
      answerStatus: "interrupted",
    });
  });

  it("keeps run failures distinct", () => {
    const state = runReducer(initialRunState, { type: "event", event: event({
      type: "run.error",
      data: {
        code: "FAILED",
        message: "Failed.",
        usage: emptyUsage(),
      },
    }) });
    expect(state).toMatchObject({
      status: "error",
      error: { kind: "run", code: "FAILED", message: "Failed." },
    });
  });

  it("stores usage from a terminal run.completed event", () => {
    const state = runReducer(initialRunState, { type: "event", event: event({
      type: "run.completed",
      data: {
        steps: 1,
        stopReason: "final",
        usage: {
          calls: 2,
          unmeasuredCalls: 0,
          inputTokens: 200,
          cachedInputTokens: 80,
          outputTokens: 30,
          reasoningTokens: 5,
        },
      },
    }) });
    expect(state).toMatchObject({
      status: "completed",
      usage: {
        calls: 2,
        inputTokens: 200,
      },
    });
  });

  it("stores usage from a terminal run.error event", () => {
    const state = runReducer(initialRunState, { type: "event", event: event({
      type: "run.error",
      data: {
        code: "FAILED",
        message: "Failed.",
        usage: emptyUsage(),
      },
    }) });
    expect(state).toMatchObject({
      status: "error",
      usage: { calls: 0 },
    });
  });

  it("shows tool validation failures that have no tool.started event", () => {
    const state = runReducer(initialRunState, { type: "event", event: event({
      type: "tool.completed",
      step: 1,
      data: {
        toolCallId: "tool-1",
        name: "unknown_tool",
        status: "error",
        error: { code: "UNKNOWN_TOOL", message: "Unknown tool." },
        durationMs: 0,
      },
    }) });

    expect(state.steps[0]?.tools[0]).toEqual({
      id: "tool-1",
      name: "unknown_tool",
      status: "error",
      arguments: null,
      error: { code: "UNKNOWN_TOOL", message: "Unknown tool." },
      durationMs: 0,
    });
  });

  it("keeps one tool trace from approval through execution", () => {
    let state = runReducer(initialRunState, { type: "start" });
    state = runReducer(state, { type: "event", event: event({
      type: "interaction.required",
      step: 1,
      data: {},
      interactionId: "interaction-1",
      kind: "tool_approval",
      expiresAt: "2026-07-27T10:00:00.000Z",
      payload: {
        toolCallId: "tool-1",
        toolName: "bash",
        ruleId: "bash-confirm",
        argumentsDigest: "digest",
        argumentsSummary: { command: "pwd" },
        risk: "Runs a shell command.",
        impact: "Runs one command.",
      },
    }) });

    expect(state.steps[0]?.tools).toHaveLength(1);
    expect(state.steps[0]?.tools[0]).toMatchObject({
      id: "tool-1",
      status: "approval_required",
      arguments: { command: "pwd" },
      approval: { interactionId: "interaction-1", status: "pending" },
    });

    state = runReducer(state, { type: "event", event: event({
      type: "interaction.resolved",
      step: 1,
      data: {},
      interactionId: "interaction-1",
      kind: "tool_approval",
      status: "responded",
      response: { decision: "approve" },
    }) });
    state = runReducer(state, { type: "event", event: event({
      type: "tool.started",
      step: 1,
      data: { toolCallId: "tool-1", name: "bash", arguments: { command: "pwd" } },
    }) });

    expect(state.steps[0]?.tools).toHaveLength(1);
    expect(state.steps[0]?.tools[0]).toMatchObject({
      status: "running",
      approval: { status: "responded", decision: "approve" },
    });
  });

  it("keeps a workspace grant pending until its resolved event arrives", () => {
    let state = runReducer(initialRunState, { type: "start" });
    state = runReducer(state, { type: "event", event: event({
      type: "interaction.required",
      step: 1,
      data: {},
      interactionId: "interaction-grant-1",
      kind: "workspace_grant",
      expiresAt: "2026-07-27T10:00:00.000Z",
      payload: {
        reason: "outside_workspace",
        toolCallId: "tool-1",
        toolName: "request_file_access",
        requestedPath: "/Users/me/data/input.csv",
        access: "read",
        scope: "once",
      },
    }) });

    expect(state.steps[0]?.workspaceGrants).toEqual([{
      interactionId: "interaction-grant-1",
      toolCallId: "tool-1",
      toolName: "request_file_access",
      status: "pending",
      expiresAt: "2026-07-27T10:00:00.000Z",
      requestedPath: "/Users/me/data/input.csv",
      reason: "outside_workspace",
      access: "read",
      scope: "once",
    }]);

    state = runReducer(state, { type: "event", event: event({
      type: "interaction.resolved",
      step: 1,
      data: {},
      interactionId: "interaction-grant-1",
      kind: "workspace_grant",
      status: "responded",
      response: { decision: "approve" },
    }) });

    expect(state.steps[0]?.workspaceGrants[0]).toMatchObject({
      status: "responded",
      decision: "approve",
    });
  });

  it.each([
    {
      resolution: {
        status: "responded",
        response: { decision: "deny" },
      },
      code: "TOOL_APPROVAL_DENIED",
    },
    {
      resolution: { status: "expired" },
      code: "TOOL_APPROVAL_EXPIRED",
    },
  ])("completes $code without a tool.started event", ({ resolution, code }) => {
    let state = runReducer(initialRunState, { type: "start" });
    state = runReducer(state, { type: "event", event: event({
      type: "interaction.required",
      step: 1,
      data: {},
      interactionId: "interaction-1",
      kind: "tool_approval",
      expiresAt: "2026-07-27T10:00:00.000Z",
      payload: {
        toolCallId: "tool-1",
        toolName: "bash",
        ruleId: "bash-confirm",
        argumentsDigest: "digest",
        argumentsSummary: { command: "pwd" },
        risk: "Runs a shell command.",
        impact: "Runs one command.",
      },
    }) });
    state = runReducer(state, { type: "event", event: event({
      type: "interaction.resolved",
      step: 1,
      data: {},
      interactionId: "interaction-1",
      kind: "tool_approval",
      ...resolution,
    }) });
    state = runReducer(state, { type: "event", event: event({
      type: "tool.completed",
      step: 1,
      data: {
        toolCallId: "tool-1",
        name: "bash",
        status: "error",
        error: { code, message: "Not executed." },
        durationMs: 0,
      },
    }) });

    expect(state.steps[0]?.tools).toHaveLength(1);
    expect(state.steps[0]?.tools[0]).toMatchObject({
      status: "error",
      error: { code },
    });
  });

  it("records steering messages with the step they were applied to", () => {
    let state = runReducer(initialRunState, { type: "start" });
    state = runReducer(state, { type: "event", event: event({
      type: "step.started",
      step: 1,
      data: {},
    }) });
    for (const [messageSeq, content] of [[1, "先跑测试"], [0, "改用简洁中文"]] as const) {
      state = runReducer(state, { type: "event", event: event({
        type: "steering.applied",
        step: 1,
        data: { messageSeq, content },
      }) });
    }

    // 按 seq 升序呈现，与注入顺序一致，不受事件到达顺序影响。
    expect(state.steeringMessages).toEqual([
      { seq: 0, content: "改用简洁中文", status: "applied", step: 1 },
      { seq: 1, content: "先跑测试", status: "applied", step: 1 },
    ]);
  });

  it("shows an accepted steering message as queued before it takes effect", () => {
    let state = runReducer(initialRunState, { type: "start" });
    state = runReducer(state, { type: "steer", seq: 0, content: "先跑测试" });

    expect(state.steeringMessages).toEqual([{ seq: 0, content: "先跑测试", status: "queued" }]);

    state = runReducer(state, { type: "event", event: event({
      type: "steering.applied",
      step: 3,
      data: { messageSeq: 0, content: "先跑测试" },
    }) });

    // 同一条消息只出现一次，排队态被生效态替换。
    expect(state.steeringMessages).toEqual([
      { seq: 0, content: "先跑测试", status: "applied", step: 3 },
    ]);
  });

  it("keeps a steering message applied when its acceptance resolves late", () => {
    let state = runReducer(initialRunState, { type: "start" });
    state = runReducer(state, { type: "event", event: event({
      type: "steering.applied",
      step: 2,
      data: { messageSeq: 0, content: "先跑测试" },
    }) });
    state = runReducer(state, { type: "steer", seq: 0, content: "先跑测试" });

    expect(state.steeringMessages).toEqual([
      { seq: 0, content: "先跑测试", status: "applied", step: 2 },
    ]);
  });

});

function emptyUsage() {
  return {
    calls: 0,
    unmeasuredCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

describe("runReducer model.retrying", () => {
  const retrying = event({
    type: "model.retrying",
    step: 2,
    data: { attempt: 2, maxAttempts: 5, delayMs: 3000, reason: "overloaded" },
  });

  function streamingStepTwo() {
    let state = runReducer(initialRunState, { type: "start" });
    state = runReducer(state, { type: "event", event: event({ type: "step.started", step: 2, data: {} }) });
    return runReducer(state, { type: "event", event: event({
      type: "answer.delta",
      step: 2,
      data: { text: "stale partial" },
    }) });
  }

  it("discards the step's partial output and records the retry", () => {
    const state = runReducer(streamingStepTwo(), { type: "event", event: retrying });

    expect(state.steps[0]?.assistantText).toBe("");
    expect(state.steps[0]?.retry).toEqual({
      attempt: 2,
      maxAttempts: 5,
      delayMs: 3000,
      reason: "overloaded",
    });
    expect(state.answer).toBe("");
    expect(state.answerStatus).toBe("idle");
  });

  it("keeps a previous step's tool explanation when the retry happens before any output", () => {
    let state = runReducer(initialRunState, { type: "start" });
    state = runReducer(state, { type: "event", event: event({ type: "answer.delta", step: 1, data: { text: "Let me read." } }) });
    state = runReducer(state, { type: "event", event: event({ type: "step.completed", step: 1, data: { actionType: "tool" } }) });
    state = runReducer(state, { type: "event", event: retrying });

    expect(state.answer).toBe("Let me read.");
    expect(state.answerKind).toBe("tool");
  });

  it("clears the retry marker on the next delta, step end, or run end", () => {
    const retried = runReducer(streamingStepTwo(), { type: "event", event: retrying });

    const afterDelta = runReducer(retried, { type: "event", event: event({ type: "answer.delta", step: 2, data: { text: "fresh" } }) });
    expect(afterDelta.steps[0]?.retry).toBeUndefined();
    expect(afterDelta.steps[0]?.assistantText).toBe("fresh");
    expect(afterDelta.answer).toBe("fresh");

    const afterError = runReducer(retried, { type: "event", event: event({
      type: "run.error",
      data: { code: "MODEL_UNAVAILABLE", message: "unavailable" },
    }) });
    expect(afterError.steps[0]?.retry).toBeUndefined();

    const afterCancel = runReducer(retried, { type: "cancel" });
    expect(afterCancel.steps[0]?.retry).toBeUndefined();
  });
});

describe("runReducer project memory state", () => {
  it("records the memory state from run.started", () => {
    let state = runReducer(initialRunState, { type: "start" });
    state = runReducer(state, { type: "event", event: event({
      type: "run.started",
      data: { memory: { status: "truncated", nextLine: 201 } },
    }) });
    expect(state.memory).toEqual({ status: "truncated", nextLine: 201 });
  });

  it("restores the memory state from a snapshot and drops it when absent", () => {
    const restored = runReducer(initialRunState, {
      type: "snapshot",
      snapshot: {
        status: "running",
        memory: { status: "unavailable", reason: "identity" },
        waitingForSubAgents: false,
        children: [],
        pendingInteractions: [],
      },
    });
    expect(restored.memory).toEqual({ status: "unavailable", reason: "identity" });

    const legacy = runReducer(restored, {
      type: "snapshot",
      snapshot: {
        status: "running",
        waitingForSubAgents: false,
        children: [],
        pendingInteractions: [],
      },
    });
    expect(legacy.memory).toBeUndefined();
  });
});
