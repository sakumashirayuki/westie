import type {
  AgentEvent,
  JsonValue,
  ModelRetryReason,
  RunUsageTotals,
  ToolGrantScope,
} from "./events";

export type RunStatus = "idle" | "running" | "stopping" | "completed" | "error" | "cancelled";
export type AnswerStatus = "idle" | "streaming" | "completed" | "interrupted";
export type AnswerKind = "pending" | "tool" | "final";

export interface ToolApprovalTrace {
  interactionId: string;
  status: "pending" | "responded" | "expired";
  expiresAt: string;
  ruleId: string;
  argumentsDigest: string;
  risk: string;
  impact: string;
  /** 可授予的作用域，最具体的在前；空数组表示只能允许一次。 */
  grantOptions: ToolGrantScope[];
  decision?: "approve" | "deny";
  /** 实际授予的作用域，仅在用户选择了会话级授权时出现。 */
  grant?: ToolGrantScope;
}

export interface ToolTrace {
  id: string;
  name: string;
  status: "approval_required" | "running" | "success" | "error";
  arguments: JsonValue;
  approval?: ToolApprovalTrace;
  result?: JsonValue;
  error?: { code: string; message: string };
  durationMs?: number;
  /** agent 工具卡片上的子 Run 概要；完整轨迹在 Turn 的 subAgentRuns 里。 */
  subAgent?: SubAgentSummary;
}

export interface SubAgentSummary {
  runId?: string;
  status: RunStatus;
  /** 子 Run 已开始的步数。 */
  steps: number;
  usage?: RunUsageTotals;
  stopReason?: string;
}

export interface WorkspaceGrantTrace {
  interactionId: string;
  toolCallId: string;
  toolName: string;
  status: "pending" | "responded" | "expired";
  expiresAt: string;
  requestedPath: string;
  reason: "outside_workspace" | "sensitive_workspace_file";
  access: "read";
  scope: "once";
  decision?: "approve" | "deny";
}

export interface SteeringTrace {
  seq: number;
  content: string;
  status: "queued" | "applied";
  /** 生效所在的步号。历史会话只恢复插话本身，不恢复步号。 */
  step?: number;
}

/** 模型调用正在等待重试；本步收到下一段输出或结束时清除。 */
export interface StepRetryTrace {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: ModelRetryReason;
}

export interface StepTrace {
  number: number;
  actionType?: "tool" | "final" | "waiting";
  assistantText: string;
  tools: ToolTrace[];
  workspaceGrants: WorkspaceGrantTrace[];
  retry?: StepRetryTrace;
}

export interface RunState {
  status: RunStatus;
  runId?: string;
  answer: string;
  answerStatus: AnswerStatus;
  answerKind: AnswerKind | null;
  steps: StepTrace[];
  /** 本 Run 的插话，按受理顺序；生效前后都在这里。 */
  steeringMessages: SteeringTrace[];
  usage?: RunUsageTotals;
  error?: { kind: "http" | "run" | "transport"; code?: string; message: string };
  stopReason?: string;
  waitingForSubAgents?: boolean;
  /** 项目记忆加载状态；旧事件与旧快照没有时为 undefined。 */
  memory?: import("./events").RunMemoryStatus;
}

export type RunAction =
  | { type: "start" }
  | { type: "event"; event: AgentEvent }
  | { type: "snapshot"; snapshot: import("./events").RunSnapshotData }
  | { type: "steer"; seq: number; content: string }
  | { type: "cancel" }
  | { type: "fail"; error: NonNullable<RunState["error"]> };

export const initialRunState: RunState = {
  status: "idle",
  answer: "",
  answerStatus: "idle",
  answerKind: null,
  steps: [],
  steeringMessages: [],
};

