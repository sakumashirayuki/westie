import { realpath, stat } from "node:fs/promises";

import type { Tool } from "../tools.js";
import type { ExecutionMode } from "../domain/conversation.js";
import type { SandboxRunner } from "../sandbox/sandbox-runner.js";

export interface WorkspaceRuntime {
  readonly workspaceRoot: string;
  readonly executionMode: ExecutionMode;
  /** 当前执行模式的命令执行器；完成检查脚本复用它，沿用同一权限边界。 */
  readonly sandboxRunner: SandboxRunner;
  readonly tools: readonly Tool[];
}

export interface WorkspaceRuntimeProvider {
  get(
    workspaceRoot: string,
    executionMode: ExecutionMode,
  ): Promise<WorkspaceRuntime>;
}

export type WorkspaceRuntimeFactory = (
  canonicalWorkspaceRoot: string,
  executionMode: ExecutionMode,
) => Promise<WorkspaceRuntime>;

export class CachedWorkspaceRuntimeProvider
  implements WorkspaceRuntimeProvider {
  readonly #runtimes = new Map<string, Promise<WorkspaceRuntime>>();

  constructor(private readonly factory: WorkspaceRuntimeFactory) {}

  async get(
    workspaceRoot: string,
    executionMode: ExecutionMode,
  ): Promise<WorkspaceRuntime> {
    const canonicalWorkspaceRoot = await canonicalizeDirectory(workspaceRoot);
    const cacheKey = `${executionMode}\0${canonicalWorkspaceRoot}`;
    const cached = this.#runtimes.get(cacheKey);
    if (cached !== undefined) return cached;

    const created = this.factory(canonicalWorkspaceRoot, executionMode).then(
      (runtime) => {
        if (runtime.workspaceRoot !== canonicalWorkspaceRoot) {
          throw new Error(
            "Workspace runtime root does not match the requested canonical root.",
          );
        }
        if (runtime.executionMode !== executionMode) {
          throw new Error(
            "Workspace runtime mode does not match the requested execution mode.",
          );
        }
        return runtime;
      },
    );
    this.#runtimes.set(cacheKey, created);

    try {
      return await created;
    } catch (error) {
      if (this.#runtimes.get(cacheKey) === created) {
        this.#runtimes.delete(cacheKey);
      }
      throw error;
    }
  }
}

async function canonicalizeDirectory(workspaceRoot: string): Promise<string> {
  const canonicalWorkspaceRoot = await realpath(workspaceRoot);
  const workspaceStats = await stat(canonicalWorkspaceRoot);
  if (!workspaceStats.isDirectory()) {
    throw new Error("Workspace root must be a directory.");
  }
  return canonicalWorkspaceRoot;
}
