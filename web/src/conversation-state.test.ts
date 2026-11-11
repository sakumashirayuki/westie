import { describe, expect, it } from "vitest";

import { UNKNOWN_WORKSPACE_STATUS } from "./run-client";

import {
  conversationReducer,
  hydrateConversation,
  initialConversationState,
  type ConversationAction,
} from "./conversation-state";
import { emptyRunUsageTotals, type AgentEvent } from "./events";
import type { ConversationDetail } from "./run-client";
import { selectPendingInteractions } from "./pending-interactions";

type ReducerEvent = AgentEvent;

function event(value: object): ReducerEvent {
  return { v: 1, runId: "run-1", seq: 1, ...value } as ReducerEvent;
}

describe("conversationReducer", () => {
  it("restores steering messages of a persisted run", () => {
    const timestamp = "2026-07-28T00:00:00.000Z";
    const conversation: ConversationDetail = {
      id: "conversation-1",
      revision: 2,
      executionMode: "workspace_sandbox",
      title: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      workspace: { name: "project", canonicalPath: "/workspace/project" },
      project: null,
      workspaceStatus: UNKNOWN_WORKSPACE_STATUS,
      archived: false,
      usage: emptyRunUsageTotals(),
      turns: [
        persistedTurn("completed", "run-1", timestamp, "Answer", undefined, [
          { seq: 4, content: "先跑测试" },
          { seq: 9, content: "改用简洁中文" },
        ]),
      ],
    };

    const state = hydrateConversation(conversation);

    // 服务端不保存生效步号，恢复出来的条目只标记为已生效。
    expect(state.turns[0]!.run.steeringMessages).toEqual([
      { seq: 4, content: "先跑测试", status: "applied" },
      { seq: 9, content: "改用简洁中文", status: "applied" },
    ]);
  });

  it("hydrates persisted answers without inventing historical traces", () => {
    const timestamp = "2026-07-28T00:00:00.000Z";
    const conversation: ConversationDetail = {
      id: "conversation-1",
      revision: 4,
      executionMode: "workspace_sandbox",
      title: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      workspace: { name: "project", canonicalPath: "/workspace/project" },
      project: null,
      workspaceStatus: UNKNOWN_WORKSPACE_STATUS,
      archived: false,
      usage: emptyRunUsageTotals(),
      turns: [
        persistedTurn("completed", "run-completed", timestamp, "Answer"),
        persistedTurn("failed", "run-failed", timestamp, undefined, {
          code: "MODEL_FAILED",
          message: "模型服务暂时不可用。",
        }),
        persistedTurn("failed", "run-failed-legacy", timestamp),
        persistedTurn("cancelled", "run-cancelled", timestamp),
        persistedTurn("running", "run-running", timestamp),
      ],
    };

    const state = hydrateConversation(conversation);

    expect(state.activeTurnId).toBe("turn-run-running");
    expect(state.turns.map((turn) => ({
      status: turn.run.status,
      answer: turn.run.answer,
      answerKind: turn.run.answerKind,
      steps: turn.run.steps,
      code: turn.run.error?.code,
      message: turn.run.error?.message,
    }))).toEqual([
      {
        status: "completed",
        answer: "Answer",
        answerKind: "final",
        steps: [],
        code: undefined,
        message: undefined,
      },
      {
        status: "error",
        answer: "",
        answerKind: null,
        steps: [],
        code: "MODEL_FAILED",
        message: "模型服务暂时不可用。",
      },
      {
        status: "error",
        answer: "",
        answerKind: null,
        steps: [],
        code: "RESTORED_RUN_FAILED",
        message: "上次运行失败。",
      },
      {
        status: "cancelled",
        answer: "",
        answerKind: null,
        steps: [],
        code: undefined,
        message: undefined,
      },
      {
        status: "running",
        answer: "",
        answerKind: null,
        steps: [],
        code: undefined,
        message: undefined,
      },
    ]);
  });

  it("resets the visible conversation after a workspace switch succeeds", () => {
    const state = conversationReducer(initialConversationState, {
      type: "start",
      turnId: "turn-1",
      userMessage: "First",
    });

    expect(conversationReducer(state, { type: "reset" })).toEqual(
      initialConversationState,
    );
  });

  it("keeps completed turns while routing new events to the active turn", () => {
    let state = conversationReducer(initialConversationState, {
      type: "start",
      turnId: "turn-1",
      userMessage: "First",
    });
    state = conversationReducer(state, {
      type: "event",
      turnId: "turn-1",
      event: event({
        type: "answer.completed",
        step: 1,
        data: { answer: "Answer one" },
      }),
    });
    state = conversationReducer(state, {
      type: "event",
      turnId: "turn-1",
      event: event({ type: "run.completed", data: { steps: 1 } }),
    });
    state = conversationReducer(state, {
      type: "start",
      turnId: "turn-2",
      userMessage: "Second",
    });
    state = conversationReducer(state, {
      type: "event",
      turnId: "turn-2",
      event: event({
        type: "answer.delta",
        step: 1,
        data: { text: "Answer two" },
      }),
    });

    expect(state.turns).toHaveLength(2);
    expect(state.turns[0]).toMatchObject({
      userMessage: "First",
      run: { status: "completed", answer: "Answer one" },
    });
    expect(state.turns[1]).toMatchObject({
      userMessage: "Second",
      run: { status: "running", answer: "Answer two" },
    });
    expect(state.activeTurnId).toBe("turn-2");
  });
});

