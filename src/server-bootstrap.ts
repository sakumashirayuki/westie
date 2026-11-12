import {
  createDefaultWorkspaceRuntime,
  createProviderFromEnvironment,
  type SandboxRunnerFactory,
} from "./runtime.js";
import { createAgentServer } from "./server.js";
import {
  isLoopbackBindHost,
  loadAgentServerConfig,
} from "./server-config.js";
import { ConversationRunService } from "./application/conversation-run-service.js";
import { ConversationService } from "./application/conversation-service.js";
import { InMemoryInteractionBroker } from "./application/interaction-broker.js";
import { CachedWorkspaceRuntimeProvider } from "./application/workspace-runtime.js";
import { InMemoryWorkspaceGrantStore } from "./application/workspace-grant-store.js";
import { InMemoryToolGrantStore } from "./application/tool-grant-store.js";
import { RunSteeringQueue } from "./application/run-steering-queue.js";
import { RunRegistry } from "./application/run-registry.js";
import { LarkBindingTokenStore } from "./application/lark-binding-token-store.js";
import { LarkInboundQueue } from "./application/lark-inbound-queue.js";
import { LarkMessageRouter } from "./application/lark-message-router.js";
import { LarkRunBridge } from "./application/lark-run-bridge.js";
import { LarkOutbound } from "./application/lark-outbound.js";
import { LarkClient } from "./lark/lark-client.js";
import { isLarkConfigEnabled } from "./lark/lark-config.js";
import { LarkBindingRoutes } from "./http/lark-binding-routes.js";
import { AgentController } from "./http/agent-controller.js";
import {
  initializeSqliteSchema,
  LarkBindingStore,
  openSqliteDatabase,
  SQLiteConversationStore,
} from "./infrastructure/sqlite/index.js";
import {
  MacOsHostDirectoryPicker,
  MacOsHostFilePicker,
  type HostDirectoryPicker,
} from "./infrastructure/host-file-picker.js";
import { loadWorkspaceInstructions } from "./infrastructure/workspace-instructions.js";
import { loadStopHookConfig } from "./infrastructure/workspace-stop-hook-config.js";
import {
  discoverWorkspaceSkills,
  reportWorkspaceSkillDiagnostics,
} from "./infrastructure/workspace-skills.js";
import { acquireMcpToolSet } from "./mcp/acquire-tools.js";
import { McpServerPool } from "./mcp/server-pool.js";
import { McpConfigRoutes } from "./http/mcp-config-routes.js";
import { ProjectWorkspaceRoutes } from "./http/project-workspace-routes.js";
import { WorkspaceProjectsRoutes } from "./http/workspace-projects-route.js";
import { createProjectServices } from "./application/project-services.js";
import { SQLiteWorktreeOperationStore } from "./infrastructure/sqlite/worktree-operation-store.js";
import { probeMcpServer } from "./mcp/probe.js";
import {
  createMemoryIdentifier,
  createMemoryRuntime,
} from "./infrastructure/run-memory.js";
import { homedir } from "node:os";
import type { AddressInfo } from "node:net";
import {
  AuthorizedToolExecutor,
  createDefaultToolPermissionPolicy,
  JsonLineToolAuditSink,
} from "./tool-permissions.js";

export interface StartAgentServerOptions {
  /** 建会话时的目录来源；缺省弹 macOS 原生选择器。 */
  readonly hostDirectoryPicker?: HostDirectoryPicker;
  /** 监听端口；允许 0 表示由操作系统分配，缺省使用配置端口。 */
  readonly port?: number;
  /** 工具的沙箱实现；缺省 macOS Seatbelt，测试可替换。 */
  readonly sandboxRunnerFactory?: SandboxRunnerFactory;
  /** Git 可执行文件；缺省按 PATH 解析 `git`。 */
  readonly gitExecutable?: string;
  /** Westie 管理的 worktree 根目录；缺省 `~/.westie/worktrees`。 */
  readonly worktreeRoot?: string;
}

/** 已启动的服务句柄：宿主据此加载页面并在退出时等待业务清理。 */
export interface RunningAgentServer {
  readonly url: string;
  close(): Promise<void>;
}

