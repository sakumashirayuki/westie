import { basename } from "node:path";

import type {
  ConversationProjectView,
  ConversationSummaryView,
  ConversationView,
  WorkspaceKind,
} from "../domain/conversation.js";
import {
  ConversationArchivedError,
  ConversationBusyError,
  ConversationNotFoundError,
  ConversationWorkspaceSharedError,
} from "../domain/conversation.js";
import type {
  ConversationProjectAssignment,
  ConversationStore,
  StoredWorkspaceKind,
} from "./conversation-store.js";
import type { GitRunner } from "../infrastructure/git-process-runner.js";
import { GIT_WORKTREE_TIMEOUT_MS } from "../infrastructure/git-process-runner.js";
import type {
  SQLiteWorktreeOperationStore,
  WorktreeOperationRecord,
} from "../infrastructure/sqlite/worktree-operation-store.js";
import type { ToolGrantStore } from "./tool-grant-store.js";
import {
  deriveWorkspaceKind,
  type WorkspaceProbeCache,
} from "./workspace-status.js";

export const DEFAULT_CONVERSATION_LIST_LIMIT = 50;
export const MAX_CONVERSATION_LIST_LIMIT = 100;
/** 会话标题最大字符数，与 `conversations.title` 的 CHECK 约束一致。 */
export const MAX_CONVERSATION_TITLE_LENGTH = 120;

const MAX_CURSOR_LENGTH = 512;

export interface ListConversationsOptions {
  readonly limit?: number;
  readonly cursor?: string;
  /** 按归档状态过滤；省略返回全部会话。 */
  readonly archived?: boolean;
}

export interface ConversationListPage {
  readonly items: readonly ConversationSummaryView[];
  readonly nextCursor: string | null;
}

interface ConversationCursorPayload {
  readonly v: 1;
  readonly updatedAt: string;
  readonly id: string;
}

export class InvalidConversationListRequestError extends Error {
  constructor() {
    super("Conversation list pagination parameters are invalid.");
    this.name = "InvalidConversationListRequestError";
  }
}

export class InvalidConversationTitleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConversationTitleError";
  }
}

export interface ConversationServiceOptions {
  readonly toolGrantStore?: ToolGrantStore;
  /** 归档时定位并清理会话创建过的 worktree。 */
  readonly worktreeOperations?: SQLiteWorktreeOperationStore;
  /** 归档时执行 Git 清理；缺省为 undefined 时不执行任何 Git 操作。 */
  readonly gitRunner?: GitRunner;
  /**
   * 已识别项目的目录状态来源。缺省时只返回持久化字段，工作目录状态为
   * 未知、可用。
   */
  readonly statusSource?: WorkspaceStatusDependencies;
}

export interface WorkspaceStatusDependencies {
  /** 为一次列表或详情读取创建新的探测缓存。 */
  createProbeCache(projectKey: string | null): WorkspaceProbeCache;
  /** 识别尚未归属的会话目录；返回 null 表示暂时无法判断。 */
  identifyProject(
    canonicalPath: string,
  ): Promise<ConversationProjectAssignment | null>;
}

export class ConversationService {
  constructor(
    private readonly conversationStore: ConversationStore,
    private readonly options: ConversationServiceOptions = {},
  ) {}

  get toolGrantStore(): ToolGrantStore | undefined {
    return this.options.toolGrantStore;
  }

  /** 读取会话详情，并补齐项目归属与工作目录实时状态。 */
  async getConversation(conversationId: string): Promise<ConversationView> {
    const conversation = this.conversationStore.getConversation(conversationId);
    const resolved = await this.#enrichConversationOrFallback(conversation);
    return {
      ...conversation,
      project: resolved.project,
      workspaceKind: resolved.workspaceKind,
      workspaceStatus: resolved.workspaceStatus,
    };
  }

  deleteConversation(conversationId: string): void {
    this.conversationStore.deleteConversation(conversationId);
    this.options.toolGrantStore?.clear(conversationId);
  }

  /**
   * 归档一个没有活动 Run 的会话。若会话由 Westie 创建过 worktree（`completed`
   * 操作记录），先删除该 worktree 目录，再置 `archived=1`。分支一律保留：
   * 分支可能由用户在「检出已有分支」模式下带入，或含有尚未合并的提交，
   * 删除分支会让这些提交不可达。清理失败时归档中止，会话保持未归档，
   * 便于用户重试。
   */
  async archiveConversation(conversationId: string): Promise<void> {
    const conversation = this.conversationStore.getConversation(conversationId);
    if (conversation.archived) {
      throw new ConversationArchivedError(conversationId);
    }
    if (this.conversationStore.getActiveRunId(conversationId) !== undefined) {
      throw new ConversationBusyError(conversationId);
    }
    const operation = this.options.worktreeOperations
      ?.findCompletedByConversation(conversationId);
    if (operation !== undefined && this.options.gitRunner !== undefined) {
      const shared = this.conversationStore.hasActiveConversationAt(
        conversationId,
        operation.targetPath,
      );
      if (shared) {
        throw new ConversationWorkspaceSharedError(
          conversationId,
          operation.targetPath,
        );
      }
      await this.#removeWorktree(operation);
    }
    this.conversationStore.archiveConversation(conversationId);
  }

