import type { IncomingMessage, ServerResponse } from "node:http";

import type { ConversationOpenService } from "../application/conversation-open-service.js";
import { ProjectDirectoryUnavailableError } from "../application/project-inspection.js";
import { GitRepositoryError } from "../application/git-project-service.js";
import { writeHttpError, writeJson } from "./http-response.js";

export interface ProjectWorkspaceRouteOptions {
  readonly conversationOpenService?: ConversationOpenService;
}

/**
 * 已登记项目或本次选择项目的只读 Git 信息：worktree 列表与本地分支。
 * 读取与创建共用同一份服务端授权：已登记项目用 `projectKey`，
 * 首次由目录选择器确认的项目用 `selectionToken`。
 */
export class ProjectWorkspaceRoutes {
  constructor(private readonly options: ProjectWorkspaceRouteOptions) {}

  /** `GET /v1/agent/projects/worktrees?projectKey=<opaque>` 或 `?selectionToken=<token>` */
  async listWorktrees(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    await this.#describe(request, response, (description) =>
      writeJson(response, 200, {
        projectKey: description.projectKey,
        mainWorkspace: description.mainWorkspace,
        worktrees: description.worktrees,
      })
    );
  }

  /** `GET /v1/agent/projects/branches?projectKey=<opaque>` 或 `?selectionToken=<token>` */
  async listBranches(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    await this.#describe(request, response, (description) =>
      writeJson(response, 200, description.branches)
    );
  }

  async #describe(
    request: IncomingMessage,
    response: ServerResponse,
    write: (description: NonNullable<Awaited<
      ReturnType<ConversationOpenService["describeProject"]>
    >>) => void,
  ): Promise<void> {
    const service = this.options.conversationOpenService;
    if (service === undefined) {
      writeHttpError(response, {
        status: 501,
        code: "PROJECT_INSPECTION_UNAVAILABLE",
        message: "Project inspection is unavailable.",
      });
      return;
    }
    const target = readProjectQueryTarget(request);
    if (target === undefined) {
      writeHttpError(response, {
        status: 400,
        code: "INVALID_REQUEST",
        message: "Either projectKey or selectionToken is required.",
      });
      return;
    }
    try {
      const description = await service.describeProject(target);
      // dir: 项目不属于 Git：返回空列表，由界面展示「普通目录」空状态。
      write(description ?? {
        projectKey: target.projectKey ?? target.selectionToken ?? "",
        mainWorkspace: "",
        branches: {
          branches: [],
          remotes: [],
          remoteBranches: [],
          recommendedBranch: null,
          recommendationSource: null,
        },
        worktrees: [],
      });
    } catch (error) {
      writeProjectFailure(response, error);
    }
  }
}

function readProjectQueryTarget(
  request: IncomingMessage,
): { readonly projectKey: string | null; readonly selectionToken: string | null } | undefined {
  const url = new URL(request.url ?? "/", "http://localhost");
  const projectKey = url.searchParams.get("projectKey");
  const selectionToken = url.searchParams.get("selectionToken");
  if ((projectKey === null) === (selectionToken === null)) return undefined;
  if (projectKey === "") return undefined;
  if (selectionToken === "") return undefined;
  return { projectKey, selectionToken };
}

function writeProjectFailure(response: ServerResponse, error: unknown): void {
  if (isOpenError(error)) {
    writeHttpError(response, {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error.retryable ? { retryable: true } : {}),
    });
    return;
  }
  if (error instanceof ProjectDirectoryUnavailableError) {
    writeHttpError(response, {
      status: 409,
      code: "PROJECT_UNAVAILABLE",
      message: error.message,
      retryable: true,
    });
    return;
  }
  if (error instanceof GitRepositoryError) {
    writeHttpError(response, {
      status: 503,
      code: "PROJECT_INSPECTION_UNAVAILABLE",
      message: error.message,
      retryable: error.reason === "unavailable",
    });
    return;
  }
  throw error;
}

/** `OpenConversationError` 的形态：业务错误直接映射为 HTTP 状态与错误码。 */
function isOpenError(error: unknown): error is {
  readonly code: string;
  readonly message: string;
  readonly status: number;
  readonly retryable: boolean;
} {
  return (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { status?: unknown }).status === "number"
  );
}