/** 装配并启动 HTTP 服务；进程入口与其他宿主脚本共用这一份装配。 */
export async function startAgentServer(
  options: StartAgentServerOptions = {},
): Promise<RunningAgentServer> {
  const workspaceRoot = process.cwd();
  const config = loadAgentServerConfig(process.env, workspaceRoot);
  const database = openSqliteDatabase(config.databasePath);
  const conversationStore = new SQLiteConversationStore(database);

  try {
    initializeSqliteSchema(database);
    const larkBindingStore = new LarkBindingStore(database);
    // 入站去重记录保留 24 小时：进程启动清理一次，之后每小时清理一次。
    const inboundRetentionMs = 24 * 60 * 60 * 1000;
    const purgeInbound = (): void => {
      larkBindingStore.purgeOldInboundMessages(
        new Date(Date.now() - inboundRetentionMs).toISOString(),
      );
    };
    purgeInbound();
    const inboundPurgeTimer = setInterval(purgeInbound, 60 * 60 * 1000);
    inboundPurgeTimer.unref();
    const worktreeOperations = new SQLiteWorktreeOperationStore(database);
    const interruptedOperations = worktreeOperations.markInterruptedOperations();
    if (interruptedOperations > 0) {
      console.warn(JSON.stringify({
        event: "worktree_operation_recovery",
        reason: "PROCESS_RESTARTED",
        operations: interruptedOperations,
      }));
    }
    const recoveredConversations = conversationStore.recoverStaleRuns();
    if (recoveredConversations > 0) {
      console.warn(JSON.stringify({
        event: "conversation_recovery",
        reason: "PROCESS_RESTARTED",
        conversations: recoveredConversations,
      }));
    }

    const workspaceGrantStore = new InMemoryWorkspaceGrantStore();
    const toolGrantStore = new InMemoryToolGrantStore();
    const steeringQueue = new RunSteeringQueue();
    const mcpServerPool = new McpServerPool();
    const workspaceRuntimeProvider = new CachedWorkspaceRuntimeProvider(
      (canonicalWorkspaceRoot, executionMode) =>
        createDefaultWorkspaceRuntime(
          canonicalWorkspaceRoot,
          executionMode,
          {
            workspaceGrantStore,
            ...(options.sandboxRunnerFactory === undefined
              ? {}
              : { sandboxRunnerFactory: options.sandboxRunnerFactory }),
          },
        ),
    );
    const provider = createProviderFromEnvironment({
      contextWindowTokens: config.modelContextTokens,
      maxOutputTokens: config.modelMaxOutputTokens,
    });
    const interactionBroker = new InMemoryInteractionBroker();
    const authorizedToolExecutor = new AuthorizedToolExecutor({
      policy: createDefaultToolPermissionPolicy({ toolGrantStore }),
      interactionBroker,
      auditSink: new JsonLineToolAuditSink(),
      workspaceGrantStore,
      toolGrantStore,
    });
    // 项目识别、worktree 创建与操作日志；宿主 Git 操作都在服务进程内启动并等待。
    const projectServices = createProjectServices({
      conversationStore,
      workspaceRuntimeProvider,
      worktreeOperations,
      ...(options.gitExecutable === undefined
        ? {}
        : { gitExecutable: options.gitExecutable }),
      ...(options.worktreeRoot === undefined
        ? {}
        : { worktreeRoot: options.worktreeRoot }),
    });
    const conversationService = new ConversationService(conversationStore, {
      toolGrantStore,
      worktreeOperations,
      gitRunner: projectServices.gitRunner,
      statusSource: projectServices.statusDependencies,
    });
    const conversationOpenService =
      projectServices.createOpenService(conversationService);
    // 记忆身份复用项目识别；归属缺失时现场识别，不写数据库。
    const memoryRuntime = createMemoryRuntime({
      rootDirectory: config.memoryRoot,
      identify: createMemoryIdentifier({
        projectInspection: projectServices.projectInspection,
      }),
    });
    const conversationRunService = new ConversationRunService({
      provider,
      conversationStore,
      authorizedToolExecutor,
      workspaceRuntimeProvider,
      loadWorkspaceInstructions,
      loadStopHookConfig,
      async discoverWorkspaceSkills(canonicalWorkspaceRoot) {
        const registry = await discoverWorkspaceSkills(canonicalWorkspaceRoot, {
          homeDir: homedir(),
        });
        reportWorkspaceSkillDiagnostics(registry.diagnostics);
        return registry;
      },
      bytesPerToken: config.bytesPerToken,
      summaryBudgetRatio: config.summaryBudgetRatio,
      compactionRecentPairs: config.compactionRecentPairs,
      loadMemory: (begunRun, signal) =>
        memoryRuntime.loadMemory(begunRun, signal),
      async acquireMcpTools(canonicalWorkspaceRoot) {
        const tools = await acquireMcpToolSet(
          mcpServerPool,
          canonicalWorkspaceRoot,
        );
        return tools.length === 0 ? undefined : { tools };
      },
      steeringSource: (runId) => ({
        async take(step) {
          return steeringQueue.take(runId, step);
        },
        hasPending: () => steeringQueue.hasPending(runId),
        onEnqueued: (listener) => steeringQueue.onEnqueued(runId, listener),
      }),
    });
    const runRegistry = new RunRegistry({
      runService: conversationRunService,
    });
    const larkEnabled = isLarkConfigEnabled(config.lark);
    const larkClient = larkEnabled ? new LarkClient(config.lark) : undefined;
    // 出站发送器始终存在（供 run bridge / router 引用）；桥接关闭时用落日志的空实现，
    // 因为此时不会收到任何事件、也不会发任何东西。
    const larkOutbound = new LarkOutbound({
      client: {
        sendMessage:
          larkClient === undefined
            ? async () => ({ status: "failed" as const })
            : (request) => larkClient.sendMessage(request),
      },
    });
    const larkRunBridge = new LarkRunBridge({
      registry: runRegistry,
      outbound: larkOutbound,
    });
    const larkTokenStore = new LarkBindingTokenStore();
    const larkRouter = larkEnabled
      ? new LarkMessageRouter({
          store: larkBindingStore,
          tokenStore: larkTokenStore,
          allowedOpenIds: config.lark.allowedOpenIds,
          conversationService,
          conversationStore,
          registry: runRegistry,
          steeringQueue,
          runBridge: larkRunBridge,
          outbound: larkOutbound,
        })
      : undefined;
    const larkInboundQueue = larkRouter === undefined
      ? undefined
      : new LarkInboundQueue((event) =>
          handleInboundEvent(larkRouter, larkBindingStore, event),
        );
    if (larkEnabled && larkClient !== undefined) {
      await startLarkBridge(larkClient, larkInboundQueue);
    }
    const larkBindingRoutes = new LarkBindingRoutes({
      bindingStore: larkBindingStore,
      tokenStore: larkTokenStore,
      conversationService,
      bridgeEnabled: larkEnabled,
      allowedOrigin: config.allowedOrigin,
    });
    const controller = new AgentController({
      conversationService,
      conversationRunService,
      registry: runRegistry,
      interactionBroker,
      steeringQueue,
      getActiveRunId: (conversationId) =>
        conversationStore.getActiveRunId(conversationId),
      hostFilePicker: new MacOsHostFilePicker(),
      allowedOrigin: config.allowedOrigin,
      fullAccessAvailable: isLoopbackBindHost(config.host),
      staticDirectory: "web/dist",
      workspaceProjectsRoutes: new WorkspaceProjectsRoutes({
        conversationService,
        conversationOpenService,
        selectionTokens: projectServices.selectionTokens,
        projectInspection: projectServices.projectInspection,
        git: projectServices.git,
        hostDirectoryPicker:
          options.hostDirectoryPicker ?? new MacOsHostDirectoryPicker(),
        allowedOrigin: config.allowedOrigin,
        fullAccessAvailable: isLoopbackBindHost(config.host),
      }),
      projectWorkspaceRoutes: new ProjectWorkspaceRoutes({
        conversationOpenService,
      }),
      conversationOpenService,
      mcpConfigRoutes: new McpConfigRoutes({
        homeDir: homedir(),
        allowedOrigin: config.allowedOrigin,
        fullAccessAvailable: isLoopbackBindHost(config.host),
        probe: probeMcpServer,
      }),
      larkBindingRoutes,
      larkBindingStore,
    });
    const server = createAgentServer(controller);

    const listenPort = options.port ?? config.port;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const url = `http://${config.host}:${
      (server.address() as AddressInfo).port
    }`;
    console.log(`Agent SSE server listening on ${url}`);

    // 幂等关闭：先停接新连接，再停飞书、取消 Run、关连接、关库、等 MCP pool 退出。
    const shutdown = async (): Promise<void> => {
      clearInterval(inboundPurgeTimer);
      // 1. WSClient 停止接收飞书事件；worker 已入队事件宽限 3 秒。
      if (larkClient !== undefined) larkClient.close();
      const inboundGrace = new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 3_000);
        timeout.unref();
        if (larkInboundQueue === undefined) {
          resolve();
          return;
        }
        const poll = (): void => {
          if (larkInboundQueue.pendingCount === 0) {
            resolve();
            return;
          }
          setTimeout(poll, 50).unref();
        };
        poll();
      });
      await inboundGrace;
      // 宽限结束仍积压的入站事件直接丢弃，避免关停期间继续产生副作用。
      const droppedInbound = larkInboundQueue?.flushPending() ?? 0;
      if (droppedInbound > 0) {
        console.warn(JSON.stringify({
          event: "lark.inbound.dropped_on_shutdown",
          dropped: droppedInbound,
        }));
      }
      // 2. 取消运行中的 Run 并等它们落库（上限 10 秒）；飞书启动的 Run 一并被取消，
      //    终态事件推动出站泵把取消/结果通知放入出站队列。
      const stopped = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 10_000);
        timeout.unref();
        runRegistry.cancelAll("Agent service is shutting down.").then(
          () => {
            clearTimeout(timeout);
            resolve();
          },
        );
      });
      // 3. 中止出站频控与重试等待，再等出站泵结束（桥内部上限 5 秒），
      //    随后结束残留 SSE 连接。
      larkOutbound.close();
      await larkRunBridge.stop().catch(() => {});
      server.closeAllConnections();
      try {
        await stopped;
      } finally {
        try {
          conversationStore.close();
        } finally {
          await mcpServerPool.close();
        }
      }
    };

    let closing: Promise<void> | undefined;
    return {
      url,
      close(): Promise<void> {
        return closing ??= shutdown();
      },
    };
  } catch (error) {
    conversationStore.close();
    throw error;
  }
}

