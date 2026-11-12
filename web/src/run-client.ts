import {
  parseAgentEvent,
  type AgentEvent,
  type RunEventSource,
  type RunSnapshotData,
  type RunStreamRecord,
  parseRunSnapshotData,
  type ToolGrantScope,
} from "./events";
import { parseSseStream } from "./sse";

export interface RunRequest {
  input: string;
  maxSteps?: number;
}

export type ExecutionMode = "workspace_sandbox" | "full_access";

/** 工作目录类型；未知表示服务端暂时无法判定。 */
export type WorkspaceKind =
  | "main"
  | "worktree"
  | "subdirectory"
  | "directory"
  | "unknown";

export type WorkspaceBranch =
  | { status: "branch"; name: string }
  | { status: "detached"; commit: string | null }
  | { status: "unknown" };

export type WorkspaceAvailability =
  | { status: "available" }
  | { status: "missing" }
  | { status: "unreadable"; reason: string };

export interface ConversationProject {
  key: string;
  root: string;
  name: string;
}

export interface WorkspaceStatus {
  kind: WorkspaceKind;
  branch: WorkspaceBranch;
  availability: WorkspaceAvailability;
}

/**
 * 测试与兼容默认值：未识别项目、工作目录状态未知。界面在服务端未返回
 * 状态字段时按这个默认值展示，不猜测任何 Git 信息。
 */
export const UNKNOWN_WORKSPACE_STATUS: WorkspaceStatus = {
  kind: "unknown",
  branch: { status: "unknown" },
  availability: { status: "available" },
};

export interface ConversationSummary {
  id: string;
  revision: number;
  executionMode: ExecutionMode;
  /** 用户设置的标题；null 表示未命名，界面显示 `workspace.name`。 */
  title: string | null;
  createdAt: string;
  updatedAt: string;
  workspace: {
    name: string;
  };
  /** 已识别的项目归属；null 表示服务端尚未识别，界面按「未识别」分组。 */
  project: ConversationProject | null;
  /** 是否已归档；归档会话只读，不出现在侧栏主列表。 */
  archived: boolean;
  /** 持久化的工作目录类型；列表接口下发，未识别时为 null。 */
  workspaceKind?: WorkspaceKind | null;
  /** 该会话是否已绑定飞书单聊；服务端未返回时默认为 false。 */
  larkBound?: boolean;
}

export type ConversationRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ConversationRun {
  id: string;
  attempt: number;
  status: ConversationRunStatus;
  createdAt: string;
  updatedAt: string;
  error?: {
    code: string;
    message: string;
  };
  usage: RunUsageTotals;
  /** 该 Run 运行期间追加的插话，按 transcript 顺序。 */
  steeringMessages: RunSteeringMessage[];
  /** 该 Run 委托出去、已经结束的子 Run。 */
  subAgentRuns: SubAgentRun[];
}

export type SubAgentRunStatus = "running" | "stopping" | "completed" | "failed" | "cancelled";

export interface SubAgentRun {
  id: string;
  toolCallId: string;
  description: string;
  status: SubAgentRunStatus;
  stopReason?: string;
  finalAnswer?: string;
  error?: { code: string; message: string };
  usage: RunUsageTotals;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RunSteeringMessage {
  seq: number;
  content: string;
}

export interface RunUsageTotals {
  calls: number;
  unmeasuredCalls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface ConversationTurn {
  id: string;
  userMessage: string;
  assistantMessage?: string;
  status: ConversationRunStatus;
  createdAt: string;
  updatedAt: string;
  runs: ConversationRun[];
}

export interface ConversationDetail extends ConversationSummary {
  workspace: {
    name: string;
    canonicalPath: string;
  };
  workspaceStatus: WorkspaceStatus;
  /** 该会话全部 Run（含失败重试）的用量合计。 */
  usage: RunUsageTotals;
  turns: ConversationTurn[];
}

export type Conversation = ConversationDetail;

export interface ConversationPage {
  items: ConversationSummary[];
  nextCursor: string | null;
}

export type ToolApprovalDecision = "approve" | "deny";

export class HttpRunError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "HttpRunError";
    this.status = status;
    this.code = code;
  }
}

export class AgentRunError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentRunError";
    this.code = code;
  }
}

export class RunProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunProtocolError";
  }
}

export async function listConversations(options?: {
  cursor?: string;
  archived?: boolean;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}): Promise<ConversationPage> {
  const fetcher = options?.fetch ?? fetch;
  const params = new URLSearchParams();
  if (options?.cursor !== undefined) {
    params.set("cursor", options.cursor);
  }
  if (options?.archived !== undefined) {
    params.set("archived", options.archived ? "true" : "false");
  }
  const query = params.size === 0 ? "" : `?${params.toString()}`;
  const response = await fetcher(`/v1/agent/conversations${query}`, {
    method: "GET",
    signal: options?.signal,
  });
  if (!response.ok) throw await createHttpError(response);
  return parseConversationPage(await response.json());
}