  /**
   * 设置会话标题，`null` 表示恢复为工作区名。标题去掉首尾空白后按字符数校验，
   * 空白标题按 `null` 处理，避免侧栏出现一个看不见名字的会话。
   */
  async renameConversation(
    conversationId: string,
    title: string | null,
  ): Promise<ConversationSummaryView> {
    const normalized = normalizeConversationTitle(title);
    const renamed = this.conversationStore.renameConversation(
      conversationId,
      normalized,
    );
    const resolved = await this.#enrichConversationOrFallback(renamed);
    return {
      ...renamed,
      project: resolved.project,
      workspaceKind: resolved.workspaceKind,
      workspaceStatus: resolved.workspaceStatus,
    };
  }

  /**
   * 列表读取会为未识别的会话补全项目归属，属于异步操作。分页参数错误以
   * rejected promise 返回（`InvalidConversationListRequestError`）。
   */
  listConversations(
    options: ListConversationsOptions = {},
  ): Promise<ConversationListPage> {
    // 参数校验先同步执行：调用方不需要 await 就能拒绝非法分页请求。
    const limit = this.#parseLimit(options);
    const after = options.cursor === undefined
      ? undefined
      : decodeConversationCursor(options.cursor);
    return this.#listPage(
      limit,
      after,
      options.archived,
    );
  }

  async #listPage(
    limit: number,
    after: ConversationCursorPayload | undefined,
    archived: boolean | undefined,
  ): Promise<ConversationListPage> {
    const rows = this.conversationStore.listConversations({
      limit: limit + 1,
      ...(after === undefined
        ? {}
        : { after: { updatedAt: after.updatedAt, id: after.id } }),
      ...(archived === undefined ? {} : { archived }),
    });
    const hasNextPage = rows.length > limit;
    const page = rows.slice(0, limit);
    const items = await this.#resolvePage(page);
    const lastItem = items.at(-1);
    return {
      items,
      nextCursor:
        hasNextPage && lastItem !== undefined
          ? encodeConversationCursor({
              v: 1,
              updatedAt: lastItem.updatedAt,
              id: lastItem.id,
            })
          : null,
    };
  }

  /** 同步校验分页参数；请求格式错误必须在这里直接抛出，不进入异步补全。 */
  #parseLimit(options: ListConversationsOptions): number {
    const limit = options.limit ?? DEFAULT_CONVERSATION_LIST_LIMIT;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_CONVERSATION_LIST_LIMIT
    ) {
      throw new InvalidConversationListRequestError();
    }
    return limit;
  }

  async #resolvePage(
    conversations: readonly ConversationSummaryView[],
  ): Promise<ConversationSummaryView[]> {
    const resolved: ConversationSummaryView[] = [];
    for (const conversation of conversations) {
      // 列表响应不包含实时工作目录状态。已识别项目的归属已经持久化，
      // 无需为列表再次执行 Git 探测；未识别的历史会话仍需探测以完成懒回填。
      if (conversation.project !== null) {
        resolved.push(conversation);
        continue;
      }
      // 逐条降级：某个目录识别失败不影响整页。
      resolved.push(await this.#enrichConversationOrFallback(conversation));
    }
    return resolved;
  }

  async #enrichConversationOrFallback(
    conversation: ConversationSummaryView,
  ): Promise<ConversationSummaryView> {
    try {
      return await this.#enrichConversation(conversation);
    } catch {
      return { ...conversation };
    }
  }

  /**
   * 删除 Westie 为会话创建的 worktree 目录，不删除分支。`git worktree remove
   * --force` 清目录；目录已不存在时按已清理处理。分支只是廉价的引用，却可能
   * 指向用户尚未合并的提交，因此保留给用户自行处理。命令在操作记录的
   * project_root 下执行，保证粘在同一个仓库上。
   */
  async #removeWorktree(
    operation: WorktreeOperationRecord,
  ): Promise<void> {
    const runner = this.options.gitRunner!;
    const cwd = operation.projectRoot;
    const runWorktreeRemove = await runner.run({
      cwd,
      args: ["worktree", "remove", "--force", "--", operation.targetPath],
      timeoutMs: GIT_WORKTREE_TIMEOUT_MS,
    });
    const worktreeMissing = runWorktreeRemove.exitCode !== 0 &&
      /is not a working tree|not a valid working tree|no such file or directory/i.test(
        runWorktreeRemove.stderr,
      );
    if (runWorktreeRemove.exitCode !== 0 && !worktreeMissing) {
      throw new Error(
        `清理 worktree 失败：${runWorktreeRemove.stderr.trim() ||
          runWorktreeRemove.stdout.trim() || "git worktree remove 失败。"}`,
      );
    }
  }

  /**
   * 补齐单个会话的项目归属与工作目录实时状态。
   *
   * 归属缺失时先识别目录：识别成功写回两列，Git 暂时不可用则保留为
   * 「未识别」，下次刷新重试。工作目录类型只在识别成功且尚未写入时补写。
   * 识别和补写都不改变 `revision`、`updated_at` 与运行状态。
   */
  async #enrichConversation(
    conversation: ConversationSummaryView,
  ): Promise<ConversationSummaryView> {
    const statusSource = this.options.statusSource;
    if (statusSource === undefined) return { ...conversation };

    const canonicalPath = conversation.workspace.canonicalPath;
    let project = conversation.project;
    let storedKind = conversation.workspaceKind;
    const cache = statusSource.createProbeCache(project?.key ?? null);
    // 未识别会话的 directory 只是创建时 Git 暂时不可用的占位值；重新
    // 刷新时必须重新探测，否则 knownKind 会阻止 Git 恢复后的类型修复。
    const probe = await cache.get(
      canonicalPath,
      project === null ? undefined : storedKind ?? undefined,
    );
    const kind = deriveWorkspaceKind(
      {
        canonicalPath,
        ...(project === null || storedKind === null ? {} : { knownKind: storedKind }),
      },
      probe,
    );

    if (project === null) {
      const identified = await statusSource.identifyProject(canonicalPath);
      // 识别成功且目录类型已判定时一次性写入两列；Git 暂时不可用时保持 NULL，
      // 下次刷新重试。写入条件包含两列仍为 NULL，并发回填不会互相覆盖。
      const isKnownGitWorkspace = storedKind === "main" ||
        storedKind === "worktree" || storedKind === "subdirectory";
      const isPlainDirectoryFallback = identified?.projectKey.startsWith("dir:") ?? false;
      if (
        identified !== null &&
        kind !== "unknown" &&
        // 已知 Git 工作目录不能回填为普通目录，保留空归属以便下次重试。
        !(isKnownGitWorkspace && isPlainDirectoryFallback)
      ) {
        this.conversationStore.recordConversationMembership(
          conversation.id,
          identified,
          kind,
        );
        project = toProjectView(identified);
        storedKind = kind;
      }
    } else if (storedKind === null && probe.checkoutRoot !== null && kind !== "unknown") {
      // 归属已识别、目录类型尚未判定：单独补写类型。
      this.conversationStore.recordConversationWorkspaceKind(conversation.id, kind);
      storedKind = kind;
    }

    return {
      ...conversation,
      project,
      workspaceKind: storedKind,
      workspaceStatus: {
        kind,
        branch: probe.branch,
        availability: probe.availability,
      },
    };
  }
}

