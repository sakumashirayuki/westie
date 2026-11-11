/**
 * 新建会话：用户选择工作目录、执行模式与起始分支后，服务端校验、必要时由
 * 宿主 Git 创建 worktree、初始化运行环境，再持久化会话。
 *
 * 新建 worktree 走持久操作日志（`worktree_operations`）：先登记 `prepared`
 * 并固定起点 commit，再推进到 `started` 后启动 Git；会话与 `completed` 在同一
 * SQLite 事务内提交。Git 启动后的任何失败都保留现场并标记 `needs_inspection`。
 */
import { realpath, stat } from "node:fs/promises";

import type { ConversationView, ExecutionMode } from "../domain/conversation.js";
import type { GitProcessRunner } from "../infrastructure/git-process-runner.js";
import type {
  SQLiteWorktreeOperationStore,
  WorktreeOperationRecord,
  WorktreeOperationStatus,
} from "../infrastructure/sqlite/worktree-operation-store.js";
import type {
  ConversationProjectAssignment,
  ConversationStore,
  StoredWorkspaceKind,
} from "./conversation-store.js";
import type { ConversationService } from "./conversation-service.js";
import {
  GitRepositoryError,
  type GitBranchRecommendation,
  type GitCheckoutState,
  type GitProjectIdentity,
  type GitProjectService,
} from "./git-project-service.js";
import {
  ProjectDirectoryUnavailableError,
  type ProjectInspection,
} from "./project-inspection.js";
import type { SelectionTokenStore } from "./project-selection-tokens.js";
import type { WorkspaceRuntimeProvider } from "./workspace-runtime.js";
import {
  WorktreeCreationError,
  type WorktreeBase,
  type WorktreeCreator,
} from "./worktree-creation.js";

/** 服务端持久化项目标识；与 `conversations.project_key` 同值。 */
export type ProjectKey = string;

export type OpenWorkspaceRequest =
  /** 使用 Git 项目的主工作目录。 */
  | { readonly kind: "main" }
  /** 使用 Git 已登记的工作目录，path 为其目录路径。 */
  | { readonly kind: "existing_worktree"; readonly path: string }
  /**
   * 创建 worktree。默认从起点分支创建新分支；`checkoutExisting` 为 true 时
   * 不创建新分支，直接检出已存在的本地分支 `branch`，要求该分支未被其他
   * worktree 检出。起点是本机已有 commit 的分支：`baseRefKind` 为 `local`
   * 时是本机存在的本地分支；为 `remote` 时是 `remote` 上的分支，创建前会
   * 先 fetch 该分支（仅创建新分支模式支持远端起点）。
   */
  | {
      readonly kind: "new_worktree";
      /** 起点所在位置：本地分支或远端分支。 */
      readonly baseRefKind: "local" | "remote";
      /** 起点分支名（不含远端前缀）；`baseRefKind` 为 `remote` 时是远端分支名。 */
      readonly baseBranch: string;
      /** 起点所在远端；`baseRefKind` 为 `remote` 时必填，为 `local` 时不得出现。 */
      readonly baseRemote?: string;
      /** 要创建的分支名，或要检出的已有本地分支名。 */
      readonly branch: string;
      /** true 时直接检出已存在的本地分支，不创建新分支。 */
      readonly checkoutExisting?: boolean;
      /** 创建操作的唯一标识，用于查询结果和避免重复创建。 */
      readonly operationId: string;
    }
  /** 使用目录选择器选中的精确路径，需要选择令牌。 */
  | { readonly kind: "selected_directory" }
  /** 使用普通非 Git 项目的目录。 */
  | { readonly kind: "directory" };

export interface OpenConversationRequest {
  readonly executionMode: ExecutionMode;
  /** 已登记项目的 key；与 `selectionToken` 二选一。 */
  readonly projectKey?: string;
  /** 首次由系统选择器确认目录时签发的令牌；与 `projectKey` 二选一。 */
  readonly selectionToken?: string;
  readonly workspace: OpenWorkspaceRequest;
}

export type OpenConversationResult =
  | { readonly kind: "conversation"; readonly conversation: ConversationView }
  /** 同一 operationId 的操作正在进行，尚未产生会话。 */
  | {
      readonly kind: "in_progress";
      readonly operationId: string;
      readonly status: WorktreeOperationStatus;
      readonly targetPath: string;
    }
  /** 创建中断或失败，可能留下分支、目录或登记，需要用户检查。 */
  | {
      readonly kind: "needs_inspection";
      readonly operationId: string;
      readonly status: WorktreeOperationStatus;
      readonly targetPath: string;
      readonly branch: string;
      readonly reason: string;
    };

