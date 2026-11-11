import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  GitProcessError,
  type GitCommandResult,
  type GitRunner,
} from "../infrastructure/git-process-runner.js";

/** 服务端管理的 worktree 根目录：`~/.westie/worktrees/<项目标识>/<operationId>`。 */
export const WORKTREE_ROOT_DIRECTORY = join(homedir(), ".westie", "worktrees");

/** Git 登记的一个工作目录，来自 `git worktree list --porcelain -z`。 */
export interface GitWorktreeEntry {
  /** Git 输出的原始路径，未做 realpath。 */
  readonly path: string;
  /** 该 checkout 检出的分支短名；detached HEAD 时为 null。 */
  readonly branch: string | null;
  readonly commit: string;
  readonly bare: boolean;
  readonly detached: boolean;
}

/** 项目身份与锚点；`key` 是 `git:<canonical common dir>`。 */
export interface GitProjectIdentity {
  readonly key: string;
  readonly commonDir: string;
  readonly mainWorkspace: string;
  readonly worktrees: readonly GitWorktreeEntry[];
}

export interface GitBranch {
  readonly name: string;
}

/**
 * 一个可用的远端分支；仓库有多个 remote 时用 `remote` 区分。`name` 是去掉远端
 * 前缀的分支名（`origin/feat/x` → `feat/x`），与本地分支同名可直接比较。
 */
export interface GitRemoteBranch {
  readonly remote: string;
  readonly name: string;
  /** 本机已存在同名本地分支：该远端分支被本地分支占用，不能作为新分支起点。 */
  readonly hasLocalBranch: boolean;
}

export interface GitBranchRecommendation {
  readonly branches: readonly string[];
  /** 仓库已配置的 remote 名（`git remote`），与是否已有远端分支 ref 无关。 */
  readonly remotes: readonly string[];
  /** 可用的远端分支：只包含本机已有的远端分支 ref，不含 `<remote>/HEAD`。 */
  readonly remoteBranches: readonly GitRemoteBranch[];
  readonly recommendedBranch: string | null;
  readonly recommendationSource: string | null;
}

/** 已识别 checkout 的实时状态。 */
export interface GitCheckoutState {
  readonly project: GitProjectIdentity;
  readonly checkoutRoot: string;
  readonly branch: string | null;
  readonly commit: string;
  /** 用户在系统选择器里确认的那个目录；可能等于或位于 checkout 之内。 */
  readonly selectedPath: string;
}

export interface SelectedDirectoryIdentity {
  readonly selectedPath: string;
  readonly checkout: GitCheckoutState | null;
}

/**
 * 项目识别失败的业务错误。`unavailable` 表示 Git 不可用、超时或输出超限，
 * 属于「暂时无法判断」；`not_a_repository` 表示目录可访问但明确不在 Git
 * 仓库内，属于「确认普通目录」。两者都不能被当作另一种处理。
 */
export class GitRepositoryError extends Error {
  constructor(
    readonly reason: "unavailable" | "not_a_repository",
    message: string,
  ) {
    super(message);
    this.name = "GitRepositoryError";
  }
}

export class GitCommandFailedError extends Error {
  constructor(
    readonly detail: string,
    readonly stderr: string,
  ) {
    super(detail);
    this.name = "GitCommandFailedError";
  }
}

/**
 * 宿主的 Git 项目读取入口。所有命令经 `GitRunner` 以 argv 方式启动，不经过
 * shell；只读取本地信息，不 fetch、不改动任何引用。
 */
export class GitProjectService {
  constructor(
    private readonly runner: GitRunner,
    private readonly worktreeRoot: string = WORKTREE_ROOT_DIRECTORY,
  ) {}