export async function getConversation(
  conversationId: string,
  options?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<ConversationDetail> {
  const fetcher = options?.fetch ?? fetch;
  const response = await fetcher(
    `/v1/agent/conversations/${encodeURIComponent(conversationId)}`,
    { method: "GET", signal: options?.signal },
  );
  if (!response.ok) throw await createHttpError(response);
  return parseConversationDetail(await response.json());
}

/** 设置会话标题；传 null 恢复为工作区名。运行中的会话由服务端拒绝（409）。 */
export async function renameConversation(
  conversationId: string,
  title: string | null,
  options?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<ConversationSummary> {
  const fetcher = options?.fetch ?? fetch;
  const response = await fetcher(
    `/v1/agent/conversations/${encodeURIComponent(conversationId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
      signal: options?.signal,
    },
  );
  if (!response.ok) throw await createHttpError(response);
  return parseConversationSummary(await response.json());
}

export async function deleteConversation(
  conversationId: string,
  options?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<void> {
  const fetcher = options?.fetch ?? fetch;
  const response = await fetcher(
    `/v1/agent/conversations/${encodeURIComponent(conversationId)}`,
    { method: "DELETE", signal: options?.signal },
  );
  if (!response.ok) throw await createHttpError(response);
}

/** 归档一个没有活动 Run 的会话；成功返回 204。 */
export async function archiveConversation(
  conversationId: string,
  options?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<void> {
  const fetcher = options?.fetch ?? fetch;
  const response = await fetcher(
    `/v1/agent/conversations/${encodeURIComponent(conversationId)}:archive`,
    { method: "POST", signal: options?.signal },
  );
  if (!response.ok) throw await createHttpError(response);
}

function parseConversationSummary(value: unknown): ConversationSummary {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.revision !== "number" ||
    !Number.isInteger(value.revision) ||
    !isExecutionMode(value.executionMode) ||
    !(value.title === null || typeof value.title === "string") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !isRecord(value.workspace) ||
    typeof value.workspace.name !== "string" ||
    value.workspace.name.length === 0 ||
    !(value.project === null || isConversationProject(value.project)) ||
    typeof value.archived !== "boolean" ||
    !(
      value.workspaceKind === null ||
      value.workspaceKind === undefined ||
      isStoredWorkspaceKind(value.workspaceKind)
    ) ||
    (value.larkBound !== undefined && typeof value.larkBound !== "boolean")
  ) {
    throw new RunProtocolError("服务端返回了无效的会话数据。");
  }
  return {
    id: value.id,
    revision: value.revision,
    executionMode: value.executionMode,
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    workspace: {
      name: value.workspace.name,
    },
    project: value.project === null
      ? null
      : { key: value.project.key, root: value.project.root, name: value.project.name },
    archived: value.archived,
    workspaceKind: value.workspaceKind,
    ...(value.larkBound === undefined ? {} : { larkBound: value.larkBound }),
  };
}

function isStoredWorkspaceKind(value: unknown): value is WorkspaceKind {
  return (
    value === "main" ||
    value === "worktree" ||
    value === "subdirectory" ||
    value === "directory"
  );
}

function isConversationProject(value: unknown): value is ConversationProject {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    value.key.length > 0 &&
    typeof value.root === "string" &&
    value.root.length > 0 &&
    typeof value.name === "string" &&
    value.name.length > 0
  );
}

function isWorkspaceStatus(value: unknown): value is WorkspaceStatus {
  if (!isRecord(value) || !isRecord(value.branch) || !isRecord(value.availability)) {
    return false;
  }
  return (
    (value.kind === "main" ||
      value.kind === "worktree" ||
      value.kind === "subdirectory" ||
      value.kind === "directory" ||
      value.kind === "unknown") &&
    (value.branch.status === "branch" ||
      value.branch.status === "detached" ||
      value.branch.status === "unknown") &&
    (value.availability.status === "available" ||
      value.availability.status === "missing" ||
      value.availability.status === "unreadable")
  );
}

function parseWorkspaceStatus(value: WorkspaceStatus): WorkspaceStatus {
  const branch = value.branch;
  let parsedBranch: WorkspaceBranch;
  if (branch.status === "branch") {
    parsedBranch = { status: "branch", name: String(branch.name) };
  } else if (branch.status === "detached") {
    parsedBranch = {
      status: "detached",
      commit: typeof branch.commit === "string" ? branch.commit : null,
    };
  } else {
    parsedBranch = { status: "unknown" };
  }
  const availability = value.availability;
  return {
    kind: value.kind,
    branch: parsedBranch,
    availability: availability.status === "unreadable"
      ? { status: "unreadable", reason: availability.reason }
      : { status: availability.status },
  };
}

function isExecutionMode(value: unknown): value is ExecutionMode {
  return value === "workspace_sandbox" || value === "full_access";
}

function parseConversationDetail(value: unknown): ConversationDetail {
  const summary = parseConversationSummary(value);
  if (
    !isRecord(value) ||
    !isRecord(value.workspace) ||
    typeof value.workspace.canonicalPath !== "string" ||
    value.workspace.canonicalPath.length === 0 ||
    !isWorkspaceStatus(value.workspaceStatus) ||
    !Array.isArray(value.turns) ||
    !isRunUsageTotals(value.usage)
  ) {
    throw new RunProtocolError("服务端返回了无效的会话数据。");
  }
  return {
    ...summary,
    workspace: {
      name: summary.workspace.name,
      canonicalPath: value.workspace.canonicalPath,
    },
    workspaceStatus: parseWorkspaceStatus(value.workspaceStatus),
    usage: { ...value.usage },
    turns: value.turns.map(parseConversationTurn),
  };
}

function parseConversationPage(value: unknown): ConversationPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    !(
      value.nextCursor === null ||
      typeof value.nextCursor === "string"
    )
  ) {
    throw new RunProtocolError("服务端返回了无效的会话列表。");
  }
  return {
    items: value.items.map(parseConversationSummary),
    nextCursor: value.nextCursor,
  };
}

function parseConversationTurn(value: unknown): ConversationTurn {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.userMessage !== "string" ||
    !isConversationRunStatus(value.status) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !Array.isArray(value.runs) ||
    !(
      value.assistantMessage === undefined ||
      typeof value.assistantMessage === "string"
    )
  ) {
    throw new RunProtocolError("服务端返回了无效的会话数据。");
  }
  return {
    id: value.id,
    userMessage: value.userMessage,
    ...(value.assistantMessage === undefined
      ? {}
      : { assistantMessage: value.assistantMessage }),
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    runs: value.runs.map(parseConversationRun),
  };
}

function parseConversationRun(value: unknown): ConversationRun {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.attempt !== "number" ||
    !Number.isInteger(value.attempt) ||
    value.attempt <= 0 ||
    !isConversationRunStatus(value.status) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !(value.error === undefined || isConversationRunError(value.error)) ||
    !isRunUsageTotals(value.usage) ||
    !Array.isArray(value.steeringMessages) ||
    !value.steeringMessages.every(isRunSteeringMessage) ||
    !Array.isArray(value.subAgentRuns)
  ) {
    throw new RunProtocolError("服务端返回了无效的会话数据。");
  }
  return {
    id: value.id,
    attempt: value.attempt,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.error === undefined
      ? {}
      : { error: { code: value.error.code, message: value.error.message } }),
    usage: {
      calls: value.usage.calls,
      unmeasuredCalls: value.usage.unmeasuredCalls,
      inputTokens: value.usage.inputTokens,
      cachedInputTokens: value.usage.cachedInputTokens,
      outputTokens: value.usage.outputTokens,
      reasoningTokens: value.usage.reasoningTokens,
    },
    steeringMessages: value.steeringMessages.map((message) => ({
      seq: message.seq,
      content: message.content,
    })),
    subAgentRuns: value.subAgentRuns.map(parseSubAgentRun),
  };
}

function parseSubAgentRun(value: unknown): SubAgentRun {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.toolCallId !== "string" ||
    typeof value.description !== "string" ||
    !(value.status === "completed" || value.status === "failed" ||
      value.status === "cancelled") ||
    !(value.finalAnswer === undefined || typeof value.finalAnswer === "string") ||
    !(value.error === undefined || isConversationRunError(value.error)) ||
    !isRunUsageTotals(value.usage) ||
    !isNonNegativeInteger(value.messageCount) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new RunProtocolError("服务端返回了无效的会话数据。");
  }
  return {
    id: value.id,
    toolCallId: value.toolCallId,
    description: value.description,
    status: value.status,
    ...(value.finalAnswer === undefined ? {} : { finalAnswer: value.finalAnswer }),
    ...(typeof value.stopReason === "string" ? { stopReason: value.stopReason } : {}),
    ...(value.error === undefined
      ? {}
      : { error: { code: value.error.code, message: value.error.message } }),
    usage: { ...value.usage },
    messageCount: value.messageCount,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function isRunSteeringMessage(value: unknown): value is RunSteeringMessage {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.seq) &&
    typeof value.content === "string" &&
    value.content.length > 0
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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isConversationRunError(
  value: unknown,
): value is NonNullable<ConversationRun["error"]> {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}

function isConversationRunStatus(
  value: unknown,
): value is ConversationRunStatus {
  return (
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

export async function streamConversationRun(
  conversationId: string,
  request: RunRequest,
  options: StreamRunOptions,
): Promise<void> {
  return streamRunAt(
    `/v1/agent/conversations/${encodeURIComponent(conversationId)}/runs:stream`,
    request,
    options,
  );
}
export interface SubscribeRunOptions {
  signal: AbortSignal;
  onEvent: (event: AgentEvent, source?: RunEventSource["subAgent"]) => void;
  after?: number;
  lastEventId?: string;
  fetch?: typeof fetch;
  onRunId?: (runId: string) => void;
  snapshot?: boolean;
  onStreamSeq?: (streamSeq: number) => void;
  onSnapshot?: (snapshot: RunSnapshotData) => void;
}

/**
 * 续传 / 接回运行中的 Run。从 `after` 或 `lastEventId`（`{runId}:{seq}`）之后
 * 回放，然后接上实时事件。Run 不在 registry 且已终态返回 410 ENDED，日志超限
 * 返回 410 NOT_REPLAYABLE。收到 run.error 抛 AgentRunError，收到终态序列回放并
 * 结束时不抛错（沿用 streamRunAt 的终态语义）。
 */
export async function subscribeConversationRun(
  conversationId: string,
  runId: string,
  options: SubscribeRunOptions,
): Promise<void> {
  const fetcher = options.fetch ?? fetch;
  const query = options.snapshot === true
    ? "?snapshot=1"
    : options.after !== undefined ? `?after=${options.after}` : "";
  const headers: Record<string, string> = {};
  if (options.lastEventId !== undefined) {
    headers["Last-Event-ID"] = options.lastEventId;
  }
  const response = await fetcher(
    `/v1/agent/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/events${query}`,
    { method: "GET", headers, signal: options.signal },
  );
  if (!response.ok) throw await createHttpError(response);
  if (!response.body) throw new RunProtocolError("响应没有可读取的事件流。");

  let lastSeq = parseLastEventId(options.lastEventId, runId) ?? options.after ?? 0;
  for await (const message of parseSseStream(response.body)) {
    let value: unknown;
    try {
      value = JSON.parse(message.data);
    } catch {
      throw new RunProtocolError("服务端返回了无法解析的事件数据。");
    }
    let record: RunStreamRecord;
    try {
      record = parseRunStreamRecord(value);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown event.";
      throw new RunProtocolError(`服务端事件格式无效：${detail}`);
    }
    if ("snapshot" in record) {
      if (record.streamSeq < lastSeq) continue;
      if (message.event !== undefined && message.event !== "run.snapshot") {
        throw new RunProtocolError("SSE event 字段与快照不一致。");
      }
      lastSeq = record.streamSeq;
      options.onStreamSeq?.(lastSeq);
      options.onSnapshot?.(record.snapshot);
    } else {
      if (record.streamSeq <= lastSeq) continue;
      if (record.streamSeq !== lastSeq + 1) {
        throw new RunProtocolError("事件 streamSeq 不是严格连续递增的。");
      }
      if (message.event !== undefined && message.event !== record.event.type) {
        throw new RunProtocolError("SSE event 字段与事件数据不一致。");
      }
      lastSeq = record.streamSeq;
      options.onStreamSeq?.(lastSeq);
      if (record.event.runId !== runId && record.subAgent === undefined) {
        throw new RunProtocolError("父事件的 runId 与请求不一致。");
      }
      options.onEvent(record.event, record.subAgent);
    }
  }
}

export function parseRunStreamRecord(value: unknown): RunStreamRecord {
  if (!isRecord(value) || typeof value.streamSeq !== "number" || !Number.isSafeInteger(value.streamSeq) || value.streamSeq < 0) {
    throw new Error("Stream record envelope is invalid.");
  }
  if ("snapshot" in value) {
    return { streamSeq: value.streamSeq as number, snapshot: parseRunSnapshotData(value.snapshot) };
  }
  if (value.streamSeq < 1 || !isRecord(value.event)) throw new Error("Stream event is missing or its position is invalid.");
  const event = parseAgentEvent(value.event);
  let subAgent: RunEventSource["subAgent"];
  if (value.subAgent !== undefined) {
    if (!isRecord(value.subAgent) || typeof value.subAgent.toolCallId !== "string" ||
      typeof value.subAgent.parentStep !== "number" || !Number.isInteger(value.subAgent.parentStep)) throw new Error("Stream sub-agent source is invalid.");
    subAgent = { toolCallId: value.subAgent.toolCallId, parentStep: value.subAgent.parentStep };
  }
  return { streamSeq: value.streamSeq as number, event, ...(subAgent === undefined ? {} : { subAgent }) };
}

function parseLastEventId(value: string | undefined, runId: string): number | undefined {
  if (value === undefined || !value.startsWith(`${runId}:`)) return undefined;
  const cursor = Number(value.slice(runId.length + 1));
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : undefined;
}

export async function cancelConversationRun(
  conversationId: string,
  runId: string,
  options?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<{ runId: string; status: string }> {
  const fetcher = options?.fetch ?? fetch;
  const response = await fetcher(
    `/v1/agent/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}:cancel`,
    { method: "POST", signal: options?.signal },
  );
  if (!response.ok) throw await createHttpError(response);
  const body = (await response.json()) as unknown;
  if (!isRecord(body) || typeof body.runId !== "string" || typeof body.status !== "string") {
    throw new RunProtocolError("服务端返回了无效的取消响应。");
  }
  return { runId: body.runId, status: body.status };
}

export async function cancelSubAgentRun(
  conversationId: string,
  parentRunId: string,
  childRunId: string,
  options?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<{ runId: string; status: string }> {
  const fetcher = options?.fetch ?? fetch;
  const response = await fetcher(
    `/v1/agent/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(parentRunId)}/sub-agents/${encodeURIComponent(childRunId)}:cancel`,
    { method: "POST", signal: options?.signal },
  );
  if (!response.ok) throw await createHttpError(response);
  const body = (await response.json()) as unknown;
  if (!isRecord(body) || typeof body.runId !== "string" || typeof body.status !== "string") {
    throw new RunProtocolError("服务端返回了无效的子 Run 停止响应。");
  }
  return { runId: body.runId, status: body.status };
}

export async function respondToInteraction(
  interactionId: string,
  decision: ToolApprovalDecision,
  options?: {
    grant?: ToolGrantScope;
    signal?: AbortSignal;
    fetch?: typeof fetch;
  },
): Promise<void> {
  const fetcher = options?.fetch ?? fetch;
  const response = await fetcher(
    `/v1/agent/interactions/${encodeURIComponent(interactionId)}:respond`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response: {
          decision,
          ...(options?.grant === undefined ? {} : { grant: options.grant }),
        },
      }),
      signal: options?.signal,
    },
  );
  if (!response.ok) throw await createHttpError(response);
}

/**
 * 往正在运行的 Run 追加一条用户消息。它与 SSE 流是两条独立请求，
 * 生效结果由已建立的那条流以 steering.applied 返回。
 */
export async function steerConversationRun(
  conversationId: string,
  request: { runId: string; input: string },
  options?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<{ runId: string; seq: number }> {
  const fetcher = options?.fetch ?? fetch;
  const response = await fetcher(
    `/v1/agent/conversations/${encodeURIComponent(conversationId)}/runs:steer`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: options?.signal,
    },
  );
  if (!response.ok) throw await createHttpError(response);
  const body = (await response.json()) as unknown;
  if (
    !isRecord(body) ||
    typeof body.runId !== "string" ||
    !isNonNegativeInteger(body.seq)
  ) {
    throw new RunProtocolError("服务端返回了无效的插话响应。");
  }
  return { runId: body.runId, seq: body.seq };
}

export async function selectWorkspaceFile(
  interactionId: string,
  options?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<void> {
  const fetcher = options?.fetch ?? fetch;
  const response = await fetcher(
    `/v1/agent/interactions/${encodeURIComponent(interactionId)}:select-file`,
    {
      method: "POST",
      signal: options?.signal,
    },
  );
  if (!response.ok) throw await createHttpError(response);
}

/** 目录选择器识别结果；不创建会话。 */
export interface ProjectSelectionInspection {
  projectKey: string | null;
  projectType: "git" | "directory" | "unknown";
  selectedPath: string;
  selectedCheckoutRoot: string | null;
  mainWorkspace: string | null;
  selectionKind: "main" | "worktree" | "subdirectory" | "directory" | "unknown";
  selectionToken: string;
  /** Git 信息不可用时的原因；可用时为 undefined。 */
  unavailableReason?: string;
}

export interface ProjectWorktreeEntry {
  path: string;
  branch: string | null;
  commit: string;
  kind: "main" | "worktree";
  available: boolean;
}

export interface ProjectWorktrees {
  projectKey: string;
  mainWorkspace: string;
  worktrees: ProjectWorktreeEntry[];
}

/** 本机已有的远端分支；`name` 不含远端前缀，`hasLocalBranch` 表示同名本地分支已存在。 */
export interface ProjectRemoteBranch {
  remote: string;
  name: string;
  hasLocalBranch: boolean;
}

export interface ProjectBranches {
  /** 本地分支，可直接作为起点。 */
  branches: string[];
  /** 仓库已配置的 remote 名，与是否已有远端分支引用无关。 */
  remotes: string[];
  /** 远端分支：作为起点时创建前会先 fetch 该分支。 */
  remoteBranches: ProjectRemoteBranch[];
  recommendedBranch: string | null;
  recommendationSource: string | null;
}

export interface NewWorktreeRequest {
  /** 起点位置：本地分支或远端分支。 */
  baseRefKind: "local" | "remote";
  /** 起点分支名，不含远端前缀。 */
  baseBranch: string;
  /** 起点所在远端；仅 `baseRefKind` 为 `remote` 时出现。 */
  baseRemote?: string;
  branch: string;
  /** true 时检出已存在的本地分支 `branch`，而不是创建新分支。 */
  checkoutExisting?: boolean;
  operationId: string;
}

export type OpenWorkspaceRequest =
  | { kind: "main" }
  | { kind: "existing_worktree"; path: string }
  | ({ kind: "new_worktree" } & NewWorktreeRequest)
  | { kind: "selected_directory" }
  | { kind: "directory" };

export interface WorktreeNeedsInspection {
  operationId: string;
  status: string;
  targetPath: string;
  branch: string;
  reason: string;
}

export type OpenConversationResult =
  | { kind: "conversation"; conversation: ConversationDetail }
  | { kind: "needs_inspection"; operation: WorktreeNeedsInspection };

/** 打开目录选择器并识别目录；不创建会话。 */
export async function inspectWorkspaceSelection(options?: {
  signal?: AbortSignal;
  fetch?: typeof fetch;
}): Promise<ProjectSelectionInspection> {
  const fetcher = options?.fetch ?? fetch;
  const response = await fetcher("/v1/agent/conversations:select-workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "inspect" }),
    signal: options?.signal,
  });
  if (!response.ok) throw await createHttpError(response);
  return parseProjectSelection(await response.json());
}

/** 项目分支与 worktree 的定位方式：已登记项目用 key，首次选择用令牌。 */
export type ProjectQuery =
  | { readonly projectKey: string }
  | { readonly selectionToken: string };

export async function getProjectBranches(
  query: ProjectQuery,
  options?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<ProjectBranches> {
  const fetcher = options?.fetch ?? fetch;
  const response = await fetcher(
    `/v1/agent/projects/branches${projectQueryString(query)}`,
    { method: "GET", signal: options?.signal },
  );
  if (!response.ok) throw await createHttpError(response);
  const body = (await response.json()) as unknown;
  if (
    !isRecord(body) ||
    !Array.isArray(body.branches) ||
    !body.branches.every((branch) => typeof branch === "string") ||
    !Array.isArray(body.remotes) ||
    !body.remotes.every((remote) => typeof remote === "string") ||
    !Array.isArray(body.remoteBranches) ||
    !body.remoteBranches.every(isRemoteBranch) ||
    !(body.recommendedBranch === null || typeof body.recommendedBranch === "string") ||
    !(body.recommendationSource === null || typeof body.recommendationSource === "string")
  ) {
    throw new RunProtocolError("服务端返回了无效的分支列表。");
  }
  return {
    branches: body.branches as string[],
    remotes: body.remotes as string[],
    remoteBranches: body.remoteBranches as ProjectRemoteBranch[],
    recommendedBranch: body.recommendedBranch,
    recommendationSource: body.recommendationSource,
  };
}

function isRemoteBranch(value: unknown): value is ProjectRemoteBranch {
  return isRecord(value) &&
    typeof value.remote === "string" &&
    typeof value.name === "string" &&
    typeof value.hasLocalBranch === "boolean";
}

export async function getProjectWorktrees(
  query: ProjectQuery,
  options?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<ProjectWorktrees> {
  const fetcher = options?.fetch ?? fetch;
  const response = await fetcher(
    `/v1/agent/projects/worktrees${projectQueryString(query)}`,
    { method: "GET", signal: options?.signal },
  );
  if (!response.ok) throw await createHttpError(response);
  const body = (await response.json()) as unknown;
  if (
    !isRecord(body) ||
    typeof body.mainWorkspace !== "string" ||
    !Array.isArray(body.worktrees)
  ) {
    throw new RunProtocolError("服务端返回了无效的 worktree 列表。");
  }
  return {
    projectKey: typeof body.projectKey === "string" ? body.projectKey : "",
    mainWorkspace: body.mainWorkspace,
    worktrees: body.worktrees.map(parseProjectWorktree),
  };
}

function projectQueryString(query: ProjectQuery): string {
  return "projectKey" in query
    ? `?projectKey=${encodeURIComponent(query.projectKey)}`
    : `?selectionToken=${encodeURIComponent(query.selectionToken)}`;
}

/**
 * 创建会话。使用首次选择目录时，请求带 `selectionToken` 与 `selected_directory`；
 * 已登记项目使用 `projectKey`。worktree 创建中断时返回需要检查的操作信息。
 */
export async function openConversation(
  request: {
    executionMode: ExecutionMode;
    projectKey?: string;
    selectionToken?: string;
    workspace: OpenWorkspaceRequest;
  },
  options?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<OpenConversationResult> {
  const fetcher = options?.fetch ?? fetch;
  const response = await fetcher("/v1/agent/conversations:open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: options?.signal,
  });
  const body = (await response.json()) as unknown;
  if (response.ok) {
    return { kind: "conversation", conversation: parseConversationDetail(body) };
  }
  if (
    response.status === 500 &&
    isRecord(body) &&
    isRecord(body.error) &&
    body.error.code === "WORKTREE_NEEDS_INSPECTION" &&
    isRecord(body.operation) &&
    typeof body.operation.operationId === "string" &&
    typeof body.operation.status === "string" &&
    typeof body.operation.targetPath === "string" &&
    typeof body.operation.branch === "string" &&
    typeof body.operation.reason === "string"
  ) {
    return {
      kind: "needs_inspection",
      operation: {
        operationId: body.operation.operationId,
        status: body.operation.status,
        targetPath: body.operation.targetPath,
        branch: body.operation.branch,
        reason: body.operation.reason,
      },
    };
  }
  throw httpErrorFromBody(response.status, body);
}

function httpErrorFromBody(status: number, body: unknown): HttpRunError {
  if (isRecord(body) && isRecord(body.error)) {
    return new HttpRunError(
      status,
      typeof body.error.message === "string" ? body.error.message : `请求失败（HTTP ${status}）。`,
      typeof body.error.code === "string" ? body.error.code : undefined,
    );
  }
  return new HttpRunError(status, `请求失败（HTTP ${status}）。`);
}

function parseProjectSelection(value: unknown): ProjectSelectionInspection {
  if (
    !isRecord(value) ||
    !(value.projectKey === null || typeof value.projectKey === "string") ||
    (value.projectType !== "git" &&
      value.projectType !== "directory" &&
      value.projectType !== "unknown") ||
    typeof value.selectedPath !== "string" ||
    !(value.selectedCheckoutRoot === null || typeof value.selectedCheckoutRoot === "string") ||
    !(value.mainWorkspace === null || typeof value.mainWorkspace === "string") ||
    (value.selectionKind !== "main" &&
      value.selectionKind !== "worktree" &&
      value.selectionKind !== "subdirectory" &&
      value.selectionKind !== "directory" &&
      value.selectionKind !== "unknown") ||
    typeof value.selectionToken !== "string"
  ) {
    throw new RunProtocolError("服务端返回了无效的目录识别结果。");
  }
  return {
    projectKey: value.projectKey,
    projectType: value.projectType,
    selectedPath: value.selectedPath,
    selectedCheckoutRoot: value.selectedCheckoutRoot,
    mainWorkspace: value.mainWorkspace,
    selectionKind: value.selectionKind,
    selectionToken: value.selectionToken,
    ...(typeof value.unavailableReason === "string"
      ? { unavailableReason: value.unavailableReason }
      : {}),
  };
}

function parseProjectWorktree(value: unknown): ProjectWorktreeEntry {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !(value.branch === null || typeof value.branch === "string") ||
    typeof value.commit !== "string" ||
    (value.kind !== "main" && value.kind !== "worktree") ||
    typeof value.available !== "boolean"
  ) {
    throw new RunProtocolError("服务端返回了无效的 worktree 数据。");
  }
  return {
    path: value.path,
    branch: value.branch,
    commit: value.commit,
    kind: value.kind,
    available: value.available,
  };
}

export type McpServerConfig = {
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
};

export type McpServerEntry = {
  name: string;
  config: McpServerConfig;
};

export type McpConfigDiagnostic = {
  code: string;
  server?: string;
  path: string;
  message: string;
};

export type McpConfigView = {
  servers: McpServerEntry[];
  diagnostics: McpConfigDiagnostic[];
};

export type McpProbeResult =
  | { ok: true; tools: Array<{ name: string; description?: string }> }
  | { ok: false; message: string };

export async function getMcpConfig(
  options?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<McpConfigView> {
  const fetcher = options?.fetch ?? fetch;
  const response = await fetcher("/v1/agent/mcp-config", {
    method: "GET",
    signal: options?.signal,
  });
  if (!response.ok) throw await createHttpError(response);
  return parseMcpConfigView(await response.json());
}

export async function saveMcpConfig(
  servers: Record<string, Record<string, unknown>>,
  options?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<McpConfigView> {
  const fetcher = options?.fetch ?? fetch;
  const response = await fetcher("/v1/agent/mcp-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ servers }),
    signal: options?.signal,
  });
  if (!response.ok) throw await createHttpError(response);
  return parseMcpConfigView(await response.json());
}

export async function probeMcpServer(
  name: string,
  config: Record<string, unknown>,
  options?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<McpProbeResult> {
  const fetcher = options?.fetch ?? fetch;
  const response = await fetcher("/v1/agent/mcp-config:probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, config }),
    signal: options?.signal,
  });
  if (!response.ok) throw await createHttpError(response);
  return (await response.json()) as McpProbeResult;
}

function parseMcpConfigView(value: unknown): McpConfigView {
  if (!isRecord(value) || !Array.isArray(value.servers) || !Array.isArray(value.diagnostics)) {
    throw new RunProtocolError("服务端返回了无效的 MCP 配置数据。");
  }
  return {
    servers: value.servers.map(parseMcpServerEntry),
    diagnostics: value.diagnostics.map(parseMcpConfigDiagnostic),
  };
}

function parseMcpServerEntry(value: unknown): McpServerEntry {
  if (!isRecord(value) || typeof value.name !== "string" || !isRecord(value.config)) {
    throw new RunProtocolError("服务端返回了无效的 MCP Server 数据。");
  }
  const config = value.config;
  if (
    config.type !== "stdio" &&
    config.type !== "http"
  ) {
    throw new RunProtocolError("服务端返回了无效的 MCP Server 数据。");
  }
  return {
    name: value.name,
    config: {
      type: config.type,
      ...(typeof config.command === "string" ? { command: config.command } : {}),
      ...(Array.isArray(config.args) ? { args: config.args as string[] } : {}),
      ...(isRecord(config.env) ? { env: config.env as Record<string, string> } : {}),
      ...(typeof config.cwd === "string" ? { cwd: config.cwd } : {}),
      ...(typeof config.url === "string" ? { url: config.url } : {}),
      ...(isRecord(config.headers) ? { headers: config.headers as Record<string, string> } : {}),
      timeoutMs: typeof config.timeoutMs === "number" ? config.timeoutMs : 60_000,
    },
  };
}

function parseMcpConfigDiagnostic(value: unknown): McpConfigDiagnostic {
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    typeof value.path !== "string" ||
    typeof value.message !== "string"
  ) {
    throw new RunProtocolError("服务端返回了无效的 MCP 诊断数据。");
  }
  return {
    code: value.code,
    ...(typeof value.server === "string" ? { server: value.server } : {}),
    path: value.path,
    message: value.message,
  };
}


interface StreamRunOptions {
  signal: AbortSignal;
  onEvent: (event: AgentEvent, source?: RunEventSource["subAgent"]) => void;
  fetch?: typeof fetch;
  onRunId?: (runId: string) => void;
  onStreamSeq?: (streamSeq: number) => void;
  onSnapshot?: (snapshot: RunSnapshotData) => void;
}

async function streamRunAt(
  path: string,
  request: RunRequest,
  options: StreamRunOptions,
): Promise<void> {
  const fetcher = options.fetch ?? fetch;
  const response = await fetcher(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: options.signal,
  });

  if (!response.ok) throw await createHttpError(response);
  if (!response.body) throw new RunProtocolError("响应没有可读取的事件流。");
  // 首条事件前断线也能拿到 runId：runs:stream 响应头带 X-Run-Id。
  const headerRunId = response.headers.get("x-run-id");
  if (headerRunId !== null && headerRunId !== "") {
    options.onRunId?.(headerRunId);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("text/event-stream")) {
    throw new RunProtocolError("服务端返回了非 SSE 响应。");
  }

  let terminal = false;
  let runId: string | undefined = headerRunId ?? undefined;
  let lastStreamSeq = 0;
  for await (const message of parseSseStream(response.body)) {
    let value: unknown;
    try {
      value = JSON.parse(message.data);
    } catch {
      throw new RunProtocolError("服务端返回了无法解析的事件数据。");
    }

    let record: RunStreamRecord;
    try {
      record = parseRunStreamRecord(value);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown event.";
      throw new RunProtocolError(`服务端事件格式无效：${detail}`);
    }
    if (!("snapshot" in record) && record.streamSeq < 1) throw new RunProtocolError("普通事件的 streamSeq 必须从 1 开始。");
    if (record.streamSeq <= lastStreamSeq) continue;
    if (record.streamSeq !== lastStreamSeq + 1) {
      throw new RunProtocolError("事件 streamSeq 不是严格连续递增的。");
    }
    lastStreamSeq = record.streamSeq;
    options.onStreamSeq?.(lastStreamSeq);
    if ("snapshot" in record) {
      if (message.event !== undefined && message.event !== "run.snapshot") {
        throw new RunProtocolError("SSE event 字段与快照不一致。");
      }
      if (runId === undefined) runId = headerRunId ?? undefined;
      options.onSnapshot?.(record.snapshot);
      continue;
    }
    const event = record.event;
    if (message.event !== undefined && message.event !== event.type) {
      throw new RunProtocolError("SSE event 字段与事件数据不一致。");
    }
    if (runId === undefined) runId = event.runId;
    else if (event.runId !== runId && record.subAgent === undefined) {
      throw new RunProtocolError("父事件流中的 runId 与请求不一致。");
    }
    options.onEvent(event, record.subAgent);
    if (record.subAgent !== undefined) continue;
    if (event.type === "run.error") {
      terminal = true;
      throw new AgentRunError(event.data.code, event.data.message);
    }
    if (event.type === "run.completed") terminal = true;
    if (event.type === "run.cancelled") terminal = true;
  }

  if (!terminal) throw new RunProtocolError("事件流在运行结束前意外断开。");
}

async function createHttpError(response: Response): Promise<HttpRunError> {
  let code: string | undefined;
  let message = `请求失败（HTTP ${response.status}）。`;
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; message?: unknown };
    };
    if (typeof body.error?.code === "string") code = body.error.code;
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // Keep the stable HTTP fallback when an upstream returns a non-JSON error.
  }
  return new HttpRunError(response.status, message, code);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 查询飞书桥接是否已配置凭证。 */
export async function getLarkCapability(options?: {
  signal?: AbortSignal;
  fetch?: typeof fetch;
}): Promise<{ enabled: boolean }> {
  const fetcher = options?.fetch ?? fetch;
  const response = await fetcher("/v1/agent/lark/capability", {
    method: "GET",
    signal: options?.signal,
  });
  if (!response.ok) throw await createHttpError(response);
  const body = (await response.json()) as unknown;
  if (!isRecord(body) || typeof body.enabled !== "boolean") {
    throw new RunProtocolError("服务端返回了无效的飞书能力数据。");
  }
  return { enabled: body.enabled };
}

export interface IssuedLarkBindingCode {
  code: string;
  expiresAt: string;
}

/** 为会话签发绑定码；重复调用会作废旧码。 */
export async function issueLarkBindingCode(
  conversationId: string,
  options?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<IssuedLarkBindingCode> {
  const fetcher = options?.fetch ?? fetch;
  const response = await fetcher(
    `/v1/agent/conversations/${encodeURIComponent(conversationId)}/lark-binding/code`,
    { method: "POST", signal: options?.signal },
  );
  if (!response.ok) throw await createHttpError(response);
  const body = (await response.json()) as unknown;
  if (
    !isRecord(body) ||
    typeof body.code !== "string" ||
    typeof body.expiresAt !== "string"
  ) {
    throw new RunProtocolError("服务端返回了无效的绑定码数据。");
  }
  return { code: body.code, expiresAt: body.expiresAt };
}

export interface LarkBindingStatus {
  bound: boolean;
  createdAt?: string;
}

/** 读取会话的飞书绑定状态。 */
export async function getLarkBinding(
  conversationId: string,
  options?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<LarkBindingStatus> {
  const fetcher = options?.fetch ?? fetch;
  const response = await fetcher(
    `/v1/agent/conversations/${encodeURIComponent(conversationId)}/lark-binding`,
    { method: "GET", signal: options?.signal },
  );
  if (!response.ok) throw await createHttpError(response);
  const body = (await response.json()) as unknown;
  if (!isRecord(body) || typeof body.bound !== "boolean") {
    throw new RunProtocolError("服务端返回了无效的绑定状态数据。");
  }
  return {
    bound: body.bound,
    ...(typeof body.createdAt === "string" ? { createdAt: body.createdAt } : {}),
  };
}

/** 解除会话的飞书绑定；重复解绑返回同样的成功结果。 */
export async function unbindLarkChat(
  conversationId: string,
  options?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<void> {
  const fetcher = options?.fetch ?? fetch;
  const response = await fetcher(
    `/v1/agent/conversations/${encodeURIComponent(conversationId)}/lark-binding`,
    { method: "DELETE", signal: options?.signal },
  );
  if (!response.ok) throw await createHttpError(response);
}
