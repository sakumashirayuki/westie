export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ProviderUsage {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface RunUsageTotals {
  calls: number;
  unmeasuredCalls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export function emptyRunUsageTotals(): RunUsageTotals {
  return {
    calls: 0,
    unmeasuredCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

interface RunEventBase {
  v: 1;
  runId: string;
  seq: number;
}

interface StepEventBase extends RunEventBase {
  step: number;
}

export type ToolGrantScope =
  | { kind: "tool" }
  | { kind: "command_prefix"; value: string };

/** 父 Run 启动时的项目记忆状态；旧事件与旧快照没有这个字段。 */
export type RunMemoryStatus =
  | { status: "ready" }
  | { status: "truncated"; nextLine: number }
  | { status: "unavailable"; reason: "identity" | "read" | "encoding" };

export interface RunStartedData {
  memory?: RunMemoryStatus;
}

export type AgentEvent =
  | (RunEventBase & { type: "run.started"; data: RunStartedData })
  | (StepEventBase & { type: "step.started"; data: Record<string, never> })
  | (StepEventBase & {
      type: "model.retrying";
      /** attempt 是即将开始的第几次尝试；本步此前流出的输出全部作废。 */
      data: {
        attempt: number;
        maxAttempts: number;
        delayMs: number;
        reason: ModelRetryReason;
      };
    })
  | (StepEventBase & {
      type: "answer.delta";
      data: { text: string };
    })
  | (StepEventBase & {
      type: "step.completed";
      data: { actionType: "tool" | "final" | "waiting"; usage?: ProviderUsage };
    })
  | (StepEventBase & {
      type: "interaction.required";
      data: Record<string, never>;
      interactionId: string;
      kind: "tool_approval";
      expiresAt: string;
      payload: {
        toolCallId: string;
        toolName: string;
        ruleId: string;
        argumentsDigest: string;
        argumentsSummary: JsonValue;
        risk: string;
        impact: string;
        grantOptions: ToolGrantScope[];
      };
    })
  | (StepEventBase & {
      type: "interaction.required";
      data: Record<string, never>;
      interactionId: string;
      kind: "workspace_grant";
      expiresAt: string;
      payload: {
        reason: "outside_workspace" | "sensitive_workspace_file";
        toolCallId: string;
        toolName: string;
        requestedPath: string;
        access: "read";
        scope: "once";
      };
    })
  | (StepEventBase & {
      type: "interaction.resolved";
      data: Record<string, never>;
      interactionId: string;
      kind: "tool_approval";
      status: "responded" | "expired";
      response?: { decision: "approve" | "deny"; grant?: ToolGrantScope };
    })
  | (StepEventBase & {
      type: "interaction.resolved";
      data: Record<string, never>;
      interactionId: string;
      kind: "workspace_grant";
      status: "responded" | "expired";
      response?: { decision: "approve" | "deny" };
    })
  | (StepEventBase & {
      type: "tool.started";
      data: { toolCallId: string; name: string; arguments: JsonValue };
    })
  | (StepEventBase & {
      type: "tool.completed";
      data:
        | {
            toolCallId: string;
            name: string;
            status: "success";
            result: JsonValue;
            durationMs: number;
          }
        | {
            toolCallId: string;
            name: string;
            status: "error";
            error: { code: string; message: string };
            durationMs: number;
          };
    })
  | (StepEventBase & {
      type: "steering.applied";
      data: { messageSeq: number; content: string };
    })
  | (StepEventBase & {
      type: "subagent.stopping";
      data: { runId: string; toolCallId: string; reason: string };
    })
  | (StepEventBase & {
      type: "run.waiting";
      data: { reason: "sub_agents" };
    })
  | (StepEventBase & {
      type: "answer.completed";
      data: { answer: string };
    })
  | (RunEventBase & {
      type: "run.completed";
      data: { steps: number; stopReason: string; usage: RunUsageTotals };
    })
  | (RunEventBase & {
      type: "run.error";
      step?: number;
      data: { code: string; message: string; usage?: RunUsageTotals };
    })
  | (RunEventBase & {
      type: "run.cancelled";
      data: { usage?: RunUsageTotals; error?: { code: string; message: string } };
    });

/** 事件在父 Run SSE 中的传输关联。事件本身仍保留所属 Run 的 runId/seq。 */
export interface RunEventSource {
  event: AgentEvent;
  subAgent?: { toolCallId: string; parentStep: number };
}

export type RunStreamRecord =
  & { streamSeq: number }
  & (RunEventSource | { snapshot: RunSnapshotData });

export interface SubAgentSnapshot {
  runId: string;
  toolCallId: string;
  description: string;
  status: "running" | "stopping" | "completed" | "failed" | "cancelled";
  stopReason?: string;
  answer?: string;
  error?: { code: string; message: string };
  usage?: RunUsageTotals;
}

export interface RunSnapshotData {
  status: "running" | "completed" | "failed" | "cancelled";
  memory?: RunMemoryStatus;
  waitingForSubAgents: boolean;
  children: SubAgentSnapshot[];
  pendingInteractions: Extract<AgentEvent, { type: "interaction.required" }>[];
  terminal?: Extract<AgentEvent, { type: "run.completed" | "run.error" | "run.cancelled" }>;
  answer?: string;
}

export function parseRunSnapshotData(value: unknown): RunSnapshotData {
  const parsed = parseRunSnapshotShape(value);
  return {
    ...parsed,
    ...(parsed.memory === undefined
      ? {}
      : { memory: parseRunMemoryStatus(parsed.memory) }),
  } as RunSnapshotData;
}

function parseRunSnapshotShape(value: unknown): Record<string, unknown> {
  if (!isRecord(value) ||
    (value.status !== "running" && value.status !== "completed" && value.status !== "failed" && value.status !== "cancelled") ||
    typeof value.waitingForSubAgents !== "boolean" ||
    !Array.isArray(value.children) || !Array.isArray(value.pendingInteractions)) {
    throw new Error("Stream snapshot is invalid.");
  }
  for (const child of value.children) {
    if (!isRecord(child) || typeof child.runId !== "string" || typeof child.toolCallId !== "string" ||
      typeof child.description !== "string" ||
      !["running", "stopping", "completed", "failed", "cancelled"].includes(child.status as string)) {
      throw new Error("Stream snapshot child is invalid.");
    }
  }
  for (const item of value.pendingInteractions) {
    if (parseAgentEvent(item).type !== "interaction.required") {
      throw new Error("Stream snapshot interaction is invalid.");
    }
  }
  if (value.memory !== undefined && parseRunMemoryStatus(value.memory) === undefined) {
    throw new Error("Stream snapshot memory is invalid.");
  }
  if (value.terminal !== undefined) {
    const terminal = parseAgentEvent(value.terminal);
    if (terminal.type !== "run.completed" && terminal.type !== "run.error" && terminal.type !== "run.cancelled") {
      throw new Error("Stream snapshot terminal is invalid.");
    }
  }
  return value;
}

export type ModelRetryReason =
  | "rate_limited"
  | "server_error"
  | "overloaded"
  | "timeout"
  | "connection";

const modelRetryReasons = new Set<string>([
  "rate_limited",
  "server_error",
  "overloaded",
  "timeout",
  "connection",
]);

const eventTypes = new Set<AgentEvent["type"]>([
  "run.started",
  "step.started",
  "model.retrying",
  "answer.delta",
  "step.completed",
  "interaction.required",
  "interaction.resolved",
  "tool.started",
  "tool.completed",
  "steering.applied",
  "subagent.stopping",
  "run.waiting",
  "answer.completed",
  "run.completed",
  "run.error",
  "run.cancelled",
]);

/** 校验 `run.started.data.memory`；缺字段或非法返回 undefined。 */
export function parseRunMemoryStatus(value: unknown): RunMemoryStatus | undefined {
  if (!isRecord(value)) return undefined;
  if (value.status === "ready") return { status: "ready" };
  if (value.status === "truncated") {
    return isPositiveInteger(value.nextLine)
      ? { status: "truncated", nextLine: value.nextLine }
      : undefined;
  }
  if (
    value.status === "unavailable" &&
    (value.reason === "identity" || value.reason === "read" ||
      value.reason === "encoding")
  ) {
    return { status: "unavailable", reason: value.reason };
  }
  return undefined;
}

export function parseAgentEvent(value: unknown): AgentEvent {
  if (!isRecord(value)) throw new Error("Event data must be an object.");
  if (
    value.v !== 1 ||
    typeof value.runId !== "string" ||
    !Number.isInteger(value.seq) ||
    typeof value.type !== "string" ||
    !eventTypes.has(value.type as AgentEvent["type"]) ||
    !isRecord(value.data)
  ) {
    throw new Error("Event envelope is invalid.");
  }
  if (value.type === "answer.delta" && typeof value.data.text !== "string") {
    throw new Error("answer.delta text must be a string.");
  }
  if (
    value.type === "model.retrying" &&
    (
      !isPositiveInteger(value.data.attempt) ||
      !isPositiveInteger(value.data.maxAttempts) ||
      typeof value.data.delayMs !== "number" ||
      !Number.isFinite(value.data.delayMs) ||
      value.data.delayMs < 0 ||
      typeof value.data.reason !== "string" ||
      !modelRetryReasons.has(value.data.reason)
    )
  ) {
    throw new Error("model.retrying data is invalid.");
  }
  if (
    value.type === "step.completed" &&
    value.data.actionType !== "tool" &&
    value.data.actionType !== "final" &&
    value.data.actionType !== "waiting"
  ) {
    throw new Error("step.completed actionType is invalid.");
  }
  if (
    value.type === "step.completed" &&
    value.data.usage !== undefined &&
    !isProviderUsage(value.data.usage)
  ) {
    throw new Error("step.completed usage is invalid.");
  }
  if (
    value.type === "run.completed" &&
    !isRunUsageTotals(value.data.usage)
  ) {
    throw new Error("run.completed usage is invalid.");
  }
  if (
    value.type === "run.error" &&
    value.data.usage !== undefined &&
    !isRunUsageTotals(value.data.usage)
  ) {
    throw new Error("run.error usage is invalid.");
  }
  if (
    value.type === "run.started" &&
    value.data.memory !== undefined &&
    parseRunMemoryStatus(value.data.memory) === undefined
  ) {
    throw new Error("run.started memory is invalid.");
  }
  if (value.type === "answer.completed" && typeof value.data.answer !== "string") {
    throw new Error("answer.completed answer must be a string.");
  }
  if (value.type === "subagent.stopping" &&
      (typeof value.data.runId !== "string" || typeof value.data.toolCallId !== "string" || typeof value.data.reason !== "string")) {
    throw new Error("subagent.stopping data is invalid.");
  }
  if (value.type === "run.waiting" && value.data.reason !== "sub_agents") {
    throw new Error("run.waiting data is invalid.");
  }
  if (
    value.type === "steering.applied" &&
    (!Number.isInteger(value.data.messageSeq) ||
      (value.data.messageSeq as number) < 0 ||
      typeof value.data.content !== "string" ||
      value.data.content === "")
  ) {
    throw new Error("steering.applied data is invalid.");
  }
  if (value.type === "interaction.required") {
    assertInteractionEnvelope(value);
    if (typeof value.expiresAt !== "string" || !isRecord(value.payload)) {
      throw new Error("interaction.required payload is invalid.");
    }
    if (value.kind === "tool_approval") {
      if (
        typeof value.payload.toolCallId !== "string" ||
        typeof value.payload.toolName !== "string" ||
        typeof value.payload.ruleId !== "string" ||
        typeof value.payload.argumentsDigest !== "string" ||
        !isJsonValue(value.payload.argumentsSummary) ||
        typeof value.payload.risk !== "string" ||
        typeof value.payload.impact !== "string" ||
        !isToolGrantScopeList(value.payload.grantOptions)
      ) {
        throw new Error("interaction.required payload is invalid.");
      }
    } else if (
      typeof value.payload.toolCallId !== "string" ||
      typeof value.payload.toolName !== "string" ||
      (value.payload.reason !== "outside_workspace" &&
        value.payload.reason !== "sensitive_workspace_file") ||
      typeof value.payload.requestedPath !== "string" ||
      value.payload.requestedPath === "" ||
      value.payload.access !== "read" ||
      value.payload.scope !== "once"
    ) {
      throw new Error("interaction.required payload is invalid.");
    }
  }
  if (value.type === "interaction.resolved") {
    assertInteractionEnvelope(value);
    if (value.status === "responded") {
      if (
        !isRecord(value.response) ||
        (value.response.decision !== "approve" &&
          value.response.decision !== "deny") ||
        (value.response.grant !== undefined &&
          !isToolGrantScope(value.response.grant))
      ) {
        throw new Error("Responded interaction must include a decision.");
      }
    } else if (value.status === "expired") {
      if (value.response !== undefined) {
        throw new Error("Expired interaction must not include a response.");
      }
    } else {
      throw new Error("interaction.resolved status is invalid.");
    }
  }
  return value as unknown as AgentEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isProviderUsage(value: unknown): value is ProviderUsage {
  return (
    isRecord(value) &&
    typeof value.model === "string" &&
    value.model.length > 0 &&
    isNonNegativeInteger(value.inputTokens) &&
    isNonNegativeInteger(value.cachedInputTokens) &&
    isNonNegativeInteger(value.outputTokens) &&
    isNonNegativeInteger(value.reasoningTokens)
  );
}

function isRunUsageTotals(value: unknown): value is RunUsageTotals {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.calls) &&
    isNonNegativeInteger(value.unmeasuredCalls) &&
    isNonNegativeInteger(value.inputTokens) &&
    isNonNegativeInteger(value.cachedInputTokens) &&
    isNonNegativeInteger(value.outputTokens) &&
    isNonNegativeInteger(value.reasoningTokens)
  );
}

function assertInteractionEnvelope(value: Record<string, unknown>): void {
  if (
    typeof value.interactionId !== "string" ||
    value.interactionId === "" ||
    (value.kind !== "tool_approval" && value.kind !== "workspace_grant")
  ) {
    throw new Error("Interaction envelope is invalid.");
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isToolGrantScopeList(value: unknown): value is ToolGrantScope[] {
  return Array.isArray(value) && value.every(isToolGrantScope);
}

function isToolGrantScope(value: unknown): value is ToolGrantScope {
  if (!isRecord(value)) return false;
  if (value.kind === "tool") return true;
  return value.kind === "command_prefix" &&
    typeof value.value === "string" &&
    value.value !== "";
}
