import { emptyRunUsageTotals, type AgentEvent, type RunEventSource } from "./events";
import type {
  ConversationDetail,
  ConversationRun,
  ConversationTurn,
  RunUsageTotals,
  SubAgentRun,
} from "./run-client";
import { describeSubAgent } from "./pending-interactions";
import {
  initialRunState,
  runReducer,
  type RunState,
  type SteeringTrace,
} from "./run-state";

export interface ConversationTurnState {
  id: string;
  userMessage: string;
  run: RunState;
  /** 本 Turn 内每个 agent 调用的子 Run 轨迹，按父 Run 的 toolCallId 索引。 */
  subAgentRuns: Record<string, RunState>;
  /**
   * 历史会话恢复的子 Run 标题，按 toolCallId 索引。运行中的子 Run 标题从父轨迹里
   * agent 调用的参数取，这里为空。
   */
  subAgentDescriptions: Record<string, string>;
}

export interface ConversationState {
  turns: ConversationTurnState[];
  /**
   * 该会话已结束 Run 的用量合计。hydrate 时取服务端聚合值（含失败重试），
   * 之后每个 Run 结束时把它自己的合计加进来；拿不到用量的 Run 不计入。
   */
  usage: RunUsageTotals;
  activeTurnId?: string;
}

/** 会话界面的状态更新动作，由会话加载、用户操作和服务端消息触发。 */
export type ConversationAction =
  /** 清空当前会话的界面状态。 */
  | { type: "reset" }
  /** 根据接口返回的会话详情，恢复各轮对话、父子 Run 和累计用量。 */
  | { type: "hydrate"; conversation: ConversationDetail }
  /** 在界面中新增一轮用户消息，并将该轮标记为运行中。 */
  | { type: "start"; turnId: string; userMessage: string }
  /** 应用一条实时或回放事件；source 指明子任务归属，省略时更新父任务。 */
  | {
      type: "event";
      turnId: string;
      event: AgentEvent;
      source?: RunEventSource["subAgent"];
    }
  /** 用服务端当前快照恢复该轮的父子任务、等待状态和待审批项，随后继续接收事件。 */
  | { type: "snapshot"; turnId: string; snapshot: import("./events").RunSnapshotData }
  /** 记录服务端已受理的用户追加消息；未生效时显示为排队中，已生效的消息保持原状态。 */
  | { type: "steer"; turnId: string; seq: number; content: string }
  /** 将该轮及状态为 running 的子任务显示为已取消。 */
  | { type: "cancel"; turnId: string }
  /** 记录请求、连接或运行错误，将该轮显示为失败。 */
  | {
      type: "fail";
      turnId: string;
      error: NonNullable<RunState["error"]>;
    };

export const initialConversationState: ConversationState = {
  turns: [],
  usage: emptyRunUsageTotals(),
};

function addUsage(
  total: RunUsageTotals,
  one: RunUsageTotals,
): RunUsageTotals {
  return {
    calls: total.calls + one.calls,
    unmeasuredCalls: total.unmeasuredCalls + one.unmeasuredCalls,
    inputTokens: total.inputTokens + one.inputTokens,
    cachedInputTokens: total.cachedInputTokens + one.cachedInputTokens,
    outputTokens: total.outputTokens + one.outputTokens,
    reasoningTokens: total.reasoningTokens + one.reasoningTokens,
  };
}

function subtractUsage(total: RunUsageTotals, one: RunUsageTotals): RunUsageTotals {
  return {
    calls: Math.max(0, total.calls - one.calls),
    unmeasuredCalls: Math.max(0, total.unmeasuredCalls - one.unmeasuredCalls),
    inputTokens: Math.max(0, total.inputTokens - one.inputTokens),
    cachedInputTokens: Math.max(0, total.cachedInputTokens - one.cachedInputTokens),
    outputTokens: Math.max(0, total.outputTokens - one.outputTokens),
    reasoningTokens: Math.max(0, total.reasoningTokens - one.reasoningTokens),
  };
}

