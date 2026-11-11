import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import type {
  ConversationOpenService,
  OpenConversationError,
  OpenWorkspaceRequest as WorkspaceRequest,
} from "../application/conversation-open-service.js";
import type { ConversationService } from "../application/conversation-service.js";
import type { GitProjectService } from "../application/git-project-service.js";
import { GitRepositoryError } from "../application/git-project-service.js";
import { ProjectDirectoryUnavailableError } from "../application/project-inspection.js";
import type { ProjectInspection } from "../application/project-inspection.js";
import type { SelectionTokenStore } from "../application/project-selection-tokens.js";
import type { HostDirectoryPicker } from "../infrastructure/host-file-picker.js";
import { watchClientDisconnect } from "./client-disconnect.js";
import {
  writeFullAccessRequiresLoopback,
  writeHttpError,
  writeJson,
  writeRetryableSelectionError,
  writeUntrustedFullAccessOrigin,
} from "./http-response.js";
import { evaluateFullAccessRequest } from "./origin-policy.js";
import { parseJsonRequest } from "./request-json.js";
import { defineRoute, type RouteHandler } from "./route.js";

/**
 * 新建会话相关接口：目录选择与识别、项目分支与 worktree 列表、创建会话，
 * 以及创建操作的只读查询。全部只对本机可信来源开放。
 */
export interface WorkspaceProjectsRouteOptions {
  readonly conversationService: ConversationService;
  readonly conversationOpenService?: ConversationOpenService;
  readonly selectionTokens?: SelectionTokenStore;
  readonly projectInspection?: ProjectInspection;
  readonly git?: GitProjectService;
  readonly hostDirectoryPicker?: HostDirectoryPicker;
  readonly allowedOrigin?: string;
  readonly fullAccessAvailable?: boolean;
}

const inspectSchema = z.strictObject({
  action: z.literal("inspect"),
});

const openSchema = z.strictObject({
  projectKey: z.string().min(1).max(4096).optional(),
  selectionToken: z.string().min(1).max(512).optional(),
  executionMode: z.enum(["workspace_sandbox", "full_access"]),
  workspace: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("main") }),
    z.strictObject({
      kind: z.literal("existing_worktree"),
      path: z.string().min(1).max(4096),
    }),
    z.strictObject({
      kind: z.literal("new_worktree"),
      /**
       * 起点位置：`local` 用本机已有的本地分支，`remote` 用 `baseRemote` 上的
       * 分支并在创建前 fetch。省略时按 `local` 处理，兼容旧客户端。
       */
      baseRefKind: z.enum(["local", "remote"]).optional(),
      baseBranch: z.string().min(1).max(255),
      baseRemote: z.string().min(1).max(255).optional(),
      branch: z.string().min(1).max(255),
      /** true 时检出已存在的本地分支 `branch`，而不是创建新分支。 */
      checkoutExisting: z.boolean().optional(),
      operationId: z.uuid(),
    }),
    z.strictObject({ kind: z.literal("selected_directory") }),
    z.strictObject({ kind: z.literal("directory") }),
  ]),
});

/** 目录选择与会话创建接口。 */
export class WorkspaceProjectsRoutes {
  readonly openConversation: RouteHandler;

  constructor(private readonly options: WorkspaceProjectsRouteOptions) {
    const context = {
      ...(options.allowedOrigin === undefined
        ? {}
        : { allowedOrigin: options.allowedOrigin }),
    };
    this.openConversation = defineRoute(
      {
        methods: ["POST"],
        origin: "trusted",
        denyMessage: "This origin cannot open a conversation.",
        handle: ({ request, response }) => this.#open(request, response),
      },
      context,
    );
  }

  /**
   * 只选择并识别目录：打开宿主选择器、校验路径、识别 Git 项目并签发选择
   * 令牌。不初始化运行环境，也不创建会话。
   */
  async inspectSelectedDirectory(
    request: IncomingMessage,
    body: unknown,
    response: ServerResponse,
  ): Promise<void> {
    const parsed = inspectSchema.safeParse(body);
    if (!parsed.success) {
      writeHttpError(response, {
        status: 422,
        code: "INVALID_REQUEST",
        message: "Request body does not match the schema.",
      });
      return;
    }
    const { hostDirectoryPicker, projectInspection, selectionTokens } =
      this.options;
    if (
      hostDirectoryPicker === undefined ||
      projectInspection === undefined ||
      selectionTokens === undefined
    ) {
      writeHttpError(response, {
        status: 501,
        code: "HOST_DIRECTORY_PICKER_UNAVAILABLE",
        message: "The host directory picker is unavailable.",
      });
      return;
    }

    // 关闭页面、刷新或断网时中止目录选择器与随后的 Git 识别。
    const watcher = watchClientDisconnect(request, response);
    try {
      const selection = await hostDirectoryPicker.pickDirectory(watcher.signal);
      if (selection.status === "cancelled") {
        writeRetryableSelectionError(
          response,
          "HOST_DIRECTORY_PICKER_CANCELLED",
          "Directory selection was cancelled.",
        );
        return;
      }
      const identity = await projectInspection.inspectSelectedDirectory(
        selection.path,
        watcher.signal,
      );
      if (watcher.signal.aborted) return;
      const selectionToken = selectionTokens.issue({
        selectedPath: identity.selectedPath,
        checkout: identity.checkout,
      });
      writeJson(response, 200, {
        projectKey: identity.assignment?.projectKey ?? null,
        projectType: identity.checkout === null
          ? identity.assignment === null
            ? "unknown"
            : "directory"
          : "git",
        selectedPath: identity.selectedPath,
        selectedCheckoutRoot: identity.checkout?.checkoutRoot ?? null,
        mainWorkspace: identity.assignment?.projectRoot ?? null,
        selectionKind: selectionKindOf(identity),
        selectionToken,
        ...(identity.failureReason === null
          ? {}
          : { unavailableReason: identity.failureReason }),
      });
    } catch (error) {
      if (watcher.signal.aborted) return;
      if (error instanceof ProjectDirectoryUnavailableError) {
        writeRetryableSelectionError(
          response,
          "WORKSPACE_SELECTION_INVALID",
          "Selected directory is unavailable.",
        );
        return;
      }
      if (error instanceof GitRepositoryError) {
        writeHttpError(response, {
          status: 503,
          code: "PROJECT_INSPECTION_UNAVAILABLE",
          message: error.message,
          retryable: true,
        });
        return;
      }
      writeHttpError(response, {
        status: 500,
        code: "HOST_DIRECTORY_PICKER_FAILED",
        message: "Could not open the host directory picker.",
      });
    } finally {
      watcher.release();
    }
  }

