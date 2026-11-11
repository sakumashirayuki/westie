/**
 * 工作目录状态探测：把文件系统可访问性、Git 分支与工作目录类型组合成
 * 会话列表与详情用的实时状态。结果不落库；共享目录在一次刷新内复用查询结果。
 */
import { stat } from "node:fs/promises";
import { sep } from "node:path";

import type {
  WorkspaceAvailabilityView,
  WorkspaceBranchView,
  WorkspaceKind,
} from "../domain/conversation.js";
import {
  GitRepositoryError,
  type GitProjectService,
} from "./git-project-service.js";

/** 单个目录的实时状态；checkout 信息用于判定工作目录类型。 */
export interface WorkspaceProbe {
  readonly availability: WorkspaceAvailabilityView;
  readonly branch: WorkspaceBranchView;
  /** 该目录所在 checkout 的根目录；非 Git 或不可读时为 null。 */
  readonly checkoutRoot: string | null;
  /** 目录在 Git 登记中的角色：主工作目录、已登记 worktree，或都不是。 */
  readonly checkoutKind: "main" | "worktree" | null;
  /** 服务端管理的 worktree 根目录下的目录。 */
  readonly insideManagedWorktreeRoot: boolean;
}

export interface WorkspaceProbeInput {
  readonly canonicalPath: string;
  /** 创建会话时由用户选择决定、读取历史会话时无法恢复的类型。 */
  readonly knownKind?: WorkspaceKind;
}

export interface WorkspaceProbeContext {
  /** 已持久化的项目身份，用于判断 common dir 是否仍一致。 */
  readonly projectKey: string | null;
}

export interface WorkspaceStatusSource {
  /** 为一次列表或详情读取创建缓存，绑定该会话已持久化的项目身份。 */
  createCache(projectKey: string | null): WorkspaceProbeCache;
  probe(
    input: WorkspaceProbeInput,
    context: WorkspaceProbeContext,
  ): Promise<WorkspaceProbe>;
}

/**
 * 按目录缓存探测结果。一次列表或详情读取内共享同一份缓存，读完后丢弃，
 * 不会把上次刷新的结果当作本次实时状态。
 */
export class WorkspaceProbeCache {
  readonly #entries = new Map<string, Promise<WorkspaceProbe>>();

  constructor(
    private readonly source: WorkspaceStatusSource,
    private readonly context: WorkspaceProbeContext,
  ) {}

  get(canonicalPath: string, knownKind?: WorkspaceKind): Promise<WorkspaceProbe> {
    const key = `${knownKind ?? ""}\0${canonicalPath}`;
    const cached = this.#entries.get(key);
    if (cached !== undefined) return cached;
    const created = this.source.probe(
      { canonicalPath, ...(knownKind === undefined ? {} : { knownKind }) },
      this.context,
    );
    this.#entries.set(key, created);
    return created;
  }
}

/** 由探测结果得出会话工作目录的类型。 */
export function deriveWorkspaceKind(
  input: WorkspaceProbeInput,
  probe: WorkspaceProbe,
): WorkspaceKind {
  if (input.knownKind === "directory") return "directory";
  if (input.canonicalPath !== probe.checkoutRoot && probe.checkoutRoot !== null) {
    return "subdirectory";
  }
  if (probe.checkoutKind !== null) return probe.checkoutKind;
  if (probe.checkoutRoot !== null) return "worktree";
  if (probe.availability.status !== "available") {
    return input.knownKind ?? "unknown";
  }
  // Git 信息读不到时按持久化归属兜底：管理目录内的目录按 worktree 展示。
  if (probe.insideManagedWorktreeRoot) return "worktree";
  return input.knownKind ?? "directory";
}

/** 目录只认可访问状态：失效路径不能启动新的 Run。 */
export function workspaceIsUsable(probe: WorkspaceProbe): boolean {
  return probe.availability.status === "available";
}

export async function directoryAvailability(
  canonicalPath: string,
): Promise<WorkspaceAvailabilityView> {
  try {
    const stats = await stat(canonicalPath);
    if (!stats.isDirectory()) {
      return { status: "unreadable", reason: "路径不是目录。" };
    }
    return { status: "available" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "missing" };
    return {
      status: "unreadable",
      reason: error instanceof Error ? error.message : "目录不可访问。",
    };
  }
}

/** 生产实现：目录可访问时再用 Git 读取分支与登记的 checkout。 */
export class GitWorkspaceStatusSource implements WorkspaceStatusSource {
  constructor(private readonly git: GitProjectService) {}

  createCache(projectKey: string | null): WorkspaceProbeCache {
    return new WorkspaceProbeCache(this, { projectKey });
  }

  async probe(
    input: WorkspaceProbeInput,
    context: WorkspaceProbeContext,
  ): Promise<WorkspaceProbe> {
    const availability = await directoryAvailability(input.canonicalPath);
    if (availability.status !== "available") {
      return {
        availability,
        branch: { status: "unknown" },
        checkoutRoot: null,
        checkoutKind: null,
        insideManagedWorktreeRoot: isInside(
          input.canonicalPath,
          this.git.worktreeRootDirectory,
        ),
      };
    }

    try {
      const checkout = await this.git.inspectDirectory(input.canonicalPath);
      const registered = checkout.project.worktrees.find(
        (entry) => entry.path === checkout.checkoutRoot,
      );
      let checkoutKind: WorkspaceProbe["checkoutKind"] = null;
      if (registered !== undefined) {
        if (checkout.checkoutRoot === checkout.project.mainWorkspace) {
          checkoutKind = "main";
        } else {
          checkoutKind = "worktree";
        }
      }
      const hasProjectIdentityConflict =
        context.projectKey !== null && context.projectKey !== checkout.project.key;
      let branch: WorkspaceBranchView = { status: "unknown" };
      if (!hasProjectIdentityConflict) {
        if (checkout.branch !== null) {
          branch = { status: "branch", name: checkout.branch };
        } else {
          branch = { status: "detached", commit: checkout.commit };
        }
      }
      return {
        availability,
        branch,
        checkoutRoot: checkout.checkoutRoot,
        checkoutKind,
        insideManagedWorktreeRoot: isInside(
          input.canonicalPath,
          this.git.worktreeRootDirectory,
        ),
      };
    } catch (error) {
      if (!(error instanceof GitRepositoryError)) throw error;
      return {
        availability,
        branch: { status: "unknown" },
        checkoutRoot: null,
        checkoutKind: null,
        insideManagedWorktreeRoot: isInside(
          input.canonicalPath,
          this.git.worktreeRootDirectory,
        ),
      };
    }
  }
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}