function terminalRunUsage(
  event: AgentEvent,
): RunUsageTotals | undefined {
  if (event.type === "run.completed") return event.data.usage;
  if (event.type === "run.error") return event.data.usage;
  if (event.type === "run.cancelled") return event.data.usage;
  return undefined;
}

export function conversationReducer(
  state: ConversationState,
  action: ConversationAction,
): ConversationState {
  if (action.type === "reset") return initialConversationState;
  if (action.type === "hydrate") {
    return hydrateConversation(action.conversation);
  }

  if (action.type === "start") {
    return {
      usage: state.usage,
      turns: [
        ...state.turns,
        {
          id: action.turnId,
          userMessage: action.userMessage,
          run: runReducer(initialRunState, { type: "start" }),
          subAgentRuns: {},
          subAgentDescriptions: {},
        },
      ],
      activeTurnId: action.turnId,
    };
  }

  const turns = state.turns.map((turn) => {
    if (turn.id !== action.turnId) return turn;
    if (action.type === "snapshot") {
      return {
        ...turn,
        run: applySnapshotInteractions(runReducer(turn.run, { type: "snapshot", snapshot: action.snapshot }), action.snapshot.pendingInteractions.filter((item) => item.runId !== undefined && !action.snapshot.children.some((child) => child.runId === item.runId))),
        subAgentRuns: hydrateSnapshotSubAgents(action.snapshot.children, action.snapshot.pendingInteractions),
        subAgentDescriptions: Object.fromEntries(action.snapshot.children.map((child) => [child.toolCallId, child.description])),
      };
    }
    if (action.type === "event") {
      const nextSubAgents = action.source === undefined
        ? turn.subAgentRuns
        : applyDirectSubAgentEvent(turn.subAgentRuns, action.event, action.source.toolCallId);
      return {
        ...turn,
        run: action.source !== undefined ? turn.run : runReducer(turn.run, { type: "event", event: action.event }),
        subAgentRuns:
          action.source === undefined && action.event.type === "subagent.stopping"
            ? stopSubAgentState(nextSubAgents, action.event.data.toolCallId)
            : action.source === undefined && action.event.type === "run.cancelled"
            ? cancelRunningSubAgents(nextSubAgents)
            : nextSubAgents,
        subAgentDescriptions:
          turn.subAgentDescriptions,
      };
    }
    if (action.type === "steer") {
      return {
        ...turn,
        run: runReducer(turn.run, {
          type: "steer",
          seq: action.seq,
          content: action.content,
        }),
      };
    }
    if (action.type === "cancel") {
      return {
        ...turn,
        run: runReducer(turn.run, { type: "cancel" }),
        subAgentRuns: cancelRunningSubAgents(turn.subAgentRuns),
      };
    }
    return {
      ...turn,
      run: runReducer(turn.run, { type: "fail", error: action.error }),
    };
  });
  const activeTurn = turns.find((turn) => turn.id === state.activeTurnId);
  const finishedUsage =
    action.type === "event" && action.source === undefined ? terminalRunUsage(action.event)
      : action.type === "snapshot" && action.snapshot.terminal !== undefined
        ? terminalRunUsage(action.snapshot.terminal) : undefined;
  return {
    turns,
    usage:
      finishedUsage === undefined
        ? state.usage
        : addUsage(state.usage, finishedUsage),
    ...(activeTurn?.run.status === "running"
      ? { activeTurnId: state.activeTurnId }
      : {}),
  };
}

function applySnapshotInteractions(
  run: RunState,
  interactions: readonly Extract<AgentEvent, { type: "interaction.required" }>[],
): RunState {
  return interactions.reduce(
    (current, event) => runReducer(current, { type: "event", event }),
    run,
  );
}

function stopSubAgentState(
  runs: Record<string, RunState>,
  toolCallId: string,
): Record<string, RunState> {
  const child = runs[toolCallId];
  if (child === undefined || child.status !== "running") return runs;
  return { ...runs, [toolCallId]: { ...child, status: "stopping", steps: [], answer: "", answerStatus: "idle", answerKind: null } };
}