function persistedTurn(
  status: "running" | "completed" | "failed" | "cancelled",
  runId: string,
  timestamp: string,
  assistantMessage?: string,
  error?: { code: string; message: string },
  steeringMessages: { seq: number; content: string }[] = [],
  subAgentRuns: ConversationDetail["turns"][number]["runs"][number]["subAgentRuns"] = [],
): ConversationDetail["turns"][number] {
  return {
    id: `turn-${runId}`,
    userMessage: `Question ${runId}`,
    ...(assistantMessage === undefined ? {} : { assistantMessage }),
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
    runs: [{
      id: runId,
      attempt: 1,
      status,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(error === undefined ? {} : { error }),
      usage: emptyUsage(),
      steeringMessages,
      subAgentRuns,
    }],
  };
}

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

describe("conversation usage", () => {
  it("starts from the server total and adds each finished run", () => {
    const timestamp = "2026-08-19T00:00:00.000Z";
    const conversation: ConversationDetail = {
      id: "conversation-1",
      revision: 2,
      executionMode: "workspace_sandbox",
      title: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      workspace: { name: "project", canonicalPath: "/workspace/project" },
      project: null,
      workspaceStatus: UNKNOWN_WORKSPACE_STATUS,
      archived: false,
      usage: {
        calls: 3,
        unmeasuredCalls: 1,
        inputTokens: 300,
        cachedInputTokens: 100,
        outputTokens: 40,
        reasoningTokens: 0,
      },
      turns: [],
    };

    const hydrated = hydrateConversation(conversation);
    expect(hydrated.usage.inputTokens).toBe(300);

    const started = conversationReducer(hydrated, {
      type: "start",
      turnId: "turn-1",
      userMessage: "hi",
    });
    expect(started.usage.inputTokens).toBe(300);

    const finished = conversationReducer(started, {
      type: "event",
      turnId: "turn-1",
      event: event({
        type: "run.completed",
        data: {
          steps: 1,
          stopReason: "final",
          usage: {
            calls: 2,
            unmeasuredCalls: 0,
            inputTokens: 500,
            cachedInputTokens: 250,
            outputTokens: 60,
            reasoningTokens: 10,
          },
        },
      }),
    });

    expect(finished.usage).toEqual({
      calls: 5,
      unmeasuredCalls: 1,
      inputTokens: 800,
      cachedInputTokens: 350,
      outputTokens: 100,
      reasoningTokens: 10,
    });
  });

  it("keeps the running total when a failed run reports no usage", () => {
    const started = conversationReducer(initialConversationState, {
      type: "start",
      turnId: "turn-1",
      userMessage: "hi",
    });
    const withUsage = conversationReducer(started, {
      type: "event",
      turnId: "turn-1",
      event: event({
        type: "run.completed",
        data: {
          steps: 1,
          stopReason: "final",
          usage: {
            calls: 1,
            unmeasuredCalls: 0,
            inputTokens: 100,
            cachedInputTokens: 0,
            outputTokens: 10,
            reasoningTokens: 0,
          },
        },
      }),
    });
    const afterUnknownFailure = conversationReducer(withUsage, {
      type: "event",
      turnId: "turn-1",
      event: event({
        type: "run.error",
        data: { code: "AGENT_RUN_FAILED", message: "Agent run failed." },
      }),
    });

    expect(afterUnknownFailure.usage.inputTokens).toBe(100);
    expect(afterUnknownFailure.usage.calls).toBe(1);
  });
});