  async #open(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readStrictJson(request, response, openSchema);
    if (body === undefined) return;
    const service = this.options.conversationOpenService;
    if (service === undefined) {
      writeHttpError(response, {
        status: 501,
        code: "WORKSPACE_SELECTION_UNAVAILABLE",
        message: "Opening a conversation is unavailable.",
      });
      return;
    }

    // 与旧的选择接口一致：Full Access 要求可用且来源可信，再解析项目。
    const accessDecision = evaluateFullAccessRequest(
      body.executionMode,
      this.options.fullAccessAvailable,
      request,
      this.options.allowedOrigin,
    );
    if (accessDecision === "requires_loopback") {
      writeFullAccessRequiresLoopback(response);
      return;
    }
    if (accessDecision === "untrusted_origin") {
      writeUntrustedFullAccessOrigin(response);
      return;
    }
    const openRequest = {
      executionMode: body.executionMode,
      ...(body.projectKey === undefined ? {} : { projectKey: body.projectKey }),
      ...(body.selectionToken === undefined
        ? {}
        : { selectionToken: body.selectionToken }),
      workspace: withBaseRefKind(body.workspace),
    };

    // 客户端断开时中止本次 Git 操作并等待进程退出；中断的创建按需要检查落库。
    const watcher = watchClientDisconnect(request, response);
    try {
      const result = await service.open(openRequest, watcher.signal);
      if (result.kind === "conversation") {
        writeJson(response, 201, result.conversation);
        return;
      }
      if (result.kind === "in_progress") {
        writeHttpError(response, {
          status: 409,
          code: "WORKTREE_OPERATION_IN_PROGRESS",
          message: "该 worktree 正在创建中，请稍后查询结果。",
          retryable: true,
        });
        return;
      }
      writeJson(response, 500, {
        error: {
          code: "WORKTREE_NEEDS_INSPECTION",
          message: "worktree 创建没有完成，请检查目标目录与分支。",
          retryable: false,
        },
        operation: {
          operationId: result.operationId,
          status: result.status,
          targetPath: result.targetPath,
          branch: result.branch,
          reason: result.reason,
        },
      });
    } catch (error) {
      if (watcher.signal.aborted) return;
      const openError = error as OpenConversationError;
      const status = typeof openError?.status === "number"
        ? openError.status
        : undefined;
      if (status === undefined) throw error;
      writeHttpError(response, {
        status,
        code: openError.code,
        message: openError.message,
        ...(openError.retryable ? { retryable: true } : {}),
      });
    } finally {
      watcher.release();
    }
  }
}

/**
 * `selectionKind` 描述用户选中的位置：主工作目录根、已有 worktree 根、
 * checkout 内子目录、普通目录，或 Git 信息不可用。
 */
function selectionKindOf(
  identity: Awaited<ReturnType<ProjectInspection["inspectSelectedDirectory"]>>,
): "main" | "worktree" | "subdirectory" | "directory" | "unknown" {
  if (identity.checkout === null) {
    return identity.assignment === null ? "unknown" : "directory";
  }
  const { project, checkoutRoot } = identity.checkout;
  if (identity.selectedPath !== checkoutRoot) return "subdirectory";
  if (checkoutRoot === project.mainWorkspace) return "main";
  return "worktree";
}

/**
 * 补齐 `new_worktree` 的起点位置：省略 `baseRefKind` 的旧请求按本地分支处理。
 * `baseRemote` 与 `baseRefKind` 的搭配由服务层校验，这里只补默认值。
 */
function withBaseRefKind(
  workspace: z.infer<typeof openSchema>["workspace"],
): WorkspaceRequest {
  if (workspace.kind !== "new_worktree") return workspace;
  return {
    ...workspace,
    baseRefKind: workspace.baseRefKind ?? "local",
  };
}

async function readStrictJson<T>(
  request: IncomingMessage,
  response: ServerResponse,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  const parsed = await parseJsonRequest(request, schema, {
    code: "INVALID_REQUEST",
    message: "Request body does not match the schema.",
  });
  if (!parsed.ok) {
    writeHttpError(response, parsed.error);
    return undefined;
  }
  return parsed.data;
}