function hydrateSnapshotSubAgents(
  children: readonly import("./events").SubAgentSnapshot[],
  pending: readonly Extract<AgentEvent, { type: "interaction.required" }>[],
): Record<string, RunState> {
  return Object.fromEntries(children.map((child) => {
    const base: RunState = {
      ...initialRunState,
      runId: child.runId,
      status: child.status === "running" || child.status === "stopping"
        ? child.status
        : child.status === "completed" ? "completed" : child.status === "cancelled" ? "cancelled" : "error",
      answer: child.answer ?? "",
      answerStatus: child.answer === undefined ? "idle" : "completed",
      answerKind: child.answer === undefined ? null : "final",
      ...(child.usage === undefined ? {} : { usage: child.usage }),
      ...(child.stopReason === undefined ? {} : { stopReason: child.stopReason }),
      ...(child.error === undefined ? {} : { error: { kind: "run", ...child.error } }),
    };
    const childPending = pending.filter((event) => event.runId === child.runId);
    return [child.toolCallId, childPending.reduce((run, event) => runReducer(run, { type: "event", event }), base)];
  }));
}

function applyDirectSubAgentEvent(
  runs: Record<string, RunState>,
  event: AgentEvent,
  toolCallId: string,
): Record<string, RunState> {
  const current = runs[toolCallId] ?? runReducer(initialRunState, { type: "start" });
  return { ...runs, [toolCallId]: runReducer(current, { type: "event", event }) };
}

/** 父 Run 被停止时，仍在运行的子 Run 一起结束。 */
function cancelRunningSubAgents(
  runs: Record<string, RunState>,
): Record<string, RunState> {
  return Object.fromEntries(
    Object.entries(runs).map(([toolCallId, run]) => [
      toolCallId,
      run.status === "running" ? runReducer(run, { type: "cancel" }) : run,
    ]),
  );
}

/**
 * 历史会话里的子 Run 只恢复状态、回答和用量，步骤列表为空，与父 Run 历史记录
 * 的恢复口径一致。
 */
function hydrateSubAgentRuns(
  runs: readonly SubAgentRun[],
): Record<string, RunState> {
  return Object.fromEntries(runs.map((run) => {
    const answer = run.finalAnswer ?? "";
    const base = {
      ...initialRunState,
      runId: run.id,
      answer,
      usage: run.usage,
      ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
    };
    if (run.status === "running" || run.status === "stopping") {
      return [run.toolCallId, {
        ...base,
        status: run.status,
      }];
    }
    if (run.status === "completed") {
      return [run.toolCallId, {
        ...base,
        status: "completed" as const,
        answerStatus: answer === "" ? "idle" as const : "completed" as const,
        answerKind: answer === "" ? null : "final" as const,
      }];
    }
    if (run.status === "cancelled") {
      return [run.toolCallId, { ...base, status: "cancelled" as const }];
    }
    return [run.toolCallId, {
      ...base,
      status: "error" as const,
      error: {
        kind: "run" as const,
        code: run.error?.code ?? "RESTORED_RUN_FAILED",
        message: run.error?.message ?? "子 Run 运行失败。",
      },
    }];
  }));
}

function describeSubAgentRuns(
  runs: readonly SubAgentRun[],
): Record<string, string> {
  return Object.fromEntries(runs.map((run) => [run.toolCallId, run.description]));
}

/** 子 Run 的标题：运行中取父轨迹里 agent 调用的参数，历史会话取恢复的记录。 */
export function subAgentDescription(
  turn: ConversationTurnState,
  toolCallId: string,
): string {
  return turn.subAgentDescriptions[toolCallId] ??
    describeSubAgent(turn.run.steps, toolCallId);
}

