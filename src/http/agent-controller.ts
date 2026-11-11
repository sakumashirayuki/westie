import type { IncomingMessage, ServerResponse } from "node:http";

import type { ConversationOpenService } from "../application/conversation-open-service.js";
import type { ConversationRunService } from "../application/conversation-run-service.js";
import type { ConversationService } from "../application/conversation-service.js";
import type { InteractionBroker } from "../application/interaction-broker.js";
import type { RunRegistry } from "../application/run-registry.js";
import type { RunSteeringQueue } from "../application/run-steering-queue.js";
import type { HostFilePicker } from "../infrastructure/host-file-picker.js";
import { ConversationItemRoutes } from "./conversation-item-routes.js";
import { ConversationListRoutes } from "./conversation-list-routes.js";
import {
  defineRoute,
  type ParamRouteHandler,
  type RouteContext,
  type RouteDefinition,
  type RouteHandler,
} from "./route.js";
import { ConversationRunSseRoute } from "./conversation-run-sse-route.js";
import { ConversationArchiveRoute } from "./conversation-archive-route.js";
import { ConversationRunEventsRoute } from "./conversation-run-events-route.js";
import { ConversationRunCancelRoute } from "./conversation-run-cancel-route.js";
import { RunActivityRoute } from "./run-activity-route.js";
import { ConversationSubAgentCancelRoute } from "./conversation-sub-agent-cancel-route.js";
import { writeHttpError, writeJson, writeMethodNotAllowed, writeNotFound } from "./http-response.js";
import { InteractionRoutes } from "./interaction-routes.js";
import { ConversationRunSteerRoute } from "./conversation-run-steer-route.js";
import { McpConfigRoutes } from "./mcp-config-routes.js";
import { ProjectWorkspaceRoutes } from "./project-workspace-routes.js";
import { WorkspaceProjectsRoutes } from "./workspace-projects-route.js";
import { applyCors } from "./origin-policy.js";
import { checkTrustedOrigin } from "./route.js";
import { readJsonBody } from "./request-json.js";
import { serveSpaEntry, serveStaticFile } from "./static-files.js";

const CONVERSATIONS_PATH = "/v1/agent/conversations";
const SELECT_WORKSPACE_PATH = "/v1/agent/conversations:select-workspace";
const ROUTE_OPENED_CONVERSATION_PATH = "/v1/agent/conversations:open";
const PROJECT_WORKTREES_PATH = /^\/v1\/agent\/projects\/worktrees$/;
const PROJECT_BRANCHES_PATH = /^\/v1\/agent\/projects\/branches$/;
const WORKTREE_OPERATION_PATH =
  /^\/v1\/agent\/worktree-operations\/([^/]+)$/;
const CONVERSATION_PATH = /^\/v1\/agent\/conversations\/([^/]+)$/;
const CONVERSATION_ARCHIVE_PATH =
  /^\/v1\/agent\/conversations\/([^/]+):archive$/;
const CONVERSATION_RUN_PATH =
  /^\/v1\/agent\/conversations\/([^/]+)\/runs:stream$/;
const INTERACTION_RESPONSE_PATH =
  /^\/v1\/agent\/interactions\/([^/]+):respond$/;
const INTERACTION_SELECT_FILE_PATH =
  /^\/v1\/agent\/interactions\/([^/]+):select-file$/;
const CONVERSATION_RUN_STEER_PATH =
  /^\/v1\/agent\/conversations\/([^/]+)\/runs:steer$/;
const CONVERSATION_RUN_EVENTS_PATH =
  /^\/v1\/agent\/conversations\/([^/]+)\/runs\/([^/]+)\/events$/;
const CONVERSATION_RUN_CANCEL_PATH =
  /^\/v1\/agent\/conversations\/([^/]+)\/runs\/([^/]+):cancel$/;
const SUB_AGENT_CANCEL_PATH =
  /^\/v1\/agent\/conversations\/([^/]+)\/runs\/([^/]+)\/sub-agents\/([^/]+):cancel$/;
const RUNS_WATCH_PATH = "/v1/agent/runs:watch";
const MCP_CONFIG_PATH = "/v1/agent/mcp-config";
const MCP_CONFIG_PROBE_PATH = "/v1/agent/mcp-config:probe";

