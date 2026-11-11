/**
 * 项目身份识别：用 `GitProjectService` 读取选择器返回目录的 Git 身份，
 * 生成 `git:<canonical common dir>` 或 `dir:<canonical directory>` 归属。
 * 识别失败区分「没有 Git」与「Git 暂时无法判断」，后者不能写成普通目录。
 */
import { realpath, stat } from "node:fs/promises";

import type { ConversationProjectAssignment } from "./conversation-store.js";
import {
  GitRepositoryError,
  type GitCheckoutState,
  type GitProjectService,
} from "./git-project-service.js";

export interface GitProjectInspection {
  readonly assignment: ConversationProjectAssignment;
  readonly checkout: GitCheckoutState | null;
}

export class ProjectDirectoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectDirectoryUnavailableError";
  }
}

export class ProjectInspection {
  constructor(private readonly git: GitProjectService) {}

  /**
   * 识别目录所属项目。Git 信息暂时读不到时返回 null，调用方保留「未识别」
   * 并在下次刷新重试，不能把它写成普通目录。
   */
  async inspect(
    canonicalPath: string,
    signal?: AbortSignal,
  ): Promise<GitProjectInspection | null> {
    let identity;
    try {
      identity = await this.git.identifySelection(canonicalPath, signal);
    } catch (error) {
      if (error instanceof GitRepositoryError) return null;
      throw error;
    }
    return {
      assignment: assignmentFor(identity.selectedPath, identity.checkout),
      checkout: identity.checkout,
    };
  }

  /**
   * 由系统选择器确认的目录识别项目。目录不可访问时抛
   * `ProjectDirectoryUnavailableError`；Git 暂时不可用时返回「未识别」。
   */
  async inspectSelectedDirectory(
    selectedPath: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly selectedPath: string;
    readonly assignment: ConversationProjectAssignment | null;
    readonly checkout: GitCheckoutState | null;
    readonly failureReason: string | null;
  }> {
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(selectedPath);
      const stats = await stat(canonicalPath);
      if (!stats.isDirectory()) {
        throw new ProjectDirectoryUnavailableError("路径不是目录。");
      }
    } catch (error) {
      if (error instanceof ProjectDirectoryUnavailableError) throw error;
      throw new ProjectDirectoryUnavailableError("所选目录不可访问。");
    }

    try {
      const identity = await this.git.identifySelection(canonicalPath, signal);
      return {
        selectedPath: canonicalPath,
        assignment: assignmentFor(canonicalPath, identity.checkout),
        checkout: identity.checkout,
        failureReason: null,
      };
    } catch (error) {
      if (!(error instanceof GitRepositoryError)) throw error;
      return {
        selectedPath: canonicalPath,
        assignment: null,
        checkout: null,
        failureReason: error.message,
      };
    }
  }

  /** 按已持久化归属重新验证项目；不一致或路径失效时抛错。 */
  async verify(
    assignment: ConversationProjectAssignment,
    signal?: AbortSignal,
  ): Promise<GitProjectInspection> {
    const inspection = await this.inspect(assignment.projectRoot, signal);
    if (inspection === null) {
      throw new ProjectDirectoryUnavailableError(
        "项目目录不可访问或 Git 信息不可用。",
      );
    }
    if (inspection.assignment.projectKey !== assignment.projectKey) {
      throw new ProjectDirectoryUnavailableError(
        "项目目录与已保存的项目身份不一致。",
      );
    }
    return inspection;
  }
}

function assignmentFor(
  canonicalPath: string,
  checkout: GitCheckoutState | null,
): ConversationProjectAssignment {
  if (checkout === null) {
    return {
      projectKey: `dir:${canonicalPath}`,
      projectRoot: canonicalPath,
    };
  }
  return {
    projectKey: checkout.project.key,
    projectRoot: checkout.project.mainWorkspace,
  };
}