/**
 * 处理一条飞书事件：先按规则 1/2 过滤在路由器外做，再在 worker 内对消息类事件写
 * 去重记录，保证同一条消息只生效一次。这里从 SDK 原始事件提取本方案需要的字段。
 */
async function handleInboundEvent(
  larkRouter: LarkMessageRouter,
  larkBindingStore: LarkBindingStore,
  event: unknown,
): Promise<void> {
  const context = extractInboundContext(event);
  if (context === undefined || context === "unrouteable") return;
  if (context === "ignored") return;
  // 规则 1/2：群聊与非用户发送者不写去重记录、不路由。
  if (context.chatType !== "p2p" || context.senderType !== "user") return;
  // 规则 3：先写去重记录。已存在说明平台重试推送，忽略。
  const receivedAt = new Date().toISOString();
  const isNew = larkBindingStore.ensureInboundMessageSeen(
    context.messageId,
    context.chatId,
    receivedAt,
  );
  if (!isNew) return;
  await larkRouter.route(context);
}

function extractInboundContext(
  event: unknown,
): import("./application/lark-message-router.js").InboundMessageContext | "ignored" | "unrouteable" {
  const value = event as {
    sender?: { sender_type?: unknown; sender_id?: { open_id?: unknown } };
    message?: {
      message_id?: unknown;
      chat_id?: unknown;
      chat_type?: unknown;
      message_type?: unknown;
      content?: unknown;
    };
  };
  if (
    !isRecord(value) ||
    !isRecord(value.message) ||
    typeof value.message.chat_id !== "string" ||
    typeof value.message.chat_type !== "string" ||
    typeof value.message.message_type !== "string" ||
    typeof value.message.message_id !== "string" ||
    !isRecord(value.sender) ||
    typeof value.sender.sender_type !== "string" ||
    !isRecord(value.sender.sender_id) ||
    typeof value.sender.sender_id.open_id !== "string"
  ) {
    return "ignored";
  }
  const text = parseInboundText(value.message.content);
  return {
    chatId: value.message.chat_id,
    chatType: value.message.chat_type,
    senderType: value.sender.sender_type,
    senderOpenId: value.sender.sender_id.open_id,
    messageId: value.message.message_id,
    messageType: value.message.message_type,
    text,
  };
}

function parseInboundText(content: unknown): string {
  if (typeof content !== "string") return "";
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function startLarkBridge(
  larkClient: LarkClient,
  queue: LarkInboundQueue | undefined,
): Promise<boolean> {
  if (queue === undefined) return false;
  try {
    await larkClient.start((event) => queue.push(event));
    console.warn(JSON.stringify({ event: "lark.ws.started" }));
    return true;
  } catch (error) {
    console.error(JSON.stringify({
      event: "lark.ws.start_failed",
      message: error instanceof Error ? error.message : String(error),
    }));
    // 启动失败只记录日志，HTTP 服务照常启动（网页功能不受影响）。
    return false;
  }
}