export function runReducer(state: RunState, action: RunAction): RunState {
  if (action.type === "start") {
    return {
      status: "running",
      answer: "",
      answerStatus: "idle",
      answerKind: null,
      steps: [],
      steeringMessages: [],
    };
  }
  if (action.type === "steer") {
    // steering.applied 可能先于受理响应到达，已生效的条目不退回排队态。
    if (state.steeringMessages.some((message) => message.seq === action.seq)) {
      return state;
    }
    return {
      ...state,
      steeringMessages: upsertSteering(state.steeringMessages, {
        seq: action.seq,
        content: action.content,
        status: "queued",
      }),
    };
  }
  if (action.type === "cancel") {
    return {
      ...state,
      steps: state.steps.map(withoutRetry),
      status: "cancelled",
      answerStatus: interruptStreamingAnswer(state.answerStatus),
      error: undefined,
    };
  }
  if (action.type === "fail") {
    return {
      ...state,
      steps: state.steps.map(withoutRetry),
      status: "error",
      answerStatus: interruptStreamingAnswer(state.answerStatus),
      error: action.error,
    };
  }
  if (action.type === "snapshot") return applySnapshot(state, action.snapshot);

  const event = action.event;
  switch (event.type) {
    case "run.started":
      return {
        ...state,
        runId: event.runId,
        ...(event.data.memory === undefined
          ? { memory: undefined }
          : { memory: event.data.memory }),
      };
    case "step.started":
      return { ...updateStep(state, event.step, (step) => step), waitingForSubAgents: false };
    case "step.completed": {
      const nextState = updateStep(state, event.step, (step) => ({
        ...withoutRetry(step),
        actionType: event.data.actionType,
      }));
      if (event.data.actionType === "final") {
        return { ...nextState, answerKind: "final" };
      }
      const stepText = nextState.steps.find(
        (step) => step.number === event.step,
      )?.assistantText ?? "";
      if (stepText === "") {
        return nextState;
      }
      return {
        ...nextState,
        answer: stepText,
        answerStatus: "completed",
        answerKind: "tool",
      };
    }
    case "interaction.required":
      if (event.kind === "workspace_grant") {
        return updateStep(state, event.step, (step) => ({
          ...step,
          workspaceGrants: upsertWorkspaceGrant(step.workspaceGrants, {
            interactionId: event.interactionId,
            toolCallId: event.payload.toolCallId,
            toolName: event.payload.toolName,
            status: "pending",
            expiresAt: event.expiresAt,
            requestedPath: event.payload.requestedPath,
            reason: event.payload.reason,
            access: event.payload.access,
            scope: event.payload.scope,
          }),
        }));
      }
      return updateStep(state, event.step, (step) => ({
        ...step,
        tools: upsertTool(step.tools, event.payload.toolCallId, {
          id: event.payload.toolCallId,
          name: event.payload.toolName,
          status: "approval_required",
          arguments: event.payload.argumentsSummary,
          approval: {
            interactionId: event.interactionId,
            status: "pending",
            expiresAt: event.expiresAt,
            ruleId: event.payload.ruleId,
            argumentsDigest: event.payload.argumentsDigest,
            risk: event.payload.risk,
            impact: event.payload.impact,
            grantOptions: event.payload.grantOptions,
          },
        }),
      }));
    case "interaction.resolved":
      return updateInteraction(state, event);
    case "steering.applied":
      return {
        ...state,
        steeringMessages: upsertSteering(state.steeringMessages, {
          seq: event.data.messageSeq,
          content: event.data.content,
          status: "applied",
          step: event.step,
        }),
      };
    case "tool.started":
      return updateStep(state, event.step, (step) => ({
        ...step,
        tools: upsertTool(
          step.tools,
          event.data.toolCallId,
          {
            id: event.data.toolCallId,
            name: event.data.name,
            status: "running",
            arguments: event.data.arguments,
          },
        ),
      }));
    case "tool.completed":
      return updateStep(state, event.step, (step) => ({
        ...step,
        tools: completeTool(step.tools, event.data),
      }));
    case "model.retrying": {
      // 本步此前流出的输出作废：清空本步文本；正在流式显示的回答来自本步时一并清空。
      const nextState = updateStep(state, event.step, (step) => ({
        ...step,
        assistantText: "",
        retry: { ...event.data },
      }));
      return state.answerKind === "pending"
        ? { ...nextState, answer: "", answerStatus: "idle", answerKind: null }
        : nextState;
    }
    case "answer.delta": {
      const startsNewOutput = state.answerKind === "tool" &&
        (state.steps.find((step) => step.number === event.step)?.assistantText ??
          "") === "";
      const nextState = updateStep(state, event.step, (step) => ({
        ...withoutRetry(step),
        assistantText: step.assistantText + event.data.text,
      }));
      return {
        ...nextState,
        answer: startsNewOutput
          ? event.data.text
          : nextState.answer + event.data.text,
        answerStatus: "streaming",
        answerKind: "pending",
      };
    }
    case "answer.completed": {
      const nextState = updateStep(state, event.step, (step) => ({
        ...step,
        assistantText: event.data.answer,
      }));
      return {
        ...nextState,
        answer: event.data.answer,
        answerStatus: "completed",
        answerKind: "final",
      };
    }
    case "subagent.stopping":
      return updateStep(state, event.step, (step) => ({
        ...step,
        tools: step.tools.map((tool) => tool.subAgent?.runId === event.data.runId
          ? { ...tool, subAgent: { ...tool.subAgent, status: "stopping", stopReason: event.data.reason } }
          : tool),
      }));
    case "run.waiting":
      return { ...state, waitingForSubAgents: true };
    case "run.completed":
      return {
        ...state,
        steps: state.steps.map(withoutRetry),
        status: "completed",
        answerStatus: interruptStreamingAnswer(state.answerStatus),
        usage: event.data.usage,
        stopReason: event.data.stopReason,
      };
    case "run.error":
      return {
        ...state,
        steps: state.steps.map(withoutRetry),
        status: "error",
        answerStatus: interruptStreamingAnswer(state.answerStatus),
        ...(event.data.usage === undefined ? {} : { usage: event.data.usage }),
        error: { kind: "run", code: event.data.code, message: event.data.message },
      };
    case "run.cancelled":
      return {
        ...state,
        steps: state.steps.map(withoutRetry),
        status: "cancelled",
        answerStatus: interruptStreamingAnswer(state.answerStatus),
        error: event.data.error === undefined ? undefined : { kind: "run", ...event.data.error },
        ...(event.data.usage === undefined ? {} : { usage: event.data.usage }),
      };
  }
}

