/**
 * 项目记忆身份与启动加载：把会话已有的项目归属（必要时现场识别）映射到一个
 * 记忆目录，并读取有界索引。记忆不可用只影响本 Run 的记忆区块与 `memory` 工具，
 * 不阻断普通对话。
 */
import type {
  BegunConversationRun,
  StoredWorkspaceKind,
} from "../application/conversation-store.js";
import type { ProjectInspection } from "../application/project-inspection.js";
import {
  MemoryEncodingError,
  ProjectMemoryStore,
} from "./memory-store.js";

export type MemoryStatus =
  | { readonly status: "ready" }
  | { readonly status: "truncated"; readonly nextLine: number }
  | {
      readonly status: "unavailable";
      readonly reason: "identity" | "read" | "encoding";
    };

/** 一次 Run 的记忆快照：索引内容、状态和绑定到记忆目录的工具存储。 */
export interface RunMemory {
  readonly status: MemoryStatus;
  readonly index: string;
  readonly nextLine: number | null;
  /**
   * 记忆可用时的存储。索引读取失败、编码非法或目录不可访问时不提供，父 Run 因此
   * 不注册 `memory` 工具，不会在已经读不到索引的情况下继续写入。
   */
  readonly store?: ProjectMemoryStore;
}

export type MemoryIdentifier = (
  begunRun: BegunConversationRun,
  signal: AbortSignal | undefined,
) => Promise<string | null>;

export interface MemoryRuntime {
  /**
   * 每个 Run 开始时读取一次索引；取消沿 Run 的 AbortSignal 传播，识别等待期间
   * 取消时中止 Run，不把取消当成空记忆。
   */
  loadMemory(
    begunRun: BegunConversationRun,
    signal?: AbortSignal,
  ): Promise<RunMemory>;
}

export interface MemoryRuntimeOptions {
  /** 记忆根目录的绝对路径。 */
  readonly rootDirectory: string;
  /**
   * 会话未持久化项目归属时的现场识别；返回 null 表示暂不可用。省略时不现场识别，
   * 归属为空即记忆不可用。
   */
  readonly identify?: MemoryIdentifier;
}

/**
 * 项目归属非空时直接用已保存的 key；为空时复用 `ProjectInspection` 识别当前
 * 工作目录，但已知工作区类型是仓库内目录（main / worktree / subdirectory）时
 * 只接受 `git:` 身份，避免错误落入普通目录记忆。Run 不负责回填数据库。
 */
export function createMemoryIdentifier(options: {
  readonly projectInspection: ProjectInspection;
}): MemoryIdentifier {
  return async (begunRun, signal) => {
    const inspection = await options.projectInspection.inspect(
      begunRun.workspaceRoot,
      signal,
    );
    if (inspection === null) return null;
    const projectKey = inspection.assignment.projectKey;
    if (
      knownRepositoryWorkspaceKind(begunRun.workspaceKind) &&
      !projectKey.startsWith("git:")
    ) {
      return null;
    }
    return projectKey;
  };
}

function knownRepositoryWorkspaceKind(
  kind: StoredWorkspaceKind | null | undefined,
): boolean {
  return kind === "main" || kind === "worktree" || kind === "subdirectory";
}

export function createMemoryRuntime(
  options: MemoryRuntimeOptions,
): MemoryRuntime {
  return {
    async loadMemory(begunRun, signal) {
      const projectKey = begunRun.projectKey ??
        (options.identify === undefined
          ? null
          : await options.identify(begunRun, signal));
      if (projectKey === null) return unavailable("identity");
      const store = new ProjectMemoryStore(options.rootDirectory, projectKey);
      try {
        const index = await store.loadIndex(signal);
        signal?.throwIfAborted();
        return {
          status: index.nextLine === null
            ? { status: "ready" }
            : { status: "truncated", nextLine: index.nextLine },
          index: index.content,
          nextLine: index.nextLine,
          store,
        };
      } catch (error) {
        if (signal?.aborted === true) throw error;
        return unavailable(
          error instanceof MemoryEncodingError ? "encoding" : "read",
        );
      }
    },
  };
}

function unavailable(reason: "identity" | "read" | "encoding"): RunMemory {
  return {
    status: { status: "unavailable", reason },
    index: "",
    nextLine: null,
  };
}

