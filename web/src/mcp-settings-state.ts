// MCP 设置弹窗的状态：草稿列表、选中项、脏标记、校验。与 project-open-state 同形，
// 纯函数，便于测试；网络请求由 App 发起，结果以 action 送回。

import type { McpServerEntry } from "./run-client";

export type McpServerType = "stdio" | "http";

export interface KeyValueDraft {
  key: string;
  value: string;
}

export interface McpServerDraft {
  /** 客户端生成的稳定 id，与名字解耦，改名时列表选中不丢。 */
  id: string;
  name: string;
  type: McpServerType;
  command: string;
  args: string[];
  cwd: string;
  url: string;
  env: KeyValueDraft[];
  headers: KeyValueDraft[];
  timeoutMs: string;
}

export type ProbeStatus =
  | { status: "idle" }
  | { status: "probing" }
  | { status: "ok"; toolCount: number }
  | { status: "failed"; message: string };

export type McpSettingsState =
  | { status: "closed" }
  | { status: "loading" }
  | { status: "load_error"; error: string }
  | {
      status: "ready";
      drafts: McpServerDraft[];
      selectedId: string | undefined;
      /** 打开或上次保存成功时的快照，用于脏判断。 */
      saved: string;
      probes: Record<string, ProbeStatus>;
      saving: boolean;
      saveError: string | undefined;
      /** 最近一次保存成功的时刻；「已保存」提示显示到它过期为止。每次保存都变，计时随之重置。 */
      savedAt: number | undefined;
      confirmDiscard: boolean;
    };

export type McpSettingsAction =
  | { type: "open" }
  | { type: "loaded"; servers: readonly McpServerEntry[] }
  | { type: "load_failed"; error: string }
  | { type: "select"; id: string }
  | { type: "add" }
  | { type: "remove"; id: string }
  | { type: "edit"; id: string; patch: Partial<Omit<McpServerDraft, "id">> }
  | { type: "probe_started"; id: string }
  | { type: "probe_finished"; id: string; result: ProbeStatus }
  | { type: "save_started" }
  | { type: "save_succeeded"; servers: readonly McpServerEntry[]; at: number }
  | { type: "save_failed"; error: string }
  /** 只清掉 `at` 对应的那次提示；更新的一次保存不会被旧计时器提前清掉。 */
  | { type: "notice_expired"; at: number }
  | { type: "request_close" }
  | { type: "keep_editing" }
  | { type: "close" };

export const initialMcpSettingsState: McpSettingsState = { status: "closed" };

export const SERVER_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_TIMEOUT_MS = 600_000;

let draftCounter = 0;
function nextId(): string {
  draftCounter += 1;
  return `draft-${draftCounter}`;
}

export function emptyDraft(): McpServerDraft {
  return {
    id: nextId(),
    name: "",
    type: "stdio",
    command: "",
    args: [],
    cwd: "",
    url: "",
    env: [],
    headers: [],
    timeoutMs: "60000",
  };
}

export function toDraft(server: McpServerEntry): McpServerDraft {
  return {
    id: nextId(),
    name: server.name,
    type: server.config.type,
    command: server.config.command ?? "",
    args: [...(server.config.args ?? [])],
    cwd: server.config.cwd ?? "",
    url: server.config.url ?? "",
    env: kvToDraft(server.config.env),
    headers: kvToDraft(server.config.headers),
    timeoutMs: String(server.config.timeoutMs),
  };
}

function kvToDraft(kv: Record<string, string> | undefined): KeyValueDraft[] {
  return kv === undefined
    ? []
    : Object.entries(kv).map(([key, value]) => ({ key, value }));
}

/** 与草稿相关、决定脏标记的部分；id 与探测结果不算。 */
export function snapshot(drafts: readonly McpServerDraft[]): string {
  return JSON.stringify(drafts.map(({ id: _id, ...rest }) => rest));
}

export function isDirty(state: McpSettingsState): boolean {
  return state.status === "ready" && snapshot(state.drafts) !== state.saved;
}

export interface DraftErrors {
  name?: string;
  command?: string;
  url?: string;
  timeoutMs?: string;
  env?: string;
  headers?: string;
}

export function validateDraft(
  draft: McpServerDraft,
  all: readonly McpServerDraft[],
): DraftErrors {
  const errors: DraftErrors = {};
  const name = draft.name.trim();
  if (name === "") {
    errors.name = "请填写名称。";
  } else if (name.length > 32 || !SERVER_NAME_PATTERN.test(name)) {
    errors.name = "只能用小写字母、数字和单个连字符，1 到 32 位。";
  } else if (all.some((other) => other.id !== draft.id && other.name.trim() === name)) {
    errors.name = "已有同名服务器。";
  }
  if (draft.type === "stdio" && draft.command.trim() === "") {
    errors.command = "请填写命令。";
  }
  if (draft.type === "http" && draft.url.trim() === "") {
    errors.url = "请填写地址。";
  }
  const timeout = Number(draft.timeoutMs);
  if (
    draft.timeoutMs.trim() === "" ||
    !Number.isInteger(timeout) ||
    timeout <= 0 ||
    timeout > MAX_TIMEOUT_MS
  ) {
    errors.timeoutMs = `请填写 1 到 ${MAX_TIMEOUT_MS} 之间的整数。`;
  }
  if (draft.env.some((entry) => entry.key.trim() === "" && entry.value !== "")) {
    errors.env = "有值没有键的环境变量。";
  }
  if (draft.headers.some((entry) => entry.key.trim() === "" && entry.value !== "")) {
    errors.headers = "有值没有键的请求头。";
  }
  return errors;
}