export interface AgentControllerOptions {
  readonly conversationService: ConversationService;
  readonly conversationRunService: ConversationRunService;
  readonly registry: RunRegistry;
  readonly interactionBroker: InteractionBroker;
  readonly steeringQueue?: RunSteeringQueue;
  readonly getActiveRunId?: (conversationId: string) => string | undefined;
  readonly hostFilePicker?: HostFilePicker;
  readonly allowedOrigin?: string;
  readonly fullAccessAvailable?: boolean;
  readonly staticDirectory?: string;
  /** MCP 配置管理端点的依赖；缺省由 server-bootstrap 提供。 */
  readonly mcpConfigRoutes?: McpConfigRoutes;
  /** 新建会话相关接口；缺省时这些接口返回 501。 */
  readonly workspaceProjectsRoutes?: WorkspaceProjectsRoutes;
  /** 项目 worktree / 分支查询；缺省时返回 404。 */
  readonly projectWorkspaceRoutes?: ProjectWorkspaceRoutes;
  /** 创建操作日志查询接口；缺省时返回 404。 */
  readonly conversationOpenService?: ConversationOpenService;
}
export class AgentController {
  readonly #conversationItemRoutes: ConversationItemRoutes;
  readonly #conversationListRoutes: ConversationListRoutes;
  readonly #workspaceProjectsRoutes: WorkspaceProjectsRoutes | undefined;
  readonly #projectWorkspaceRoutes: ProjectWorkspaceRoutes | undefined;
  readonly #projectWorktrees: RouteHandler;
  readonly #projectBranches: RouteHandler;
  readonly #worktreeOperation: ParamRouteHandler<[string]>;
  readonly #conversationRunRoute: ConversationRunSseRoute;
  readonly #conversationRunEventsRoute: ConversationRunEventsRoute;
  readonly #conversationRunCancelRoute: ConversationRunCancelRoute;
  readonly #subAgentCancelRoute: ConversationSubAgentCancelRoute;
  readonly #conversationRunSteerRoute: ConversationRunSteerRoute;
  readonly #conversationArchiveRoute: ConversationArchiveRoute;
  readonly #runActivityRoute: RunActivityRoute;
  /**
   * 带路径参数的端点：`defineRoute` 只判断方法与 Origin，参数由 `#guarded` 在
   * 这些判断之后才交给业务 `handle`。各 `handle` 不再自行校验方法与 Origin。
   */
  readonly #guarded: {
    readonly runsWatch: RouteHandler;
    readonly runEvents: ParamRouteHandler<[string, string]>;
    readonly subAgentCancel: ParamRouteHandler<[string, string, string]>;
    readonly runCancel: ParamRouteHandler<[string, string]>;
    readonly archive: ParamRouteHandler<[string]>;
  };
  readonly #interactionRoutes: InteractionRoutes;
  readonly #interactionRespond: ParamRouteHandler<[string]>;
  readonly #interactionSelectFile: ParamRouteHandler<[string]>;
  readonly #mcpConfigSave: RouteHandler;
  readonly #mcpConfigRead: RouteHandler;
  readonly #mcpConfigProbe: RouteHandler;
  readonly #mcpConfigRoutes: McpConfigRoutes | undefined;

  constructor(private readonly options: AgentControllerOptions) {
    this.#conversationItemRoutes = new ConversationItemRoutes(options);
    this.#conversationListRoutes = new ConversationListRoutes(options);
    this.#workspaceProjectsRoutes = options.workspaceProjectsRoutes;
    this.#projectWorkspaceRoutes = options.projectWorkspaceRoutes;
    this.#conversationRunRoute = new ConversationRunSseRoute(options);
    this.#conversationRunEventsRoute = new ConversationRunEventsRoute(options);
    this.#conversationRunCancelRoute = new ConversationRunCancelRoute(options);
    this.#subAgentCancelRoute = new ConversationSubAgentCancelRoute(options);
    this.#conversationRunSteerRoute = new ConversationRunSteerRoute(options);
    this.#conversationArchiveRoute = new ConversationArchiveRoute(options);
    this.#runActivityRoute = new RunActivityRoute(options);
    this.#interactionRoutes = new InteractionRoutes(options);
    this.#mcpConfigRoutes = options.mcpConfigRoutes;

    const routeContext = {
      ...(options.allowedOrigin === undefined
        ? {}
        : { allowedOrigin: options.allowedOrigin }),
    };
    this.#interactionRespond = guardRoute(
      {
        methods: ["POST"],
        origin: "trusted",
        denyMessage: "This origin cannot answer an interaction.",
      },
      routeContext,
      (request, response, interactionId) =>
        this.#interactionRoutes.respondToInteraction(
          request,
          response,
          interactionId,
        ),
    );
    this.#interactionSelectFile = guardRoute(
      {
        methods: ["POST"],
        origin: "trusted",
        denyMessage: "This origin cannot select a file.",
      },
      routeContext,
      (request, response, interactionId) =>
        this.#interactionRoutes.selectFileForInteraction(
          request,
          response,
          interactionId,
        ),
    );
    this.#mcpConfigSave = defineRoute(
      {
        methods: ["PUT"],
        origin: "trusted",
        denyMessage: "This origin cannot manage MCP config.",
        handle: ({ request, response }) =>
          this.#mcpConfigRoutes === undefined
            ? writeNotFound(response)
            : this.#mcpConfigRoutes.saveConfig(request, response),
      },
      routeContext,
    );
    this.#mcpConfigRead = defineRoute(
      {
        methods: ["GET"],
        origin: "trusted",
        denyMessage: "This origin cannot manage MCP config.",
        handle: ({ request, response }) =>
          this.#mcpConfigRoutes === undefined
            ? writeNotFound(response)
            : this.#mcpConfigRoutes.getConfig(request, response),
      },
      routeContext,
    );
    this.#mcpConfigProbe = defineRoute(
      {
        methods: ["POST"],
        origin: "trusted",
        denyMessage: "This origin cannot manage MCP config.",
        handle: ({ request, response }) =>
          this.#mcpConfigRoutes === undefined
            ? writeNotFound(response)
            : this.#mcpConfigRoutes.probeServer(request, response),
      },
      routeContext,
    );
    this.#projectWorktrees = defineRoute(
      {
        methods: ["GET"],
        origin: "trusted",
        denyMessage: "This origin cannot list project worktrees.",
        handle: ({ request, response }) =>
          this.#projectWorkspaceRoutes === undefined
            ? writeNotFound(response)
            : this.#projectWorkspaceRoutes.listWorktrees(request, response),
      },
      routeContext,
    );
    this.#projectBranches = defineRoute(
      {
        methods: ["GET"],
        origin: "trusted",
        denyMessage: "This origin cannot list project branches.",
        handle: ({ request, response }) =>
          this.#projectWorkspaceRoutes === undefined
            ? writeNotFound(response)
            : this.#projectWorkspaceRoutes.listBranches(request, response),
      },
      routeContext,
    );
    this.#worktreeOperation = guardRoute(
      {
        methods: ["GET"],
        origin: "trusted",
        denyMessage: "This origin cannot inspect a worktree operation.",
      },
      routeContext,
      async (request, response, operationId) => {
        const service = this.options.conversationOpenService;
        if (service === undefined) {
          writeNotFound(response);
          return;
        }
        const operation = await service.inspectOperation(operationId);
        if (operation === undefined) {
          writeNotFound(response);
          return;
        }
        writeJson(response, 200, operation);
      },
    );
    this.#guarded = {
      // 全局状态流是只读的，不要求浏览器 Origin；与改造前行为一致。
      runsWatch: defineRoute(
        {
          methods: ["GET"],
          origin: "public",
          denyMessage: "This origin cannot watch run activity.",
          handle: ({ request, response }) =>
            this.#runActivityRoute.handle(request, response),
        },
        routeContext,
      ),
      runEvents: guardRoute(
        {
          methods: ["GET"],
          origin: "public",
          denyMessage: "This origin cannot subscribe to run events.",
        },
        routeContext,
        (request, response, conversationId, runId) =>
          this.#conversationRunEventsRoute.handle(
            request,
            response,
            conversationId,
            runId,
          ),
      ),
      subAgentCancel: guardRoute(
        {
          methods: ["POST"],
          origin: "trusted",
          denyMessage: "This origin cannot stop a sub agent.",
        },
        routeContext,
        (request, response, conversationId, parentRunId, childRunId) =>
          this.#subAgentCancelRoute.handle(
            request,
            response,
            conversationId,
            parentRunId,
            childRunId,
          ),
      ),
      runCancel: guardRoute(
        {
          methods: ["POST"],
          origin: "trusted",
          denyMessage: "This origin cannot cancel a run.",
        },
        routeContext,
        (request, response, conversationId, runId) =>
          this.#conversationRunCancelRoute.handle(
            request,
            response,
            conversationId,
            runId,
          ),
      ),
      archive: guardRoute(
        {
          methods: ["POST"],
          origin: "trusted",
          denyMessage: "This origin cannot archive a conversation.",
        },
        routeContext,
        (request, response, conversationId) =>
          this.#conversationArchiveRoute.handle(
            request,
            response,
            conversationId,
          ),
      ),
    };
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    applyCors(request, response, this.options.allowedOrigin);

    const pathname = parsePathname(request.url);
    if (pathname === null) {
      writeNotFound(response);
      return;
    }

    if (request.method === "OPTIONS" && isAgentApiPath(pathname)) {
      response.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
      });
      response.end();
      return;
    }

    if (pathname === SELECT_WORKSPACE_PATH) {
      if (request.method !== "POST") {
        writeMethodNotAllowed(response, "POST");
        return;
      }
      // Origin 先于请求体判定：不可信来源不接触 body。
      if (
        checkTrustedOrigin(request, this.options.allowedOrigin) !== "allowed"
      ) {
        writeHttpError(response, {
          status: 403,
          code: "UNTRUSTED_ORIGIN",
          message: "This origin cannot open a host directory picker.",
        });
        return;
      }
      const read = await readJsonBody(request);
      if (!read.ok) {
        writeHttpError(response, read.error);
        return;
      }
      const routes = this.#workspaceProjectsRoutes;
      if (routes === undefined) {
        writeHttpError(response, {
          status: 501,
          code: "HOST_DIRECTORY_PICKER_UNAVAILABLE",
          message: "The host directory picker is unavailable.",
        });
        return;
      }
      await routes.inspectSelectedDirectory(request, read.body, response);
      return;
    }

    if (pathname === ROUTE_OPENED_CONVERSATION_PATH) {
      const routes = this.#workspaceProjectsRoutes;
      if (routes === undefined) {
        writeHttpError(response, {
          status: 501,
          code: "WORKSPACE_SELECTION_UNAVAILABLE",
          message: "Opening a conversation is unavailable.",
        });
        return;
      }
      await routes.openConversation(request, response);
      return;
    }

    if (PROJECT_WORKTREES_PATH.test(pathname)) {
      await this.#projectWorktrees(request, response);
      return;
    }

    if (PROJECT_BRANCHES_PATH.test(pathname)) {
      await this.#projectBranches(request, response);
      return;
    }

    const worktreeOperationMatch = WORKTREE_OPERATION_PATH.exec(pathname);
    if (worktreeOperationMatch !== null) {
      await this.#worktreeOperation(
        request,
        response,
        decodeURIComponent(worktreeOperationMatch[1]),
      );
      return;
    }

    if (pathname === CONVERSATIONS_PATH) {
      await this.#conversationListRoutes.route(request, response);
      return;
    }

    if (pathname === RUNS_WATCH_PATH) {
      await this.#guarded.runsWatch(request, response);
      return;
    }

    const conversationRunEventsMatch =
      CONVERSATION_RUN_EVENTS_PATH.exec(pathname);
    if (conversationRunEventsMatch !== null) {
      await this.#guarded.runEvents(
        request,
        response,
        conversationRunEventsMatch[1],
        conversationRunEventsMatch[2],
      );
      return;
    }

    const subAgentCancelMatch = SUB_AGENT_CANCEL_PATH.exec(pathname);
    if (subAgentCancelMatch !== null) {
      await this.#guarded.subAgentCancel(
        request,
        response,
        subAgentCancelMatch[1],
        subAgentCancelMatch[2],
        subAgentCancelMatch[3],
      );
      return;
    }

    const conversationRunCancelMatch =
      CONVERSATION_RUN_CANCEL_PATH.exec(pathname);
    if (conversationRunCancelMatch !== null) {
      await this.#guarded.runCancel(
        request,
        response,
        conversationRunCancelMatch[1],
        conversationRunCancelMatch[2],
      );
      return;
    }

    const interactionResponseMatch = INTERACTION_RESPONSE_PATH.exec(pathname);
    if (interactionResponseMatch !== null) {
      await this.#interactionRespond(
        request,
        response,
        interactionResponseMatch[1],
      );
      return;
    }

    const interactionSelectFileMatch =
      INTERACTION_SELECT_FILE_PATH.exec(pathname);
    if (interactionSelectFileMatch !== null) {
      await this.#interactionSelectFile(
        request,
        response,
        interactionSelectFileMatch[1],
      );
      return;
    }

    const conversationRunMatch = CONVERSATION_RUN_PATH.exec(pathname);
    if (conversationRunMatch !== null) {
      await this.#conversationRunRoute.handle(
        request,
        response,
        conversationRunMatch[1],
      );
      return;
    }

    const conversationRunSteerMatch =
      CONVERSATION_RUN_STEER_PATH.exec(pathname);
    if (conversationRunSteerMatch !== null) {
      await this.#conversationRunSteerRoute.handle(
        request,
        response,
        conversationRunSteerMatch[1],
      );
      return;
    }

    if (pathname === MCP_CONFIG_PROBE_PATH) {
      await this.#mcpConfigProbe(request, response);
      return;
    }
    if (pathname === MCP_CONFIG_PATH) {
      if (request.method === "PUT") {
        await this.#mcpConfigSave(request, response);
        return;
      }
      await this.#mcpConfigRead(request, response);
      return;
    }

    const conversationArchiveMatch = CONVERSATION_ARCHIVE_PATH.exec(pathname);
    if (conversationArchiveMatch !== null) {
      await this.#guarded.archive(
        request,
        response,
        decodeURIComponent(conversationArchiveMatch[1]),
      );
      return;
    }

    if (CONVERSATION_PATH.test(pathname)) {
      // 方法分发、Allow 头与 Origin 校验都在 ConversationItemRoutes 的 defineRoute 里。
      await this.#conversationItemRoutes.route(request, response);
      return;
    }

    if (
      request.method === "GET" &&
      this.options.staticDirectory !== undefined
    ) {
      if (
        await serveStaticFile(
          response,
          pathname,
          this.options.staticDirectory,
        )
      ) {
        return;
      }
      if (
        !pathname.startsWith("/v1/") &&
        acceptsHtml(request) &&
        await serveSpaEntry(response, this.options.staticDirectory)
      ) {
        return;
      }
    }
    writeNotFound(response);
  }
}