export function hydrateConversation(
  conversation: ConversationDetail,
): ConversationState {
  const turns = conversation.turns.map(hydrateTurn);
  const lastTurn = turns.at(-1);
  const persistedRunningUsage = conversation.turns
    .flatMap((turn) => turn.runs)
    .filter((run) => run.status === "running")
    .reduce((usage, run) => subtractUsage(usage, run.usage), conversation.usage);
  return {
    turns,
    usage: persistedRunningUsage,
    // 运行中的 Run 由 resume() 接管，它的 turn 就是当前活动 turn（待审批、插话都依赖它）。
    ...(lastTurn?.run.status === "running" ? { activeTurnId: lastTurn.id } : {}),
  };
}

/**
 * 历史会话的插话来自 canonical transcript 里 seq > 0 的 user 消息，因此它们
 * 一定已经生效；服务端不保存生效步号，恢复出来的条目只标记为已生效。
 */
function hydrateSteering(run: ConversationRun): SteeringTrace[] {
  return run.steeringMessages.map((message) => ({
    seq: message.seq,
    content: message.content,
    status: "applied",
  }));
}

function hydrateTurn(turn: ConversationTurn): ConversationTurnState {
  const run = turn.runs.at(-1);
  const answer = turn.assistantMessage ?? "";
  const answerStatus = answer === "" ? "idle" : "completed";
  if (run === undefined) {
    return {
      id: turn.id,
      userMessage: turn.userMessage,
      run: { ...initialRunState },
      subAgentRuns: {},
      subAgentDescriptions: {},
    };
  }
  if (run.status === "completed") {
    return {
      id: turn.id,
      userMessage: turn.userMessage,
      subAgentRuns: hydrateSubAgentRuns(run.subAgentRuns),
      subAgentDescriptions: describeSubAgentRuns(run.subAgentRuns),
      run: {
        status: "completed",
        runId: run.id,
        answer,
        answerStatus,
        answerKind: answer === "" ? null : "final",
        steps: [],
        steeringMessages: hydrateSteering(run),
        usage: run.usage,
      },
    };
  }
  if (run.status === "cancelled") {
    return {
      id: turn.id,
      userMessage: turn.userMessage,
      subAgentRuns: cancelRunningSubAgents(hydrateSubAgentRuns(run.subAgentRuns)),
      subAgentDescriptions: describeSubAgentRuns(run.subAgentRuns),
      run: {
        status: "cancelled",
        runId: run.id,
        answer,
        answerStatus: answer === "" ? "idle" : "interrupted",
        answerKind: answer === "" ? null : "pending",
        steps: [],
        steeringMessages: hydrateSteering(run),
        usage: run.usage,
      },
    };
  }
  if (run.status === "running") {
    // 运行中的 Run 水合为 running，由 resume() 回放事件流接管；已落库的内容
    // （running 的 Run 在数据库里还没有 transcript，基本只有用户消息）先渲染。
    return {
      id: turn.id,
      userMessage: turn.userMessage,
      subAgentRuns: hydrateSubAgentRuns(run.subAgentRuns),
      subAgentDescriptions: describeSubAgentRuns(run.subAgentRuns),
      run: {
        status: "running",
        runId: run.id,
        answer,
        answerStatus: answer === "" ? "idle" : "streaming",
        answerKind: answer === "" ? null : "pending",
        steps: [],
        steeringMessages: hydrateSteering(run),
        usage: run.usage,
      },
    };
  }
  return {
    id: turn.id,
    userMessage: turn.userMessage,
    subAgentRuns: hydrateSubAgentRuns(run.subAgentRuns),
    subAgentDescriptions: describeSubAgentRuns(run.subAgentRuns),
    run: {
      status: "error",
      runId: run.id,
      answer,
      answerStatus: answer === "" ? "idle" : "interrupted",
      answerKind: answer === "" ? null : "pending",
      steps: [],
      steeringMessages: hydrateSteering(run),
      usage: run.usage,
      error: {
        kind: "run",
        code: run.error?.code ?? "RESTORED_RUN_FAILED",
        message: run.error?.message ?? "上次运行失败。",
      },
    },
  };
}