function applySnapshot(state: RunState, snapshot: import("./events").RunSnapshotData): RunState {
  const terminal = snapshot.terminal;
  const next = { ...state, steps: [], steeringMessages: [], memory: snapshot.memory, waitingForSubAgents: snapshot.waitingForSubAgents, status: snapshot.status === "running" ? "running" as const :
    snapshot.status === "cancelled" ? "cancelled" as const : snapshot.status === "completed" ? "completed" as const : "error" as const,
    answer: snapshot.answer ?? "",
    answerStatus: snapshot.answer === undefined ? "idle" as const : "completed" as const,
    answerKind: snapshot.answer === undefined ? null : "final" as const,
    ...(terminal?.type === "run.completed" ? { usage: terminal.data.usage, stopReason: terminal.data.stopReason } : {}),
    ...(terminal?.type === "run.error" ? { error: { kind: "run" as const, code: terminal.data.code, message: terminal.data.message }, ...(terminal.data.usage === undefined ? {} : { usage: terminal.data.usage }) } : {}),
    ...(terminal?.type === "run.cancelled" ? { error: terminal.data.error === undefined ? undefined : { kind: "run" as const, ...terminal.data.error }, ...(terminal.data.usage === undefined ? {} : { usage: terminal.data.usage }) } : {}),
  };
  return next;
}

/** 由子 Run 的原始事件更新卡片概要；只看状态、步数和用量。 */
function summarizeSubAgent(
  current: SubAgentSummary | undefined,
  event: AgentEvent,
): SubAgentSummary {
  const base: SubAgentSummary = current ?? { status: "running", steps: 0 };
  switch (event.type) {
    case "run.started":
      return { ...base, runId: event.runId, status: "running" };
    case "step.started":
      return { ...base, steps: Math.max(base.steps, event.step) };
    case "run.completed":
      return { ...base, status: "completed", usage: event.data.usage };
    case "run.error":
      return {
        ...base,
        status: "error",
        ...(event.data.usage === undefined ? {} : { usage: event.data.usage }),
      };
    default:
      return base;
  }
}