describe("conversationReducer with sub agent events", () => {
  function childEvent(inner: object, toolCallId = "call-agent"): ConversationAction {
    return { type: "event", turnId: "turn-1", event: { v: 1, runId: "child-1", seq: 1, ...inner } as ReducerEvent, source: { toolCallId, parentStep: 2 } };
  }

  function startedTurn() {
    let state = conversationReducer(initialConversationState, {
      type: "start",
      turnId: "turn-1",
      userMessage: "委托",
    });
    state = conversationReducer(state, {
      type: "event",
      turnId: "turn-1",
      event: event({
        type: "tool.started",
        step: 2,
        data: {
          toolCallId: "call-agent",
          name: "agent",
          arguments: { description: "查错误码", task: "找出全部位置" },
        },
      }),
    });
    return state;
  }

  it("routes inner events into an independent RunState per toolCallId", () => {
    let state = startedTurn();
    for (const inner of [
      { type: "run.started", data: {} },
      { type: "step.started", step: 1, data: {} },
      {
        type: "tool.started",
        step: 1,
        data: { toolCallId: "child-read", name: "read", arguments: { path: "a" } },
      },
      {
        type: "tool.completed",
        step: 1,
        data: {
          toolCallId: "child-read",
          name: "read",
          status: "success",
          result: { content: "x" },
          durationMs: 3,
        },
      },
    ]) {
      state = conversationReducer(state, childEvent(inner));
    }

    const turn = state.turns[0]!;
    const child = turn.subAgentRuns["call-agent"]!;
    expect(child.status).toBe("running");
    expect(child.runId).toBe("child-1");
    expect(child.steps).toHaveLength(1);
    expect(child.steps[0]!.tools[0]).toMatchObject({
      id: "child-read",
      name: "read",
      status: "success",
    });
    // 父 Run 的 step 列表不吸收子 Run 的工具。
    expect(turn.run.steps[0]!.tools).toHaveLength(1);
    expect(turn.run.steps[0]!.tools[0]!.name).toBe("agent");
  });

  it("keeps child completion and usage in its independent state", () => {
    let state = startedTurn();
    const usage = { ...emptyRunUsageTotals(), calls: 3, inputTokens: 900, outputTokens: 100 };
    for (const inner of [
      { type: "run.started", data: {} },
      { type: "step.started", step: 1, data: {} },
      { type: "step.started", step: 2, data: {} },
      { type: "step.started", step: 3, data: {} },
      { type: "run.completed", data: { steps: 3, stopReason: "final", usage } },
    ]) {
      state = conversationReducer(state, childEvent(inner));
    }

    expect(state.turns[0]!.subAgentRuns["call-agent"]).toMatchObject({
      runId: "child-1", status: "completed", usage,
    });
    expect(state.turns[0]!.subAgentRuns["call-agent"]!.steps).toHaveLength(3);
    // 子 Run 的用量走父 Run 的 run.completed，不单独计入会话合计。
    expect(state.usage).toEqual(emptyRunUsageTotals());
  });

  it("keeps the parent and sibling running when one child is cancelled", () => {
    let state = startedTurn();
    state = conversationReducer(state, childEvent({ type: "run.started", data: {} }));
    state = conversationReducer(state, childEvent({ type: "run.started", runId: "child-2", data: {} }, "other"));
    state = conversationReducer(state, childEvent({ type: "run.cancelled", data: {} }));
    expect(state.turns[0]!.run.status).toBe("running");
    expect(state.turns[0]!.subAgentRuns["call-agent"]!.status).toBe("cancelled");
    expect(state.turns[0]!.subAgentRuns.other!.status).toBe("running");
  });

  it("cancels running children together with the parent", () => {
    let state = startedTurn();
    state = conversationReducer(state, childEvent({ type: "run.started", data: {} }) as never);

    state = conversationReducer(state, { type: "cancel", turnId: "turn-1" });

    expect(state.turns[0]!.run.status).toBe("cancelled");
    expect(state.turns[0]!.subAgentRuns["call-agent"]!.status).toBe("cancelled");
  });

  it("removes a stopped child from pending approvals", () => {
    let state = startedTurn();
    state = conversationReducer(state, childEvent({ type: "run.started", data: {}, runId: "child-1" }) as never);
    state = conversationReducer(state, childEvent({ type: "interaction.required", step: 1, interactionId: "approval-1", kind: "tool_approval", expiresAt: "2026-01-01T00:00:00Z", payload: { toolCallId: "tool-1", toolName: "bash", ruleId: "r", argumentsDigest: "d", argumentsSummary: {}, risk: "r", impact: "i", grantOptions: [] } }) as never);
    expect(selectPendingInteractions(state.turns[0])).toHaveLength(1);
    state = conversationReducer(state, {
      type: "event", turnId: "turn-1",
      event: { v: 1, runId: "parent", seq: 8, step: 1, type: "subagent.stopping", data: { runId: "child-1", toolCallId: "call-agent", reason: "user_request" } },
    });
    expect(selectPendingInteractions(state.turns[0])).toHaveLength(0);
  });

  it("rebuilds pending approvals from a run snapshot", () => {
    let state = startedTurn();
    state = conversationReducer(state, {
      type: "snapshot", turnId: "turn-1",
      snapshot: {
          status: "running",
          waitingForSubAgents: true,
          children: [],
          pendingInteractions: [{
            v: 1, runId: "run-1", seq: 4, step: 2,
            type: "interaction.required", data: {},
            interactionId: "approval-snapshot", kind: "tool_approval",
            expiresAt: "2026-01-01T00:00:00Z",
            payload: {
              toolCallId: "tool-snapshot", toolName: "bash", ruleId: "r",
              argumentsDigest: "d", argumentsSummary: {}, risk: "r", impact: "i", grantOptions: [],
            },
          }],
        },
    });
    expect(selectPendingInteractions(state.turns[0])).toMatchObject([
      { interactionId: "approval-snapshot", kind: "tool_approval" },
    ]);
  });

  it("keeps child snapshot approvals out of the parent run", () => {
    let state = startedTurn();
    const approval = (runId: string, id: string) => ({
      v: 1 as const, runId, seq: 4, step: 1,
      type: "interaction.required" as const, data: {} as Record<never, never>,
      interactionId: id, kind: "tool_approval" as const,
      expiresAt: "2026-01-01T00:00:00Z",
      payload: { toolCallId: id, toolName: "bash", ruleId: "r", argumentsDigest: "d", argumentsSummary: {}, risk: "r", impact: "i", grantOptions: [] },
    });
    state = conversationReducer(state, { type: "snapshot", turnId: "turn-1", snapshot: {
        status: "running", waitingForSubAgents: true,
        children: [{ runId: "child-1", toolCallId: "call-agent", description: "child", status: "running" }],
        pendingInteractions: [approval("run-1", "parent-approval"), approval("child-1", "child-approval")],
      } });
    const turn = state.turns[0]!;
    expect(turn.subAgentRuns["call-agent"]!.steps).toHaveLength(1);
    expect(selectPendingInteractions(turn)).toHaveLength(2);
    expect(turn.run.steps).toHaveLength(1);
  });

  it("hydrates persisted sub agent runs with their answer and usage but no steps", () => {
    const timestamp = "2026-09-18T00:00:00.000Z";
    const usage = { ...emptyRunUsageTotals(), calls: 2, inputTokens: 300 };
    const conversation: ConversationDetail = {
      id: "conversation-1",
      revision: 2,
      executionMode: "workspace_sandbox",
      title: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      workspace: { name: "project", canonicalPath: "/workspace/project" },
      project: null,
      workspaceStatus: UNKNOWN_WORKSPACE_STATUS,
      archived: false,
      usage: emptyRunUsageTotals(),
      turns: [
        persistedTurn("completed", "run-1", timestamp, "Answer", undefined, [], [
          {
            id: "child-ok",
            toolCallId: "call-a",
            description: "查错误码",
            status: "completed",
            finalAnswer: "共 3 处。",
            usage,
            messageCount: 4,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          {
            id: "child-bad",
            toolCallId: "call-b",
            description: "跑测试",
            status: "failed",
            error: { code: "AGENT_RUN_FAILED", message: "boom" },
            usage: emptyRunUsageTotals(),
            messageCount: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ]),
      ],
    };

    const state = hydrateConversation(conversation);

    const runs = state.turns[0]!.subAgentRuns;
    expect(runs["call-a"]).toMatchObject({
      status: "completed",
      runId: "child-ok",
      answer: "共 3 处。",
      answerStatus: "completed",
      answerKind: "final",
      usage,
      steps: [],
    });
    expect(runs["call-b"]).toMatchObject({
      status: "error",
      runId: "child-bad",
      error: { kind: "run", code: "AGENT_RUN_FAILED", message: "boom" },
    });
  });

  function usageCalls(calls: number) {
    return { ...emptyRunUsageTotals(), calls };
  }

  function partialUsageConversation(): ConversationDetail {
    const conversation = {
      id: "conversation-usage",
      revision: 1,
      executionMode: "workspace_sandbox" as const,
      title: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      workspace: { name: "project", canonicalPath: "/workspace/project" },
      project: null,
      workspaceStatus: UNKNOWN_WORKSPACE_STATUS,
      archived: false,
      usage: usageCalls(12),
      turns: [persistedTurn("completed", "run-usage", "2026-01-01T00:00:00.000Z")],
    };
    conversation.turns[0]!.runs[0]!.status = "running";
    conversation.turns[0]!.runs[0]!.usage = usageCalls(5);
    return conversation;
  }

  it("replaces a persisted running prefix before adding completed usage", () => {
    let state = hydrateConversation(partialUsageConversation());
    state = conversationReducer(state, { type: "event", turnId: "turn-run-usage", event: event({
      runId: "run-usage", type: "run.completed", data: { steps: 1, stopReason: "final", usage: usageCalls(9) },
    }) });
    expect(state.usage.calls).toBe(16);
  });

  it("counts terminal snapshot usage after removing the persisted prefix", () => {
    let state = hydrateConversation(partialUsageConversation());
    state = conversationReducer(state, { type: "snapshot", turnId: "turn-run-usage", snapshot: {
        status: "completed", waitingForSubAgents: false, children: [], pendingInteractions: [],
        terminal: event({ runId: "run-usage", type: "run.completed", data: { steps: 1, stopReason: "final", usage: usageCalls(9) } }) as never,
      } });
    expect(state.usage.calls).toBe(16);
  });

  it("counts cancelled usage after removing the persisted prefix", () => {
    let state = hydrateConversation(partialUsageConversation());
    state = conversationReducer(state, { type: "event", turnId: "turn-run-usage", event: event({
      runId: "run-usage", type: "run.cancelled", data: { usage: usageCalls(9) },
    }) });
    expect(state.usage.calls).toBe(16);
  });
});
