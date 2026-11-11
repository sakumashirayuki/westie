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
import { AgentController } from "./http/agent-controller.js";
import {
  initializeSqliteSchema,
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

    // 幂等关闭：先停接新连接，再取消 Run、关连接、关库、等 MCP pool 退出。
    const shutdown = async (): Promise<void> => {
      // 1. 停止接受新连接（不等待其回调：SSE 长连接不会自己结束）；
      // 2. 取消运行中的 Run 并等它们落库（上限 10 秒）；
      // 3. 结束残留 SSE 连接；4. 关库、等 MCP pool 关闭。
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