export function hasErrors(errors: DraftErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** 第一个有错误的草稿 id；全部合法时为 undefined。 */
export function firstInvalidId(
  drafts: readonly McpServerDraft[],
): string | undefined {
  return drafts.find((draft) => hasErrors(validateDraft(draft, drafts)))?.id;
}

/** 转成写入端点的 servers 对象。调用前应保证全部合法。 */
export function toSaveRequest(
  drafts: readonly McpServerDraft[],
): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {};
  for (const draft of drafts) {
    servers[draft.name.trim()] = toServerConfig(draft);
  }
  return servers;
}

export function toServerConfig(draft: McpServerDraft): Record<string, unknown> {
  const config: Record<string, unknown> = { type: draft.type };
  if (draft.type === "stdio") {
    config.command = draft.command.trim();
    const args = draft.args.map((arg) => arg.trim()).filter((arg) => arg !== "");
    if (args.length > 0) config.args = args;
    if (draft.cwd.trim() !== "") config.cwd = draft.cwd.trim();
    const env = kvFromDraft(draft.env);
    if (env !== undefined) config.env = env;
  } else {
    config.url = draft.url.trim();
    const headers = kvFromDraft(draft.headers);
    if (headers !== undefined) config.headers = headers;
  }
  config.timeoutMs = Number(draft.timeoutMs);
  return config;
}

function kvFromDraft(
  entries: readonly KeyValueDraft[],
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const key = entry.key.trim();
    if (key === "") continue;
    result[key] = entry.value;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

export function mcpSettingsReducer(
  state: McpSettingsState,
  action: McpSettingsAction,
): McpSettingsState {
  switch (action.type) {
    case "open":
      // 读取失败后的「重试」也走这里。
      return state.status === "closed" || state.status === "load_error"
        ? { status: "loading" }
        : state;
    case "close":
      return initialMcpSettingsState;
    case "loaded":
    case "save_succeeded": {
      if (state.status === "closed") return state;
      const drafts = action.servers.map(toDraft);
      const previousSelected = state.status === "ready"
        ? state.drafts.find((draft) => draft.id === state.selectedId)?.name
        : undefined;
      const selected = drafts.find((draft) => draft.name === previousSelected) ??
        drafts[0];
      return {
        status: "ready",
        drafts,
        selectedId: selected?.id,
        saved: snapshot(drafts),
        probes: action.type === "save_succeeded" && state.status === "ready"
          ? remapProbes(state, drafts)
          : {},
        saving: false,
        saveError: undefined,
        savedAt: action.type === "save_succeeded" ? action.at : undefined,
        confirmDiscard: false,
      };
    }
    case "load_failed":
      return state.status === "closed"
        ? state
        : { status: "load_error", error: action.error };
  }

  if (state.status !== "ready") return state;

  switch (action.type) {
    case "select":
      return state.drafts.some((draft) => draft.id === action.id)
        ? { ...state, selectedId: action.id }
        : state;
    case "add": {
      const draft = emptyDraft();
      return {
        ...state,
        drafts: [...state.drafts, draft],
        selectedId: draft.id,
        savedAt: undefined,
      };
    }
    case "remove": {
      const index = state.drafts.findIndex((draft) => draft.id === action.id);
      if (index === -1) return state;
      const drafts = state.drafts.filter((draft) => draft.id !== action.id);
      const neighbour = drafts[Math.min(index, drafts.length - 1)];
      const { [action.id]: _removed, ...probes } = state.probes;
      return {
        ...state,
        drafts,
        selectedId: state.selectedId === action.id
          ? neighbour?.id
          : state.selectedId,
        probes,
        savedAt: undefined,
      };
    }
    case "edit":
      return {
        ...state,
        drafts: state.drafts.map((draft) =>
          draft.id === action.id ? { ...draft, ...action.patch } : draft
        ),
        savedAt: undefined,
      };
    case "probe_started":
      return {
        ...state,
        probes: { ...state.probes, [action.id]: { status: "probing" } },
      };
    case "probe_finished":
      return {
        ...state,
        probes: { ...state.probes, [action.id]: action.result },
      };
    case "save_started":
      return { ...state, saving: true, saveError: undefined, savedAt: undefined };
    case "save_failed":
      return { ...state, saving: false, saveError: action.error };
    case "notice_expired":
      return state.savedAt === action.at ? { ...state, savedAt: undefined } : state;
    case "request_close":
      if (state.saving) return state;
      return isDirty(state) ? { ...state, confirmDiscard: true } : initialMcpSettingsState;
    case "keep_editing":
      return { ...state, confirmDiscard: false };
    default:
      return state;
  }
}

/** 保存后草稿重建、id 变了，按名字把探测结果搬到新 id 上。 */
function remapProbes(
  state: Extract<McpSettingsState, { status: "ready" }>,
  drafts: readonly McpServerDraft[],
): Record<string, ProbeStatus> {
  const byName = new Map(
    state.drafts.map((draft) => [draft.name.trim(), state.probes[draft.id]]),
  );
  const result: Record<string, ProbeStatus> = {};
  for (const draft of drafts) {
    const probe = byName.get(draft.name);
    if (probe !== undefined) result[draft.id] = probe;
  }
  return result;
}
