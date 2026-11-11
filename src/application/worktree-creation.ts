/**
 * 新建 worktree 的宿主 Git 操作：校验起点、固定起点 commit、占用目标目录，
 * 再执行 `git worktree add`。校验失败时不做任何写入；Git 启动后的失败保留
 * 已产生的分支、目录或登记，由操作日志标记为需要检查。
 *
 * 起点可以是本地分支，也可以是远端分支。远端起点先执行 `git fetch`（由
 * `GitRemoteFetcher` 负责），再固定刷新后的 commit；fetch 失败时不占用目录、
 * 不登记操作。
 */
import { mkdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";

import type { GitRunner } from "../infrastructure/git-process-runner.js";
import {
  GIT_WORKTREE_TIMEOUT_MS,
  GitProcessError,
} from "../infrastructure/git-process-runner.js";
import { GitRemoteFetcher, RemoteFetchError } from "./git-remote-fetch.js";
import {
  GitCommandFailedError,
  type GitProjectIdentity,
  type GitProjectService,
} from "./git-project-service.js";

export type WorktreeCreateFailureStage =
  /** 起点分支不存在、分支名非法或已存在。 */
  | "validation"
  /** 远端分支拉取失败、超时或被取消；没有产生任何写入。 */
  | "fetch"
  /** 目标目录已存在或无法占用。 */
  | "target"
  /** Git 已启动但失败、取消或超时；可能留下部分结果。 */
  | "git";

export class WorktreeCreationError extends Error {
  constructor(
    readonly stage: WorktreeCreateFailureStage,
    message: string,
  ) {
    super(message);
    this.name = "WorktreeCreationError";
  }
}

/** worktree 的起点：本地分支，或某个远端上的分支。 */
export type WorktreeBase =
  | { readonly kind: "local"; readonly branch: string }
  | { readonly kind: "remote"; readonly remote: string; readonly branch: string };

export interface CreateWorktreeRequest {
  readonly project: GitProjectIdentity;
  readonly base: WorktreeBase;
  readonly branch: string;
  readonly targetPath: string;
  /**
   * `create`（默认）：从起点 commit 创建新分支（`worktree add -b`），要求分支
   * 本地不存在。`checkout`：直接检出已存在的本地分支（`worktree add <path>
   * <branch>`），要求分支本地存在且未被其他 worktree 检出；此时 `base` 必须
   * 指向该分支本身。
   */
  readonly mode?: "create" | "checkout";
  readonly signal?: AbortSignal;
}

export interface CreatedWorktree {
  readonly targetPath: string;
  readonly baseCommit: string;
}

export class WorktreeCreator {
  readonly #fetcher: GitRemoteFetcher;

  constructor(
    private readonly git: GitProjectService,
    private readonly runner: GitRunner,
  ) {
    this.#fetcher = new GitRemoteFetcher(git, runner);
  }

  /**
   * 创建前校验：目标目录不存在。
   *
   * `create` 模式校验起点存在、新分支名合法且未被占用；`checkout` 模式校验
   * 分支本地存在且未被任何 worktree 检出。返回创建时使用的起始 commit：本地
   * 起点的 commit 在固定后不再受分支移动影响，远端起点在 fetch 之后才固定。
   */
  async prepare(request: CreateWorktreeRequest): Promise<string> {
    const { project, base, branch, targetPath, mode = "create", signal } = request;
    const baseCommit = mode === "checkout"
      ? await this.#prepareCheckout(project, base, branch, signal)
      : await this.#prepareCreate(request);
    try {
      await mkdir(dirname(targetPath), { recursive: true });
    } catch (error) {
      throw new WorktreeCreationError(
        "target",
        `无法创建 worktree 目录：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    try {
      await realpath(targetPath);
      throw new WorktreeCreationError(
        "target",
        `目标目录 ${targetPath} 已存在。`,
      );
    } catch (error) {
      if (error instanceof WorktreeCreationError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw new WorktreeCreationError(
          "target",
          `无法确认目标目录状态：${String(code)}`,
        );
      }
    }
    return baseCommit;
  }

  /**
   * 创建新模式的校验：固定起点 commit，新分支名合法且本地不存在。远端起点
   * 在这里刷新远端分支，并用刷新后的 commit 作为方向。
   */
  async #prepareCreate(request: CreateWorktreeRequest): Promise<string> {
    const { project, base, branch, signal } = request;
    const baseCommit = await this.#resolveBase(project, base, signal);
    const validName = await this.git.isValidBranchName(
      project.mainWorkspace,
      branch,
      signal,
    );
    if (!validName) {
      throw new WorktreeCreationError("validation", "新分支名不合法。");
    }
    if (await this.git.branchExists(project.mainWorkspace, branch, signal)) {
      throw new WorktreeCreationError(
        "validation",
        `本地分支 ${branch} 已存在。`,
      );
    }
    return baseCommit;
  }

  /**
   * 检出已有分支模式的校验：分支必须本地存在，且没有在项目的任何 worktree
   * （含主工作目录）中被检出。Git 不允许同一分支被两个工作目录同时检出。
   */
  async #prepareCheckout(
    project: GitProjectIdentity,
    base: WorktreeBase,
    branch: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (base.kind !== "local" || base.branch !== branch) {
      // base 由服务层归一化，正常不会走到这里。
      throw new WorktreeCreationError(
        "validation",
        "检出已有分支时起点必须是该本地分支。",
      );
    }
    if (!(await this.git.branchExists(project.mainWorkspace, branch, signal))) {
      throw new WorktreeCreationError(
        "validation",
        `本地分支 ${branch} 不存在。`,
      );
    }
    const occupied = project.worktrees.find(
      (entry) => !entry.bare && entry.branch === branch,
    );
    if (occupied !== undefined) {
      throw new WorktreeCreationError(
        "validation",
        `分支 ${branch} 已在工作目录 ${occupied.path} 检出。`,
      );
    }
    return this.git.resolveBranchCommit(project.mainWorkspace, branch, signal);
  }

  /**
   * 执行 Git 创建。调用方先 `prepare()` 固定 commit、把操作标记为 `started`；
   * 取消或超时会终止 Git 进程并等待退出。
   *
   * `create` 模式执行 `git worktree add -b <branch> <path> <commit>`，起点是
   * 已固定的 commit；`checkout` 模式执行 `git worktree add <path> <branch>`，
   * 直接检出已存在的本地分支，不创建新分支。
   */
  async create(
    request: CreateWorktreeRequest,
    baseCommit: string,
  ): Promise<CreatedWorktree> {
    const args = request.mode === "checkout"
      ? ["worktree", "add", "--", request.targetPath, request.branch]
      : ["worktree", "add", "-b", request.branch, "--", request.targetPath, baseCommit];
    try {
      const result = await this.runner.run({
        cwd: request.project.mainWorkspace,
        args,
        timeoutMs: GIT_WORKTREE_TIMEOUT_MS,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (result.exitCode !== 0) {
        throw new WorktreeCreationError(
          "git",
          result.stderr.trim() || "git worktree add 失败。",
        );
      }
      return { targetPath: request.targetPath, baseCommit };
    } catch (error) {
      if (error instanceof WorktreeCreationError) throw error;
      if (error instanceof GitProcessError) {
        throw new WorktreeCreationError("git", error.message);
      }
      throw new WorktreeCreationError(
        "git",
        error instanceof Error ? error.message : "git worktree add 失败。",
      );
    }
  }

  /**
   * 解析起点并返回固定 commit。远端起点先 fetch：远端上的新分支需要先取回
   * ref 才能作为起点，拉取失败时给出与本地分支不同的原因。
   */
  async #resolveBase(
    project: GitProjectIdentity,
    base: WorktreeBase,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (base.kind === "local") {
      try {
        return await this.git.resolveBranchCommit(
          project.mainWorkspace,
          base.branch,
          signal,
        );
      } catch (error) {
        if (error instanceof GitCommandFailedError) {
          throw new WorktreeCreationError(
            "validation",
            `本地分支 ${base.branch} 不存在。`,
          );
        }
        throw error;
      }
    }
    try {
      return await this.#fetcher.fetchBranch({
        project,
        remote: base.remote,
        branch: base.branch,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw fetchFailure(base, error);
    }
  }
}

/** 远端拉取失败转成创建失败：既不占用目录，也不登记操作。 */
function fetchFailure(
  base: Extract<WorktreeBase, { kind: "remote" }>,
  error: unknown,
): unknown {
  if (!(error instanceof RemoteFetchError)) return error;
  if (error.reason === "cancelled") {
    return new WorktreeCreationError("fetch", "远端分支拉取已取消。");
  }
  if (error.reason === "timeout") {
    return new WorktreeCreationError(
      "fetch",
      `拉取 ${base.remote}/${base.branch} 超时，请检查网络后重试。`,
    );
  }
  return new WorktreeCreationError(
    "fetch",
    `无法从 ${base.remote} 拉取分支 ${base.branch}：${error.message}`,
  );
}