function isAgentApiPath(pathname: string): boolean {
  return pathname === CONVERSATIONS_PATH ||
    pathname === SELECT_WORKSPACE_PATH ||
    pathname === ROUTE_OPENED_CONVERSATION_PATH ||
    pathname === "/v1/agent/projects/worktrees" ||
    pathname === "/v1/agent/projects/branches" ||
    WORKTREE_OPERATION_PATH.test(pathname) ||
    pathname.startsWith(`${CONVERSATIONS_PATH}/`) ||
    pathname.startsWith("/v1/agent/interactions/") ||
    pathname === RUNS_WATCH_PATH ||
    pathname === MCP_CONFIG_PATH ||
    pathname === MCP_CONFIG_PROBE_PATH;
}

function parsePathname(url: string | undefined): string | null {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
}

function acceptsHtml(request: IncomingMessage): boolean {
  const accept = request.headers.accept;
  return typeof accept === "string" &&
    accept
      .split(",")
      .some((value) => value.trim().split(";", 1)[0] === "text/html");
}

/**
 * 把 `defineRoute` 的方法与 Origin 守卫套在带参数的端点上。
 *
 * `defineRoute` 的 handle 拿不到路径参数（正则捕获在调用方手里），所以这里先用
 * 一条同款守卫挡掉错误方法和不可信 Origin，通过后再把参数交给业务 `handle`。
 * 守卫本身的判定逻辑仍只有 `route.ts` 一处实现。
 */
function guardRoute<TPath extends readonly string[]>(
  definition: Omit<RouteDefinition, "handle">,
  context: RouteContext,
  handle: ParamRouteHandler<TPath>,
): ParamRouteHandler<TPath> {
  let allowed = false;
  const guard = defineRoute(
    {
      ...definition,
      handle: () => {
        allowed = true;
      },
    },
    context,
  );
  return async (request, response, ...params) => {
    allowed = false;
    await guard(request, response);
    if (!allowed) return;
    await handle(request, response, ...params);
  };
}