function updateInteraction(
  state: RunState,
  event: Extract<AgentEvent, { type: "interaction.resolved" }>,
): RunState {
  if (event.kind === "workspace_grant") {
    return {
      ...state,
      steps: state.steps.map((step) => ({
        ...step,
        workspaceGrants: step.workspaceGrants.map((grant) => {
          if (grant.interactionId !== event.interactionId) return grant;
          return {
            ...grant,
            status: event.status,
            ...(event.status === "responded"
              ? { decision: event.response!.decision }
              : {}),
          };
        }),
      })),
    };
  }
  return {
    ...state,
    steps: state.steps.map((step) => ({
      ...step,
      tools: step.tools.map((tool) => {
        if (tool.approval?.interactionId !== event.interactionId) return tool;
        return {
          ...tool,
          approval: {
            ...tool.approval,
            status: event.status,
            ...(event.status === "responded"
              ? {
                  decision: event.response!.decision,
                  ...(event.response!.grant === undefined
                    ? {}
                    : { grant: event.response!.grant }),
                }
              : {}),
          },
        };
      }),
    })),
  };
}

function upsertWorkspaceGrant(
  grants: WorkspaceGrantTrace[],
  next: WorkspaceGrantTrace,
): WorkspaceGrantTrace[] {
  return grants.some((grant) => grant.interactionId === next.interactionId)
    ? grants.map((grant) =>
        grant.interactionId === next.interactionId ? next : grant,
      )
    : [...grants, next];
}

function upsertTool(
  tools: ToolTrace[],
  toolCallId: string,
  next: ToolTrace,
): ToolTrace[] {
  const existing = tools.find((tool) => tool.id === toolCallId);
  if (existing === undefined) return [...tools, next];
  return tools.map((tool) =>
    tool.id === toolCallId
      ? {
          ...tool,
          ...next,
          arguments:
            tool.approval !== undefined && next.approval === undefined
              ? tool.arguments
              : next.arguments,
          approval: next.approval ?? tool.approval,
        }
      : tool,
  );
}

function interruptStreamingAnswer(status: AnswerStatus): AnswerStatus {
  return status === "streaming" ? "interrupted" : status;
}

function completeTool(
  tools: ToolTrace[],
  data: Extract<AgentEvent, { type: "tool.completed" }>["data"],
): ToolTrace[] {
  const existing = tools.find((tool) => tool.id === data.toolCallId);
  const base: ToolTrace = existing ?? {
    id: data.toolCallId,
    name: data.name,
    status: "running",
    arguments: null,
  };
  const completed: ToolTrace =
    data.status === "success"
      ? { ...base, status: "success", result: data.result, durationMs: data.durationMs }
      : { ...base, status: "error", error: data.error, durationMs: data.durationMs };

  return existing
    ? tools.map((tool) => (tool.id === data.toolCallId ? completed : tool))
    : [...tools, completed];
}

function withoutRetry(step: StepTrace): StepTrace {
  if (step.retry === undefined) return step;
  const { retry: _retry, ...rest } = step;
  return rest;
}

function updateStep(
  state: RunState,
  number: number,
  update: (step: StepTrace) => StepTrace,
): RunState {
  const found = state.steps.some((step) => step.number === number);
  const steps = found
    ? state.steps.map((step) => (step.number === number ? update(step) : step))
    : [
        ...state.steps,
        update({
          number,
          assistantText: "",
          tools: [],
          workspaceGrants: [],
        }),
      ];
  return { ...state, steps };
}

/**
 * 按 seq 覆盖同一条插话。受理时先以排队态入列，steering.applied 到达后
 * 用带 step 的版本替换，因此同一条消息在列表里只出现一次。
 */
function upsertSteering(
  messages: readonly SteeringTrace[],
  message: SteeringTrace,
): SteeringTrace[] {
  return [
    ...messages.filter((existing) => existing.seq !== message.seq),
    message,
  ].sort((left, right) => left.seq - right.seq);
}
