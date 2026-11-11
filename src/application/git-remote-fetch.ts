/**
 * 新建 worktree 前的远端刷新：以远端分支为起点时，先 `git fetch <remote>
 * <branch>`，让本机拥有该分支的最新 ref。
 *
 * fetch 会联网、可能等待凭据或传输。凭据提示已在 Git 环境里关闭
 * （`GIT_TERMINAL_PROMPT=0`），这里再固定超时、跟随请求取消，并把失败统一
 * 报告为需要用户处理的业务错误。fetch 只更新 `.git/refs/remotes/<remote>/`
 * 下的引用，不创建分支、目录或 worktree 登记。
 */
import type { GitRunner } from "../infrastructure/git-process-runner.js";
import {
  GIT_FETCH_TIMEOUT_MS,
  GitProcessError,
} from "../infrastructure/git-process-runner.js";
import type { GitProjectIdentity, GitProjectService } from "./git-project-service.js";

export type RemoteFetchFailureReason = "timeout" | "cancelled" | "failed";

export class RemoteFetchError extends Error {
  constructor(
    readonly reason: RemoteFetchFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "RemoteFetchError";
  }
}

export interface RemoteFetchRequest {
  readonly project: GitProjectIdentity;
  readonly remote: string;
  readonly branch: string;
  readonly signal?: AbortSignal;
}

export class GitRemoteFetcher {
  constructor(
    private readonly git: GitProjectService,
    private readonly runner: GitRunner,
  ) {}

  /**
   * 刷新单个远端分支并返回本机该分支 ref 的 commit。刷新后仍然解析不到时
   * 抛 `failed`：远端没有这个分支，或远端不可达。
   */
  async fetchBranch(request: RemoteFetchRequest): Promise<string> {
    const { project, remote, branch, signal } = request;
    try {
      const result = await this.runner.run({
        cwd: project.mainWorkspace,
        // 显式 refspec：只更新这一个远端分支，不改动本地分支和远端 HEAD。
        args: [
          "fetch",
          "--quiet",
          remote,
          `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
        ],
        timeoutMs: GIT_FETCH_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal }),
      });
      if (result.exitCode !== 0) {
        throw new RemoteFetchError(
          "failed",
          result.stderr.trim() || `无法从 ${remote} 获取分支 ${branch}。`,
        );
      }
    } catch (error) {
      if (error instanceof RemoteFetchError) throw error;
      if (error instanceof GitProcessError) {
        // 取消与超时分开报告：超时说明远端可能很慢，取消说明请求被中断。
        let reason: RemoteFetchFailureReason = "failed";
        if (signal?.aborted === true) {
          reason = "cancelled";
        } else if (error.reason === "timeout") {
          reason = "timeout";
        }
        throw new RemoteFetchError(reason, error.message);
      }
      if (error instanceof Error) {
        throw new RemoteFetchError("failed", error.message);
      }
      throw new RemoteFetchError(
        "failed",
        `无法从 ${remote} 获取分支 ${branch}。`,
      );
    }
    const commit = await this.git.resolveRemoteBranchCommit(
      project.mainWorkspace,
      remote,
      branch,
      signal,
    );
    if (commit === null) {
      throw new RemoteFetchError(
        "failed",
        `远端 ${remote} 上没有分支 ${branch}。`,
      );
    }
    return commit;
  }
}