export type OpenConversationFailureCode =
  | "PROJECT_SELECTION_REQUIRED"
  | "PROJECT_SELECTION_INVALID"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_UNAVAILABLE"
  | "WORKSPACE_UNAVAILABLE"
  | "WORKSPACE_KIND_UNAVAILABLE"
  | "WORKTREE_BRANCH_INVALID"
  | "WORKTREE_FETCH_FAILED"
  | "WORKTREE_TARGET_EXISTS"
  | "WORKTREE_OPERATION_CONFLICT"
  | "WORKTREE_CREATE_FAILED"
  | "WORKSPACE_RUNTIME_UNAVAILABLE";

export class OpenConversationError extends Error {
  constructor(
    readonly code: OpenConversationFailureCode,
    message: string,
    readonly status = 409,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "OpenConversationError";
  }
}

/** 项目分支与 worktree 查询的定位方式：选择令牌或已登记项目 key。 */
export interface ProjectQueryTarget {
  readonly projectKey: string | null;
  readonly selectionToken: string | null;
}

export interface ProjectDescription {
  readonly projectKey: string;
  readonly mainWorkspace: string;
  /** 本地分支、远端分支与推荐值；读取失败时调用方不返回本结构。 */
  readonly branches: GitBranchRecommendation;
  readonly worktrees: readonly {
    readonly path: string;
    readonly branch: string | null;
    readonly commit: string;
    readonly kind: "main" | "worktree";
    readonly available: boolean;
  }[];
}

export interface WorktreeOperationInspection {
  readonly directoryExists: boolean;
  readonly registered: boolean;
  readonly registeredBranch: string | null;
}

export interface WorktreeOperationView {
  readonly operationId: string;
  readonly status: WorktreeOperationStatus;
  readonly projectKey: string;
  readonly projectRoot: string;
  readonly targetPath: string;
  readonly branch: string;
  /** 起点：本地分支名，或远端起点的 `<remote>/<branch>`。 */
  readonly baseBranch: string;
  /** 远端起点的远端名；本地起点为 null。 */
  readonly baseRemote: string | null;
  readonly baseCommit: string;
  readonly executionMode: ExecutionMode;
  readonly conversationId: string | null;
  /** `needs_inspection` 时的只读 Git 与目录检查结果；其它状态为 null。 */
  readonly inspection: WorktreeOperationInspection | null;
}

export interface ConversationOpenServiceOptions {
  readonly conversationService: ConversationService;
  readonly conversationStore: ConversationStore;
  readonly workspaceRuntimeProvider: WorkspaceRuntimeProvider;
  readonly git: GitProjectService;
  readonly gitRunner: GitProcessRunner;
  readonly projectInspection: ProjectInspection;
  readonly worktreeCreator: WorktreeCreator;
  readonly worktreeOperations: SQLiteWorktreeOperationStore;
  readonly selectionTokens: SelectionTokenStore;
}

interface ResolvedProject {
  readonly key: string;
  readonly root: string;
  /** 令牌绑定的选择结果；已登记项目为 null。 */
  readonly checkout: GitCheckoutState | null;
  /** 选择时识别出的所选精确路径（可能位于 checkout 之内）。 */
  readonly selectedPath: string | null;
}

export class ConversationOpenService {
  constructor(private readonly options: ConversationOpenServiceOptions) {}

  async open(
    request: OpenConversationRequest,
    signal?: AbortSignal,
  ): Promise<OpenConversationResult> {
    const project = await this.#resolveProject(request, signal);
    const consumeToken = (): void => {
      if (request.selectionToken !== undefined) {
        this.options.selectionTokens.consume(request.selectionToken);
      }
    };
    const result = await this.#openInProject(project, request, signal);
    if (result.kind === "conversation") consumeToken();
    return result;
  }

  /**
   * 读取操作日志与实时 Git 登记，供响应丢失后确认结果。只读：不创建、不清理。
   * 操作不存在时返回 undefined。
   */
  async inspectOperation(
    operationId: string,
  ): Promise<WorktreeOperationView | undefined> {
    const operation = this.options.worktreeOperations.read(operationId);
    if (operation === undefined) return undefined;
    return {
      operationId: operation.id,
      status: operation.status,
      projectKey: operation.projectKey,
      projectRoot: operation.projectRoot,
      targetPath: operation.targetPath,
      branch: operation.branch,
      baseBranch: operation.baseBranch,
      baseRemote: operation.baseRemote,
      baseCommit: operation.baseCommit,
      executionMode: operation.executionMode,
      conversationId: operation.conversationId,
      inspection: operation.status === "needs_inspection"
        ? await this.#inspectWorktree(operation)
        : null,
    };
  }