  /** 读取目录所属 checkout 与项目；目录不在 Git 仓库内时抛 `GitRepositoryError`。 */
  async inspectDirectory(
    directory: string,
    signal?: AbortSignal,
  ): Promise<GitCheckoutState> {
    let canonicalDirectory: string;
    try {
      canonicalDirectory = await realpath(directory);
      const stats = await stat(canonicalDirectory);
      if (!stats.isDirectory()) {
        throw new Error("Selected path is not a directory.");
      }
    } catch (error) {
      throw new GitRepositoryError(
        "unavailable",
        error instanceof Error ? error.message : "Selected path is unavailable.",
      );
    }

    const toplevel = await this.#query(
      canonicalDirectory,
      ["rev-parse", "--show-toplevel"],
      signal,
      (error) => {
        throw new GitRepositoryError("unavailable", error.message);
      },
    );
    if (toplevel === null) {
      throw new GitRepositoryError(
        "not_a_repository",
        "The directory is not inside a Git repository.",
      );
    }
    const checkoutRoot = await this.#canonical(toplevel);
    const project = await this.readProject(checkoutRoot, signal);
    if (project.worktrees.some((entry) => entry.bare)) {
      throw new GitRepositoryError(
        "unavailable",
        "Bare repositories cannot host a worktree session.",
      );
    }
    const branchResult = await this.#query(
      checkoutRoot,
      ["rev-parse", "--abbrev-ref", "HEAD"],
      signal,
      (error) => {
        throw new GitRepositoryError("unavailable", error.message);
      },
    );
    const commit = await this.#query(
      checkoutRoot,
      ["rev-parse", "--verify", "HEAD"],
      signal,
      (error) => {
        throw new GitRepositoryError("unavailable", error.message);
      },
    );
    const branch = branchResult === null || branchResult === "HEAD"
      ? null
      : branchResult;
    if (commit === null) {
      throw new GitRepositoryError(
        "unavailable",
        "The checkout has no reachable commit.",
      );
    }
    return {
      project,
      checkoutRoot,
      branch,
      commit,
      selectedPath: canonicalDirectory,
    };
  }

  /**
   * 读取已有 checkout 的完整识别结果，包含选择器里选中的精确路径。
   * 普通目录返回 `checkout: null`；Git 暂时不可用时抛错，由调用方显示原因。
   */
  async identifySelection(
    selectedPath: string,
    signal?: AbortSignal,
  ): Promise<SelectedDirectoryIdentity> {
    let canonicalSelection: string;
    try {
      canonicalSelection = await realpath(selectedPath);
    } catch {
      throw new GitRepositoryError(
        "unavailable",
        "Selected directory is unavailable.",
      );
    }
    try {
      const checkout = await this.inspectDirectory(canonicalSelection, signal);
      return { selectedPath: canonicalSelection, checkout };
    } catch (error) {
      if (
        error instanceof GitRepositoryError &&
        error.reason === "not_a_repository"
      ) {
        return { selectedPath: canonicalSelection, checkout: null };
      }
      throw error;
    }
  }

  /**
   * 按已持久化的项目身份重新验证：common dir 必须仍等于项目锚点，
   * 否则拒绝在该项目上执行任何宿主操作。
   */
  async verifyProject(
    projectKey: string,
    projectRoot: string,
    signal?: AbortSignal,
  ): Promise<GitProjectIdentity> {
    // 项目锚点必须可访问；目录不可访问时不能继续按「不在仓库内」处理。
    try {
      const stats = await stat(projectRoot);
      if (!stats.isDirectory()) {
        throw new GitRepositoryError(
          "unavailable",
          "The project directory is unavailable.",
        );
      }
    } catch (error) {
      if (error instanceof GitRepositoryError) throw error;
      throw new GitRepositoryError(
        "unavailable",
        "The project directory is unavailable.",
      );
    }
    const project = await this.readProject(projectRoot, signal);
    if (project.key !== projectKey) {
      throw new GitRepositoryError(
        "unavailable",
        "The project directory no longer matches its stored identity.",
      );
    }
    return project;
  }

  /** 读取项目身份：主工作目录取 `worktree list` 中第一个非 bare 项。 */
  async readProject(
    checkoutPath: string,
    signal?: AbortSignal,
  ): Promise<GitProjectIdentity> {
    const commonDirResult = await this.#query(
      checkoutPath,
      ["rev-parse", "--git-common-dir"],
      signal,
      // 进程本身失败（不可用、超时、输出超限）属于「暂时无法判断」，
      // 不能当成「确认不在仓库内」，否则项目归属会被永久写成普通目录。
      (error) => {
        throw new GitRepositoryError("unavailable", error.message);
      },
    );
    if (commonDirResult === null) {
      throw new GitRepositoryError(
        "not_a_repository",
        "The directory is not inside a Git repository.",
      );
    }
    const commonDir = await this.#canonical(
      checkoutPath,
      commonDirResult,
    );
    const worktrees = await this.listWorktrees(checkoutPath, signal);
    const mainWorkspace = worktrees.find((entry) => !entry.bare)?.path;
    if (mainWorkspace === undefined) {
      throw new GitRepositoryError(
        "unavailable",
        "The repository has no main working tree.",
      );
    }
    return {
      key: `git:${commonDir}`,
      commonDir,
      mainWorkspace,
      worktrees,
    };
  }

  /** `git worktree list --porcelain -z`，按 NUL 分隔解析，路径不做拆分。 */
  async listWorktrees(
    checkoutPath: string,
    signal?: AbortSignal,
  ): Promise<readonly GitWorktreeEntry[]> {
    let result: GitCommandResult;
    try {
      result = await this.runner.run({
        cwd: checkoutPath,
        args: ["worktree", "list", "--porcelain", "-z"],
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      // 进程失败（超时、输出超限、被杀）只影响这一条读取，转成「暂时不可用」，
      // 由调用方把这一个会话降级为未知状态，不阻断整页列表。
      throw new GitRepositoryError(
        "unavailable",
        error instanceof Error ? error.message : "Could not list Git worktrees.",
      );
    }
    if (result.exitCode !== 0) {
      throw new GitRepositoryError(
        "unavailable",
        `Could not list Git worktrees: ${result.stderr.trim()}`,
      );
    }
    return parseWorktreePorcelain(result.stdout);
  }

  /**
   * 本地分支、已配置的 remote、远端分支与推荐起始分支。推荐只依据本地保存的
   * 远端 HEAD：恰有一个本地分支的 upstream 指向它时才推荐，否则返回 null。
   *
   * 这里只读取本机已有的 ref，不访问远端。`remotes` 来自 `git remote`，即使该
   * remote 还没有任何远端分支 ref 也会列出；远端分支来自
   * `refs/remotes/<remote>/<branch>`，跳过 `<remote>/HEAD` 符号引用。
   */
  async listBranches(
    projectRoot: string,
    signal?: AbortSignal,
  ): Promise<GitBranchRecommendation> {
    const refs = await this.#query(
      projectRoot,
      [
        "for-each-ref",
        // 字段用 tab 分隔：`%(upstreamsymref)` 未设置时也输出，行内容保持稳定。
        "--format=%(refname)%09%(upstream)%09%(symref)",
        "refs/heads",
        "refs/remotes",
      ],
      signal,
    );
    const branches: string[] = [];
    const remoteRefs: string[] = [];
    const upstreams = new Map<string, string>();
    const remoteHeads = new Map<string, string>();
    for (const line of (refs ?? "").split("\n")) {
      if (line === "") continue;
      const [ref, upstream, symref] = line.split("\t");
      if (ref === undefined) continue;
      if (ref.startsWith("refs/heads/")) {
        const name = ref.slice("refs/heads/".length);
        branches.push(name);
        if (upstream !== undefined && upstream !== "") {
          upstreams.set(name, upstream);
        }
      } else if (ref.startsWith("refs/remotes/")) {
        remoteRefs.push(ref.slice("refs/remotes/".length));
        if (ref.endsWith("/HEAD")) {
          // `symref` 是远端 HEAD 指向的分支（`refs/remotes/origin/main`），
          // 该符号引用缺失时留空，不猜测默认分支。
          const remote = ref.slice("refs/remotes/".length, -"/HEAD".length);
          if (symref !== undefined && symref !== "") {
            remoteHeads.set(remote, symref);
          }
        }
      }
    }
    branches.sort();

    const remotesResult = await this.#query(
      projectRoot,
      ["remote"],
      signal,
    );
    const remotes = (remotesResult ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const remote = remotes.includes("origin")
      ? "origin"
      : remotes.length === 1
        ? remotes[0]
        : undefined;
    const remoteBranches = groupRemoteBranches(remoteRefs, remotes, new Set(branches));
    const defaultRef = remote === undefined ? undefined : remoteHeads.get(remote);
    if (remote === undefined || defaultRef === undefined) {
      return {
        branches,
        remotes,
        remoteBranches,
        recommendedBranch: null,
        recommendationSource: null,
      };
    }

    const matching = branches.filter(
      (branch) => upstreams.get(branch) === defaultRef,
    );
    return {
      branches,
      remotes,
      remoteBranches,
      recommendedBranch: matching.length === 1 ? matching[0] : null,
      recommendationSource: matching.length === 1
        ? `${remote}/HEAD`
        : null,
    };
  }

  /** 解析本地分支当前 commit；分支不存在时抛错。 */
  async resolveBranchCommit(
    projectRoot: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const commit = await this.#query(
      projectRoot,
      ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
      signal,
    );
    if (commit === null) {
      throw new GitCommandFailedError(
        `The local branch ${branch} does not exist.`,
        "",
      );
    }
    return commit;
  }

  /**
   * 解析本机已有远端分支 ref 的 commit；`refs/remotes/<remote>/<branch>` 不存在
   * （例如从未 fetch 过该分支）时返回 null。
   */
  async resolveRemoteBranchCommit(
    projectRoot: string,
    remote: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    return await this.#query(
      projectRoot,
      ["rev-parse", "--verify", `refs/remotes/${remote}/${branch}^{commit}`],
      signal,
    );
  }

  async branchExists(
    projectRoot: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const found = await this.#query(
      projectRoot,
      ["rev-parse", "--verify", `refs/heads/${branch}`],
      signal,
    );
    return found !== null;
  }

  /** `git check-ref-format --branch`；非法分支名返回 false。 */
  async isValidBranchName(
    projectRoot: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const result = await this.runner.run({
        cwd: projectRoot,
        args: ["check-ref-format", "--branch", branch],
        ...(signal === undefined ? {} : { signal }),
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /** 目标路径：`<worktree root>/<项目标识哈希>/<operationId>`。 */
  targetPathFor(projectKey: string, operationId: string): string {
    return join(this.worktreeRoot, projectDirectoryName(projectKey), operationId);
  }

  get worktreeRootDirectory(): string {
    return this.worktreeRoot;
  }

  /** 读取用查询：失败或非零退出码统一返回 null，由调用方按「未知」处理。 */
  async #query(
    cwd: string,
    args: readonly string[],
    signal: AbortSignal | undefined,
    onProcessError?: (error: GitProcessError) => never,
  ): Promise<string | null> {
    try {
      const result = await this.runner.run({
        cwd,
        args,
        ...(signal === undefined ? {} : { signal }),
      });
      if (result.exitCode !== 0) return null;
      return result.stdout.replace(/\n$/, "");
    } catch (error) {
      if (signal?.aborted === true) throw error;
      // Git 进程本身失败（不可用、超时、输出超限）时，调用方可以区分
      // 「暂时无法判断」与「确认不在仓库内」。
      if (error instanceof GitProcessError && onProcessError !== undefined) {
        onProcessError(error);
      }
      return null;
    }
  }

  /** Git 输出的相对路径（如 `.git`）按 checkout 根目录解析并取 realpath。 */
  async #canonical(base: string, relative?: string): Promise<string> {
    const target = relative === undefined ? base : resolve(base, relative);
    try {
      return await realpath(target);
    } catch {
      return target;
    }
  }
}

