import { mkdtemp, rm } from "node:fs/promises";
import { HostSandboxRunner } from "../../src/sandbox/host-sandbox-runner.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ConversationRunService } from "../../src/application/conversation-run-service.js";
import { ConversationService } from "../../src/application/conversation-service.js";
import { InMemoryInteractionBroker } from "../../src/application/interaction-broker.js";
import { RunRegistry } from "../../src/application/run-registry.js";
import { RunSteeringQueue } from "../../src/application/run-steering-queue.js";
import { AgentController } from "../../src/http/agent-controller.js";
import { initializeSqliteSchema, openSqliteDatabase, SQLiteConversationStore } from "../../src/infrastructure/sqlite/index.js";
import { createAgentServer } from "../../src/server.js";
import { createProjectServices } from "../../src/application/project-services.js";
import { WorkspaceProjectsRoutes } from "../../src/http/workspace-projects-route.js";
import { SQLiteWorktreeOperationStore } from "../../src/infrastructure/sqlite/worktree-operation-store.js";
import { AuthorizedToolExecutor } from "../../src/tool-permissions.js";
import { defineTool } from "../../src/tools.js";
import { finalTurn, providerFromTurnFactory, toolCallTurn } from "./provider.js";

/** A controlled model with real application, persistence, approval and HTTP paths. */
export async function createAsyncSubAgentFixture(options: {
  readonly staticDirectory?: string;
  readonly eventLogMaxBytes?: number;
  readonly retentionMs?: number;
} = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "async-sub-agent-http-"));
  const database = openSqliteDatabase(":memory:");
  initializeSqliteSchema(database);
  const store = new SQLiteConversationStore(database);
  const worktreeOperations = new SQLiteWorktreeOperationStore(database);
  const broker = new InMemoryInteractionBroker();
  const steering = new RunSteeringQueue();
  const effects: string[] = [];
  let parentCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const probe = defineTool({
    name: "probe",
    description: "Run one controlled verification step.",
    inputSchema: z.strictObject({ kind: z.enum(["approval", "slow", "parent"]) }),
    async execute(input, context) {
      if (input.kind === "slow") {
        await new Promise<void>((resolve, reject) => {
          const abort = () => { cleanup(); reject(context.signal?.reason); };
          const cleanup = () => context.signal?.removeEventListener("abort", abort);
          context.signal?.addEventListener("abort", abort, { once: true });
          if (context.signal?.aborted) { abort(); return; }
          void gate.then(() => { cleanup(); resolve(); });
        });
      }
      effects.push(input.kind);
      return { evidence: input.kind };
    },
  });
  const provider = providerFromTurnFactory((request) => {
    if (request.systemPrompt.includes("You are a sub agent")) {
      const task = request.transcript[0];
      const kind = task?.role === "user" && task.content.includes("approval") ? "approval" : "slow";
      return request.transcript.some((message) => message.role === "tool")
        ? finalTurn(`${kind} evidence`)
        : toolCallTurn("probe", { kind });
    }
    parentCalls += 1;
    if (request.transcript.length === 1) {
      const delegate = (kind: "approval" | "slow") => ({
        callId: `delegate-${kind}`, name: "agent",
        arguments: JSON.stringify({ description: kind === "approval" ? "审批子任务" : "独立子任务", task: kind }),
      });
      return { type: "tool_calls", calls: [delegate("approval"), delegate("slow")] };
    }
    const reports = request.transcript.filter((message) => message.role === "user" && "source" in message);
    if (reports.length === 2) return finalTurn("已收到两个子任务的结果：审批子任务已停止，独立子任务已完成。");
    const steered = request.transcript.some((message) => message.role === "user" && !("source" in message) && message.content === "处理追加要求");
    const handled = request.transcript.some((message) => message.role === "assistant" && message.content === null && message.toolCalls.some((call) => call.name === "probe"));
    if (steered && !handled) return toolCallTurn("probe", { kind: "parent" }, "parent-independent-step");
    return toolCallTurn("wait_agent", {}, `wait-${parentCalls}`);
  }, { contextWindowTokens: 64_000, maxOutputTokens: 4_000 });
  const executor = new AuthorizedToolExecutor({
    interactionBroker: broker,
    policy: {
      isVisible: () => true,
      evaluate: (tool) => tool.name === "probe" && (tool.input as { kind?: string }).kind === "approval"
        ? { effect: "confirm", ruleId: "fixture-approval", reason: "Approve the child verification step." }
        : { effect: "allow", ruleId: "fixture-allow" },
    },
  });
  const workspaceRuntimeProvider = {
    async get(root: string, executionMode: "workspace_sandbox" | "full_access") {
      return { workspaceRoot: root, executionMode, sandboxRunner: new HostSandboxRunner(), tools: [probe] };
    },
  };
  const conversationService = new ConversationService(store);
  const projectServices = createProjectServices({
    conversationStore: store,
    workspaceRuntimeProvider,
    worktreeOperations,
  });
  const conversationOpenService = projectServices.createOpenService(conversationService);
  const hostDirectoryPicker = {
    async pickDirectory() {
      return { status: "selected" as const, path: workspaceRoot };
    },
  };
  const workspaceProjectsRoutes = new WorkspaceProjectsRoutes({
    conversationService,
    conversationOpenService,
    selectionTokens: projectServices.selectionTokens,
    projectInspection: projectServices.projectInspection,
    git: projectServices.git,
    hostDirectoryPicker,
    fullAccessAvailable: true,
  });
  const runService = new ConversationRunService({
    provider, conversationStore: store, authorizedToolExecutor: executor,
    workspaceRuntimeProvider, loadWorkspaceInstructions: async () => undefined,
    steeringSource: (runId) => ({
      take: async (step) => steering.take(runId, step),
      hasPending: () => steering.hasPending(runId),
      onEnqueued: (listener) => steering.onEnqueued(runId, listener),
    }),
  });
  const registry = new RunRegistry({ runService, eventLogMaxBytes: options.eventLogMaxBytes, retentionMs: options.retentionMs });
  const controller = new AgentController({
    conversationService, conversationRunService: runService, registry,
    interactionBroker: broker, steeringQueue: steering,
    getActiveRunId: (id) => store.getActiveRunId(id),
    workspaceProjectsRoutes,
    conversationOpenService,
    fullAccessAvailable: true,
    ...(options.staticDirectory === undefined ? {} : { staticDirectory: options.staticDirectory }),
  });
  const server = createAgentServer(controller);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP server.");
  return {
    server, store, registry, broker, effects, workspaceRoot,
    origin: `http://127.0.0.1:${address.port}`,
    parentCalls: () => parentCalls,
    release,
    async close() {
      release();
      await registry.cancelAll("Test finished.");
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      store.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}