  async #openInProject(
    project: ResolvedProject,
    request: OpenConversationRequest,
    signal: AbortSignal | undefined,
  ): Promise<OpenConversationResult> {
    switch (request.workspace.kind) {
      case "main": {
        const canonicalPath = await this.#registeredMainWorkspace(project, signal);
        return {
          kind: "conversation",
          conversation: await this.#createConversation(
            canonicalPath,
            request.executionMode,
            project,
            "main",
          ),
        };
      }
      case "existing_worktree": {
        const canonicalPath = await this.#registeredWorktreePath(
          project,
          request.workspace.path,
          signal,
        );
        const workspaceKind: StoredWorkspaceKind = canonicalPath === project.root
          ? "main"
          : "worktree";
        return {
          kind: "conversation",
          conversation: await this.#createConversation(
            canonicalPath,
            request.executionMode,
            project,
            workspaceKind,
          ),
        };
      }
      case "selected_directory": {
        const canonicalPath = project.selectedPath ??
          (await this.#validatedSelectedDirectory(project, signal));
        let workspaceKind: StoredWorkspaceKind | undefined;
        if (project.key !== "") {
          workspaceKind = project.checkout?.checkoutRoot === canonicalPath
            ? "directory"
            : "subdirectory";
        } else if (project.checkout !== null) {
          if (project.checkout.checkoutRoot !== canonicalPath) {
            workspaceKind = "subdirectory";
          } else if (
            project.checkout.checkoutRoot === project.checkout.project.mainWorkspace
          ) {
            workspaceKind = "main";
          } else {
            workspaceKind = "worktree";
          }
        }
        return {
          kind: "conversation",
          conversation: await this.#createConversation(
            canonicalPath,
            request.executionMode,
            project,
            workspaceKind,
          ),
        };
      }
      case "directory": {
        if (project.key.startsWith("git:") || project.checkout !== null) {
          throw new OpenConversationError(
            "WORKSPACE_KIND_UNAVAILABLE",
            "该目录属于 Git 项目，请选择主目录、已有 worktree 或新建 worktree。",
            400,
          );
        }
        return {
          kind: "conversation",
          conversation: await this.#createConversation(
            project.root,
            request.executionMode,
            project,
            project.key === "" ? undefined : "directory",
          ),
        };
      }
      case "new_worktree":
        return this.#openNewWorktree(project, request, request.workspace, signal);
      default:
        throw new OpenConversationError(
          "WORKSPACE_KIND_UNAVAILABLE",
          "该工作目录类型不可用。",
          400,
        );
    }
  }

  /**
   * 新建 worktree。同一 operationId 重复提交时沿用已固定的 commit：已完成
   * 直接返回会话，进行中或需检查则报告当前状态，参数不同返回冲突。
   */
  async #openNewWorktree(
    project: ResolvedProject,
    request: OpenConversationRequest,
    workspace: Extract<OpenWorkspaceRequest, { kind: "new_worktree" }>,
    signal: AbortSignal | undefined,
  ): Promise<OpenConversationResult> {
    const identity = await this.#verifyGitProject(project, signal);
    if (workspace.checkoutExisting === true && workspace.baseRefKind === "remote") {
      throw new OpenConversationError(
        "WORKTREE_BRANCH_INVALID",
        "检出已有分支只支持本地分支，不能使用远端起点。",
        400,
      );
    }
    const existing = this.options.worktreeOperations.read(workspace.operationId);
    if (existing !== undefined) {
      return this.#retryOrResumeOperation(
        existing,
        identity,
        project,
        request,
        workspace,
        signal,
      );
    }

    const targetPath = this.options.git.targetPathFor(
      project.key,
      workspace.operationId,
    );
    const baseCommit = await this.options.worktreeCreator
      .prepare({
        project: identity,
        base: creatorBase(workspace),
        branch: workspace.branch,
        targetPath,
        ...(workspace.checkoutExisting === true ? { mode: "checkout" as const } : {}),
        ...(signal === undefined ? {} : { signal }),
      })
      .catch((error: unknown) => {
        throw mapWorktreeFailure(error);
      });

    const prepared = this.options.worktreeOperations.prepare({
      id: workspace.operationId,
      projectKey: project.key,
      projectRoot: project.root,
      targetPath,
      branch: workspace.branch,
      baseBranch: storedBaseBranch(workspace),
      baseRemote: storedBaseRemote(workspace),
      baseCommit,
      executionMode: request.executionMode,
    });
    if (!prepared.created) {
      // 上次请求在启动 Git 之前中断（prepared 且没有关联会话）：沿用已固定的
      // commit 重新推进，由主键和条件更新裁决并发，最多一个请求执行 Git。
      if (prepared.record.status === "prepared") {
        this.options.worktreeOperations.markStarted(workspace.operationId);
      }
      return this.#resumeOperation(
        this.options.worktreeOperations.read(workspace.operationId) ??
          prepared.record,
        project,
        request,
        workspace,
      );
    }
    if (!this.options.worktreeOperations.markStarted(workspace.operationId)) {
      const current = this.options.worktreeOperations.read(workspace.operationId);
      if (current === undefined) {
        throw new OpenConversationError(
          "WORKTREE_CREATE_FAILED",
          "worktree 操作记录丢失。",
          500,
        );
      }
      return this.#resumeOperation(current, project, request, workspace);
    }

    try {
      await this.options.worktreeCreator.create(
        {
          project: identity,
          base: creatorBase(workspace),
          branch: workspace.branch,
          targetPath,
          ...(workspace.checkoutExisting === true ? { mode: "checkout" as const } : {}),
          ...(signal === undefined ? {} : { signal }),
        },
        prepared.record.baseCommit,
      );
      const conversation = await this.#commitWorktreeConversation(
        targetPath,
        request.executionMode,
        project,
        workspace.operationId,
      );
      return { kind: "conversation", conversation };
    } catch (error) {
      this.options.worktreeOperations.markNeedsInspection(workspace.operationId);
      // 用户取消（关闭页面、刷新、超时）统一落到 needs_inspection，不自动重试。
      if (signal?.aborted === true) {
        return {
          kind: "needs_inspection",
          operationId: workspace.operationId,
          status: "needs_inspection",
          targetPath,
          branch: workspace.branch,
          reason: "创建请求已取消，请检查目标目录与分支。",
        };
      }
      if (error instanceof OpenConversationError) throw error;
      return {
        kind: "needs_inspection",
        operationId: workspace.operationId,
        status: "needs_inspection",
        targetPath,
        branch: workspace.branch,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 已登记操作的重试。只有 `prepared`（上次请求在启动 Git 之前中断）才重新执行
   * 创建并沿用已固定的 commit；`started` 可能已有 Git 在跑，交给它继续，
   * 其余状态直接报告。
   */
  async #retryOrResumeOperation(
    operation: WorktreeOperationRecord,
    identity: GitProjectIdentity,
    project: ResolvedProject,
    request: OpenConversationRequest,
    workspace: Extract<OpenWorkspaceRequest, { kind: "new_worktree" }>,
    signal: AbortSignal | undefined,
  ): Promise<OpenConversationResult> {
    if (operation.status !== "prepared") {
      return this.#resumeOperation(operation, project, request, workspace);
    }
    // 参数冲突先按已登记参数判定，避免用新参数复用旧操作。
    assertSameOperation(operation, project, request, workspace);
    if (!this.options.worktreeOperations.markStarted(operation.id)) {
      const current = this.options.worktreeOperations.read(operation.id);
      if (current !== undefined) {
        return this.#resumeOperation(current, project, request, workspace);
      }
    }
    try {
      // prepared 表示 Git 从未启动：分支已存在说明这是「检出已有分支」操作
      //（创建新分支模式在 prepare 阶段已拒绝同名分支）；据此恢复模式，操作
      // 日志不需要额外的模式列。
      const checkout = operation.baseRemote === null &&
        operation.baseBranch === operation.branch &&
        await this.options.git.branchExists(
          identity.mainWorkspace,
          operation.branch,
          signal,
        );
      const base = checkout
        ? { kind: "local" as const, branch: operation.branch }
        : storedWorktreeBase(operation);
      await this.options.worktreeCreator.prepare(
        {
          project: identity,
          base,
          branch: operation.branch,
          targetPath: operation.targetPath,
          ...(checkout ? { mode: "checkout" as const } : {}),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      await this.options.worktreeCreator.create(
        {
          project: identity,
          base,
          branch: operation.branch,
          targetPath: operation.targetPath,
          ...(checkout ? { mode: "checkout" as const } : {}),
          ...(signal === undefined ? {} : { signal }),
        },
        operation.baseCommit,
      );
      const conversation = await this.#commitWorktreeConversation(
        operation.targetPath,
        request.executionMode,
        project,
        operation.id,
      );
      return { kind: "conversation", conversation };
    } catch (error) {
      this.options.worktreeOperations.markNeedsInspection(operation.id);
      if (signal?.aborted === true) {
        return {
          kind: "needs_inspection",
          operationId: operation.id,
          status: "needs_inspection",
          targetPath: operation.targetPath,
          branch: operation.branch,
          reason: "创建请求已取消，请检查目标目录与分支。",
        };
      }
      return {
        kind: "needs_inspection",
        operationId: operation.id,
        status: "needs_inspection",
        targetPath: operation.targetPath,
        branch: operation.branch,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 已登记操作：完成则返回会话，进行中或需检查则报告当前状态。 */
  async #resumeOperation(
    operation: WorktreeOperationRecord,
    project: ResolvedProject,
    request: OpenConversationRequest,
    workspace: Extract<OpenWorkspaceRequest, { kind: "new_worktree" }>,
  ): Promise<OpenConversationResult> {
    assertSameOperation(operation, project, request, workspace);
    if (operation.status === "completed" && operation.conversationId !== null) {
      try {
        const conversation = await this.options.conversationService
          .getConversation(operation.conversationId);
        return { kind: "conversation", conversation };
      } catch {
        // 会话已删除：日志保留，不重新执行 Git。
      }
    }
    if (operation.status === "prepared" || operation.status === "started") {
      return {
        kind: "in_progress",
        operationId: operation.id,
        status: operation.status,
        targetPath: operation.targetPath,
      };
    }
    return {
      kind: "needs_inspection",
      operationId: operation.id,
      status: operation.status,
      targetPath: operation.targetPath,
      branch: operation.branch,
      reason: "上一次创建没有完成，请检查目标目录与分支。",
    };
  }

  async #inspectWorktree(
    operation: WorktreeOperationRecord,
  ): Promise<WorktreeOperationInspection> {
    const directoryExists = await realpath(operation.targetPath)
      .then(() => true)
      .catch(() => false);
    try {
      const entries = await this.options.git.listWorktrees(operation.projectRoot);
      const registered = entries.find(
        (entry) => entry.path === operation.targetPath,
      );
      return {
        directoryExists,
        registered: registered !== undefined,
        registeredBranch: registered?.branch ?? null,
      };
    } catch {
      return { directoryExists, registered: false, registeredBranch: null };
    }
  }

  async #createConversation(
    canonicalPath: string,
    executionMode: ExecutionMode,
    project: ResolvedProject,
    workspaceKind?: StoredWorkspaceKind,
  ): Promise<ConversationView> {
    await this.#requireRuntime(canonicalPath, executionMode);
    return this.options.conversationStore.createConversation(
      canonicalPath,
      executionMode,
      projectAssignment(project),
      workspaceKind,
    );
  }

  async #commitWorktreeConversation(
    targetPath: string,
    executionMode: ExecutionMode,
    project: ResolvedProject,
    operationId: string,
  ): Promise<ConversationView> {
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(targetPath);
    } catch {
      throw new OpenConversationError(
        "WORKTREE_CREATE_FAILED",
        `新建的 worktree 目录不可访问：${targetPath}`,
      );
    }
    await this.#requireRuntime(canonicalPath, executionMode);
    // 新建 worktree 一定属于用户确认的 Git 项目，key 不会为空。
    return this.options.conversationStore.createWorktreeConversation({
      canonicalWorkspaceRoot: canonicalPath,
      executionMode,
      project: { projectKey: project.key, projectRoot: project.root },
      workspaceKind: "worktree",
      worktreeOperationId: operationId,
    });
  }

  async #requireRuntime(
    canonicalPath: string,
    executionMode: ExecutionMode,
  ): Promise<void> {
    try {
      const runtime = await this.options.workspaceRuntimeProvider.get(
        canonicalPath,
        executionMode,
      );
      if (
        runtime.workspaceRoot !== canonicalPath ||
        runtime.executionMode !== executionMode
      ) {
        throw new Error("Workspace runtime does not match the request.");
      }
    } catch {
      throw new OpenConversationError(
        "WORKSPACE_RUNTIME_UNAVAILABLE",
        "所选工作目录的运行环境初始化失败。",
        503,
        true,
      );
    }
  }

  async #verifyGitProject(
    project: ResolvedProject,
    signal?: AbortSignal,
  ): Promise<GitProjectIdentity> {
    try {
      return await this.options.git.verifyProject(
        project.key,
        project.root,
        signal,
      );
    } catch (error) {
      throw projectFailure(error);
    }
  }

  /** 尚未识别的归属：只允许普通目录类工作目录，Git 操作一律拒绝。 */
  #unidentifiedProject(
    selectedPath: string,
    request: OpenConversationRequest,
    checkout: GitCheckoutState | null = null,
  ): ResolvedProject {
    if (
      request.workspace.kind !== "directory" &&
      request.workspace.kind !== "selected_directory"
    ) {
      throw new OpenConversationError(
        "PROJECT_UNAVAILABLE",
        "Git 信息暂时不可用，请稍后重试或直接使用所选目录。",
        409,
        true,
      );
    }
    return {
      key: "",
      root: selectedPath,
      checkout,
      selectedPath,
    };
  }

  /** 主工作目录按当前 Git 登记重新读取，忽略客户端传入的路径。 */
  async #registeredMainWorkspace(
    project: ResolvedProject,
    signal?: AbortSignal,
  ): Promise<string> {
    const identity = await this.#verifyGitProject(project, signal);
    return identity.mainWorkspace;
  }

  /** 已有 worktree 必须与当前 Git 登记精确匹配。 */
  async #registeredWorktreePath(
    project: ResolvedProject,
    requestedPath: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const identity = await this.#verifyGitProject(project, signal);
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(requestedPath);
    } catch {
      throw new OpenConversationError(
        "WORKSPACE_UNAVAILABLE",
        "所选目录不可访问。",
        409,
        true,
      );
    }
    const registered = identity.worktrees.find(
      (entry) => entry.path === canonicalPath && !entry.bare,
    );
    if (registered === undefined) {
      throw new OpenConversationError(
        "WORKSPACE_UNAVAILABLE",
        "所选目录不在该项目的 Git 登记中。",
        409,
        true,
      );
    }
    return canonicalPath;
  }

  /** 使用令牌绑定的精确路径，并重新确认它仍在项目内。 */
  async #validatedSelectedDirectory(
    project: ResolvedProject,
    signal?: AbortSignal,
  ): Promise<string> {
    const selectedPath = project.checkout?.selectedPath;
    if (selectedPath === undefined) {
      throw new OpenConversationError(
        "PROJECT_SELECTION_INVALID",
        "需要重新选择目录。",
        409,
      );
    }
    const identity = await this.options.projectInspection
      .inspectSelectedDirectory(selectedPath, signal)
      .catch((error: unknown) => {
        throw projectFailure(error);
      });
    if (identity.assignment?.projectKey !== project.key) {
      throw new OpenConversationError(
        "PROJECT_SELECTION_INVALID",
        "所选目录的项目归属已变化，请重新选择。",
        409,
      );
    }
    return identity.selectedPath;
  }

  /**
   * 解析本次请求操作的项目。已登记项目按持久化归属重新验证；首次选择的
   * 目录由令牌绑定，不接受客户端任意路径。
   */
  async #resolveProject(
    request: OpenConversationRequest,
    signal?: AbortSignal,
  ): Promise<ResolvedProject> {
    if (request.selectionToken !== undefined) {
      if (request.projectKey !== undefined) {
        throw new OpenConversationError(
          "PROJECT_SELECTION_INVALID",
          "项目 key 与选择令牌只能二选一。",
          400,
        );
      }
      const selection = this.options.selectionTokens.get(request.selectionToken);
      if (selection === undefined) {
        throw new OpenConversationError(
          "PROJECT_SELECTION_INVALID",
          "目录选择已过期，请重新选择目录。",
          409,
        );
      }
      const identity = await this.options.projectInspection
        .inspectSelectedDirectory(selection.selectedPath, signal)
        .catch((error: unknown) => {
          throw projectFailure(error);
        });
      if (identity.assignment !== null) {
        // 签令牌时确认是 Git 项目、现在只读到普通目录：Git 暂时没读到，
        // 不能把项目改判成 dir:，按未识别归属继续。
        if (selection.checkout !== null && identity.checkout === null) {
          return this.#unidentifiedProject(identity.selectedPath, request, selection.checkout);
        }
        return {
          key: identity.assignment.projectKey,
          root: identity.assignment.projectRoot,
          checkout: identity.checkout,
          selectedPath: identity.selectedPath,
        };
      }
      // Git 暂时无法判断：按令牌绑定的精确目录创建「未识别」归属的会话，
      // 目录可访问即可创建，Git 恢复后由读取时的识别补写归属。
      return this.#unidentifiedProject(identity.selectedPath, request, selection.checkout);
    }
    if (request.projectKey === undefined) {
      throw new OpenConversationError(
        "PROJECT_SELECTION_REQUIRED",
        "需要选择项目或重新选择目录。",
        400,
      );
    }
    if (request.workspace.kind === "selected_directory") {
      throw new OpenConversationError(
        "PROJECT_SELECTION_REQUIRED",
        "使用选中的子目录创建会话时需要重新选择目录。",
        400,
      );
    }
    const project = await this.#lookupRegisteredProject(request.projectKey);
    return {
      key: project.key,
      root: project.root,
      checkout: null,
      selectedPath: null,
    };
  }

  /**
   * 按项目 key 查找服务端记录过的项目锚点。只读，供项目分支与 worktree 列表
   * 使用；未登记时返回 undefined。
   */
  async findRegisteredProject(
    projectKey: ProjectKey,
  ): Promise<{ readonly key: string; readonly root: string } | undefined> {
    return this.#scanRegisteredProject(projectKey);
  }

  /**
   * 读取项目的分支与 worktree 列表。首次通过选择令牌进入的项目用令牌解析
   * （与创建请求同一份授权），已登记项目按持久化锚点解析。dir: 项目不属于
   * Git，返回 null 由调用方展示空状态。
   */
  async describeProject(
    target: ProjectQueryTarget,
    signal?: AbortSignal,
  ): Promise<ProjectDescription | null> {
    const project = await this.#resolveQueryProject(target, signal);
    if (project === null) return null;
    const identity = await this.#verifyGitProject(
      { key: project.key, root: project.root, checkout: null, selectedPath: null },
      signal,
    );
    const branches = await this.options.git.listBranches(
      identity.mainWorkspace,
      signal,
    );
    const worktrees = await Promise.all(
      identity.worktrees.map(async (entry) => ({
        path: entry.path,
        branch: entry.branch,
        commit: entry.commit,
        kind: entry.path === identity.mainWorkspace
          ? ("main" as const)
          : ("worktree" as const),
        available: await isDirectory(entry.path),
      })),
    );
    return {
      projectKey: identity.key,
      mainWorkspace: identity.mainWorkspace,
      branches,
      worktrees,
    };
  }

  /** 令牌是本次选择的授权，可以代表一个尚未登记过的项目；key 只能查已登记的。 */
  async #resolveQueryProject(
    target: ProjectQueryTarget,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly key: string; readonly root: string } | null> {
    if (target.selectionToken !== null) {
      const selection = this.options.selectionTokens.get(target.selectionToken);
      if (selection === undefined) {
        throw new OpenConversationError(
          "PROJECT_SELECTION_INVALID",
          "目录选择已过期，请重新选择目录。",
          409,
        );
      }
      const identity = await this.options.projectInspection
        .inspectSelectedDirectory(selection.selectedPath, signal)
        .catch((error: unknown) => {
          throw projectFailure(error);
        });
      // 签令牌时是 Git 项目、现在只读到普通目录：Git 暂时没读到，按「无 Git
      // 信息」处理，不把项目改判成 dir:。
      if (selection.checkout !== null && identity.checkout === null) return null;
      if (identity.assignment === null) {
        throw new OpenConversationError(
          "PROJECT_UNAVAILABLE",
          identity.failureReason ?? "Git 信息暂时不可用。",
          409,
          true,
        );
      }
      if (identity.assignment.projectKey.startsWith("dir:")) return null;
      return {
        key: identity.assignment.projectKey,
        root: identity.assignment.projectRoot,
      };
    }
    if (target.projectKey !== null && target.projectKey.startsWith("dir:")) {
      return null;
    }
    const projectKey = target.projectKey as ProjectKey;
    const project = await this.#scanRegisteredProject(projectKey);
    if (project === undefined) {
      throw new OpenConversationError("PROJECT_NOT_FOUND", "项目未登记。", 404);
    }
    return project;
  }

  /**
   * 从已持久化的会话项目归属里找回最近一次记录的项目锚点。项目锚点只来自
   * 服务端写过的 `project_root`，客户端无法自造路径。
   */
  async #lookupRegisteredProject(
    projectKey: ProjectKey,
  ): Promise<{ readonly key: string; readonly root: string }> {
    const project = await this.#scanRegisteredProject(projectKey);
    if (project === undefined) {
      throw new OpenConversationError(
        "PROJECT_NOT_FOUND",
        "未找到该项目的会话记录，请在目录选择器中重新选择项目目录。",
        409,
      );
    }
    return project;
  }

  async #scanRegisteredProject(
    projectKey: ProjectKey,
  ): Promise<{ readonly key: string; readonly root: string } | undefined> {
    const project = this.options.conversationStore.findConversationProject(projectKey);
    return project === undefined ? undefined : { key: project.projectKey, root: project.projectRoot };
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 空 key 表示尚未识别的归属：写入 NULL，读取时再识别补写。 */
function projectAssignment(
  project: ResolvedProject,
): ConversationProjectAssignment | undefined {
  if (project.key === "") return undefined;
  return { projectKey: project.key, projectRoot: project.root };
}

/** 同一 operationId 只对应对一组创建参数；参数不同返回冲突。 */
function assertSameOperation(
  operation: WorktreeOperationRecord,
  project: ResolvedProject,
  request: OpenConversationRequest,
  workspace: Extract<OpenWorkspaceRequest, { kind: "new_worktree" }>,
): void {
  if (
    operation.projectKey !== project.key ||
    operation.projectRoot !== project.root ||
    operation.branch !== workspace.branch ||
    operation.baseBranch !== storedBaseBranch(workspace) ||
    operation.executionMode !== request.executionMode
  ) {
    throw new OpenConversationError(
      "WORKTREE_OPERATION_CONFLICT",
      "操作 ID 已用于另一组创建参数。",
      409,
    );
  }
}

function projectFailure(error: unknown): OpenConversationError {
  if (error instanceof OpenConversationError) return error;
  if (error instanceof GitRepositoryError) {
    return new OpenConversationError(
      "PROJECT_UNAVAILABLE",
      error.message,
      409,
      error.reason === "unavailable",
    );
  }
  if (error instanceof ProjectDirectoryUnavailableError) {
    return new OpenConversationError("PROJECT_UNAVAILABLE", error.message, 409);
  }
  return new OpenConversationError(
    "PROJECT_UNAVAILABLE",
    error instanceof Error ? error.message : "项目不可用。",
    409,
  );
}

/**
 * 起点存储格式：`worktree_operations.base_branch` 始终存本地分支名，或远端分支的
 * `<remote>/<branch>`。远端名本身可能含 `/`，因此远端起点额外存远端名，读取时
 * 按 `base_remote` 切分，不靠猜前缀。
 */
function worktreeBase(
  baseBranch: string,
  baseRefKind: "local" | "remote",
  baseRemote: string | undefined,
): WorktreeBase {
  if (baseRefKind === "remote") {
    if (baseRemote === undefined || baseRemote === "") {
      throw new OpenConversationError(
        "WORKTREE_BRANCH_INVALID",
        "远端起点缺少远端名。",
        400,
      );
    }
    return { kind: "remote", remote: baseRemote, branch: baseBranch };
  }
  return { kind: "local", branch: baseBranch };
}

/**
 * 创建请求使用的起点。检出已有分支时起点就是该分支本身，与客户端传入的
 * `baseBranch` 无关；创建新分支时按请求的本地/远端起点解析。
 */
function creatorBase(
  workspace: Extract<OpenWorkspaceRequest, { kind: "new_worktree" }>,
): WorktreeBase {
  if (workspace.checkoutExisting === true) {
    return { kind: "local", branch: workspace.branch };
  }
  return worktreeBase(
    workspace.baseBranch,
    workspace.baseRefKind,
    workspace.baseRemote,
  );
}

/** 起点在操作日志里的存储值。 */
function storedBaseBranch(
  workspace: Extract<OpenWorkspaceRequest, { kind: "new_worktree" }>,
): string {
  if (workspace.checkoutExisting === true) return workspace.branch;
  if (workspace.baseRefKind === "remote") {
    return `${workspace.baseRemote}/${workspace.baseBranch}`;
  }
  return workspace.baseBranch;
}

/**
 * 远端起点在操作日志里记录远端名；本地起点（含检出已有分支模式）记录 null。
 */
function storedBaseRemote(
  workspace: Extract<OpenWorkspaceRequest, { kind: "new_worktree" }>,
): string | null {
  if (workspace.checkoutExisting === true) return null;
  if (workspace.baseRefKind === "remote") return workspace.baseRemote ?? null;
  return null;
}

/** 已登记操作里的起点。旧记录的 `base_remote` 为 NULL，按本地起点处理。 */
function storedWorktreeBase(
  operation: WorktreeOperationRecord,
): WorktreeBase {
  if (operation.baseRemote === null) {
    return { kind: "local", branch: operation.baseBranch };
  }
  return worktreeBase(operation.baseBranch, "remote", operation.baseRemote);
}

function mapWorktreeFailure(error: unknown): OpenConversationError {
  if (error instanceof OpenConversationError) return error;
  if (error instanceof WorktreeCreationError) {
    if (error.stage === "validation") {
      return new OpenConversationError(
        "WORKTREE_BRANCH_INVALID",
        error.message,
        409,
      );
    }
    if (error.stage === "fetch") {
      return new OpenConversationError("WORKTREE_FETCH_FAILED", error.message, 409);
    }
    if (error.stage === "target") {
      return new OpenConversationError(
        "WORKTREE_TARGET_EXISTS",
        error.message,
        409,
      );
    }
    return new OpenConversationError("WORKTREE_CREATE_FAILED", error.message, 500);
  }
  return new OpenConversationError(
    "WORKTREE_CREATE_FAILED",
    error instanceof Error ? error.message : "新建 worktree 失败。",
    500,
  );
}