/**
 * 把 `refs/remotes` 的短名分组成远端分支。
 *
 * 短名形如 `<remote>/<branch>`；远端名本身可能含 `/`，按已知 remote 名做最长
 * 匹配切分。`<remote>/HEAD` 是符号引用，不作为可选分支返回。`branches` 是本地
 * 分支名集合，用于标记同名远端分支。
 */
export function groupRemoteBranches(
  remoteRefs: readonly string[],
  remotes: readonly string[],
  localBranches: ReadonlySet<string>,
): readonly GitRemoteBranch[] {
  const sortedRemotes = [...remotes].sort((left, right) => right.length - left.length);
  const result: GitRemoteBranch[] = [];
  for (const ref of remoteRefs) {
    if (ref.endsWith("/HEAD")) continue;
    const remote = sortedRemotes.find((candidate) =>
      ref.startsWith(`${candidate}/`)
    );
    if (remote === undefined) continue;
    const name = ref.slice(remote.length + 1);
    if (name === "") continue;
    result.push({ remote, name, hasLocalBranch: localBranches.has(name) });
  }
  return result.sort((left, right) => {
    if (left.remote !== right.remote) return left.remote < right.remote ? -1 : 1;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
}

/** 项目目录名取项目标识的哈希：长度固定且不含路径分隔符。 */
export function projectDirectoryName(projectKey: string): string {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(projectKey, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 解析 `git worktree list --porcelain -z` 输出。
 *
 * 每条记录是若干 `键 值` 行，字段之间用 NUL 分隔、记录之间用额外的 NUL 分隔；
 * 路径可能包含空格或换行，只按 NUL 切分字段，`worktree` 键标志着一条新记录。
 */
export function parseWorktreePorcelain(
  output: string,
): readonly GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: ParsedWorktreeRecord | undefined;

  const flush = (): void => {
    if (current?.path !== undefined) {
      entries.push({
        path: current.path,
        branch: current.branch ?? null,
        commit: current.head ?? "",
        bare: current.bare,
        detached: current.detached,
      });
    }
    current = undefined;
  };
  const record = (): ParsedWorktreeRecord => {
    current ??= { bare: false, detached: false };
    return current;
  };

  for (const token of output.split("\0")) {
    if (token === "") continue;
    // 兼容按记录换行的输出：每条记录的最后一行为空。
    for (const line of token.split("\n")) {
      if (line === "") continue;
      if (line === "bare") {
        record().bare = true;
        continue;
      }
      if (line === "detached") {
        record().detached = true;
        continue;
      }
      const separator = line.indexOf(" ");
      if (separator < 0) continue;
      const key = line.slice(0, separator);
      const value = line.slice(separator + 1);
      if (key === "worktree") {
        flush();
        record().path = value;
      } else if (key === "HEAD") {
        record().head = value;
      } else if (key === "branch" && value.startsWith("refs/heads/")) {
        record().branch = value.slice("refs/heads/".length);
      }
    }
  }
  flush();
  return entries;
}

interface ParsedWorktreeRecord {
  path?: string;
  head?: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
}