function toProjectView(
  assignment: ConversationProjectAssignment,
): ConversationProjectView {
  const root = assignment.projectRoot;
  return {
    key: assignment.projectKey,
    root,
    name: basename(root) || root,
  };
}

/**
 * 标题规范化：`null` 原样返回；去掉首尾空白后为空按 `null` 处理；超过上限抛错。
 * 按 Unicode 码点计数，和 SQLite `length()` 对 TEXT 的计数口径一致。
 */
function normalizeConversationTitle(title: string | null): string | null {
  if (title === null) return null;
  const trimmed = title.trim();
  if (trimmed.length === 0) return null;
  const length = [...trimmed].length;
  if (length > MAX_CONVERSATION_TITLE_LENGTH) {
    throw new InvalidConversationTitleError(
      `Conversation title must be at most ${MAX_CONVERSATION_TITLE_LENGTH} characters.`,
    );
  }
  return trimmed;
}

function encodeConversationCursor(payload: ConversationCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeConversationCursor(cursor: string): ConversationCursorPayload {
  if (
    cursor.length === 0 ||
    cursor.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    throw new InvalidConversationListRequestError();
  }

  let decoded: string;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) {
      throw new InvalidConversationListRequestError();
    }
    decoded = bytes.toString("utf8");
  } catch {
    throw new InvalidConversationListRequestError();
  }

  let value: unknown;
  try {
    value = JSON.parse(decoded) as unknown;
  } catch {
    throw new InvalidConversationListRequestError();
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    value.v !== 1 ||
    typeof value.updatedAt !== "string" ||
    !isCanonicalIsoTimestamp(value.updatedAt) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 128
  ) {
    throw new InvalidConversationListRequestError();
  }
  return { v: 1, updatedAt: value.updatedAt, id: value.id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}
