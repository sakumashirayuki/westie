import { randomUUID } from "node:crypto";
import type { RunEventSource } from "../run-stream.js";

import {
  AgentEventType,
} from "../agent-events.js";
import {
  formatInternalError,
  streamAgentRun,
  type SteeringSource,
} from "../agent-loop.js";
import { publicRunError } from "../agent-run-errors.js";
import { mergeAgentEvents } from "../agent-event-stream.js";
import {
  SubAgentCoordinator,
} from "../sub-agent-coordinator.js";
import type { LlmProvider } from "../provider-protocol.js";
import { RunUsageLog } from "../run-usage.js";
import {
  allowAllToolPermissionPolicy,
  AuthorizedToolExecutor,
} from "../tool-permissions.js";
import type { ToolGrantStore } from "./tool-grant-store.js";
import type {
  BegunConversationRun,
  ConversationStore,
} from "./conversation-store.js";
import { ContextBuilder } from "./context-builder.js";
import { createAgentRun } from "../agent-run.js";
import type { WorkspaceRuntimeProvider } from "./workspace-runtime.js";
import { assembleSystemPrompt } from "../system-prompt.js";
import type { WorkspaceSkillRegistry } from "../infrastructure/workspace-skills.js";
import { createSkillTool } from "../tools/skill.js";
import { createSubAgentTools } from "../tools/sub-agents.js";
import type { Tool } from "../tools.js";
import type { RunContextCompaction } from "./conversation-store.js";
import type { TranscriptMessage } from "../transcript.js";
import { createCommandStopHook } from "./command-stop-hook.js";
import type { StopHook } from "../stop-hook.js";
import type { RunStartedData } from "../agent-events.js";
import type { RunMemory } from "../infrastructure/run-memory.js";
import { createMemoryTool } from "../tools/memory.js";

export interface StartConversationRunCommand {
  readonly conversationId: string;
  readonly input: string;
  readonly maxSteps?: number;
  readonly signal?: AbortSignal;
}

/**
 * 父 Run 的运行态控制句柄：Registry 用它停止子任务、等待收尾，并把实时状态投影成
 * 重连时使用的最小快照。
 */
export interface SubAgentRunHandle {
  readonly runId: string;
  cancelChild(
    runId: string,
    reason: "user_request",
  ): { readonly runId: string; readonly status: string };
  activeChildren(): readonly LiveSubAgentView[];
  snapshotChildren(): readonly (LiveSubAgentView | import("../sub-agent-coordinator.js").SubAgentResult)[];
  hasActiveChildren(): boolean;
  /** 等父 Run 的收尾完成（子任务全部结束、事件源关闭）。 */
  finished(): Promise<void>;
}

export interface LiveSubAgentView {
  readonly runId: string;
  readonly toolCallId: string;
  readonly description: string;
  readonly status: "running" | "stopping";
}

export interface StartedConversationRun {
  readonly runId: string;
  readonly events: AsyncIterable<RunEventSource>;
  /** 子任务控制句柄；父 Run 结束（或本进程没有子任务能力）时为 undefined。 */
  readonly subAgents?: SubAgentRunHandle;
}

export interface ConversationRunServiceOptions {
  readonly provider: LlmProvider;
  readonly conversationStore: ConversationStore;
  readonly authorizedToolExecutor?: AuthorizedToolExecutor;
  readonly workspaceRuntimeProvider: WorkspaceRuntimeProvider;
  readonly loadWorkspaceInstructions: (
    canonicalWorkspaceRoot: string,
  ) => Promise<string | undefined>;
  readonly discoverWorkspaceSkills?: (
    canonicalWorkspaceRoot: string,
  ) => Promise<WorkspaceSkillRegistry>;
  /** 每个主 Run 开始时读取一次项目级完成检查配置；省略时所有 Run 都不检查。 */
  readonly loadStopHookConfig?: (
    canonicalWorkspaceRoot: string,
  ) => Promise<
    | {
        readonly command: string;
        readonly timeoutMs: number;
        readonly maxContinuations: number;
      }
    | undefined
  >;
  readonly bytesPerToken?: number;
  readonly summaryBudgetRatio?: number;
  readonly compactionRecentPairs?: number;
  readonly steeringSource?: (runId: string) => SteeringSource;
  readonly toolGrantStore?: ToolGrantStore;
  /**
   * 每个 Run 开始时拉取本 workspace 的 MCP 工具（已包成 Tool，名字互不重复）；
   * 返回 undefined 表示没有 MCP 工具。抛出错误时 Run 照常跑，只是没有 MCP 工具。
   */
  readonly acquireMcpTools?: (
    canonicalWorkspaceRoot: string,
  ) => Promise<{ readonly tools: readonly Tool[] } | undefined>;
  /**
   * 每个父 Run 开始时读取一次项目记忆快照；省略时没有记忆区块也不注册 memory 工具。
   * 记忆不可用时由返回值表达状态，不抛错。
   */
  readonly loadMemory?: (
    begunRun: BegunConversationRun,
    signal?: AbortSignal,
  ) => Promise<RunMemory>;
}

export class ConversationRunService {
  constructor(private readonly options: ConversationRunServiceOptions) {}

  startRun(
    command: StartConversationRunCommand,
  ): StartedConversationRun {
    const runId = randomUUID();
    const begunRun = this.options.conversationStore.beginRun(
      command.conversationId,
      command.input,
      runId,
    );
    const prepared = this.#prepareRun(command, runId, begunRun);

    return {
      runId,
      events: prepared.events,
      subAgents: prepared.handle,
    };
  }

  /**
   * 准备一次 Run：装配工具与协调器，返回事件流和子任务控制句柄。装配阶段的错误
   * （工作区、prompt、权限上下文）立即抛出，由调用方落库失败终态。
   */
  #prepareRun(
    command: StartConversationRunCommand,
    runId: string,
    begunRun: BegunConversationRun,
  ): {
    readonly events: AsyncIterable<RunEventSource>;
    readonly handle: SubAgentRunHandle;
  } {
    const run = this.#openRun(command, runId, begunRun);
    return {
      events: run.events,
      handle: {
        runId,
        cancelChild: (childRunId, reason) => {
          const coordinator = run.coordinatorRef.current;
          if (coordinator === undefined) {
            return { runId: childRunId, status: "starting" };
          }
          return coordinator.requestStop(childRunId, reason);
        },
        activeChildren: () =>
          run.coordinatorRef.current?.activeChildren().map((child) => ({ ...child })) ?? [],
        snapshotChildren: () => run.coordinatorRef.current?.snapshotChildren() ?? [],
        hasActiveChildren: () => run.coordinatorRef.current?.hasActive() ?? false,
        finished: () => run.finished,
      },
    };
  }

  async *#runEvents(
    command: StartConversationRunCommand,
    runId: string,
    begunRun: BegunConversationRun,
    coordinatorRef: { current?: SubAgentCoordinator },
    resolveFinished: () => void,
  ): AsyncIterable<RunEventSource> {
    let storeTerminal = false;
    let terminalError: unknown;
    let coordinator: SubAgentCoordinator | undefined;
    try {
      const initialTranscript = this.options.conversationStore
        .loadConversationTranscript(begunRun.conversationId);
      const runtime = await this.#getWorkspaceRuntime(begunRun);
      const [
        workspaceInstructions,
        workspaceSkills,
        mcpResult,
        stopHookConfig,
        memory,
      ] = await Promise.all([
        this.options.loadWorkspaceInstructions(runtime.workspaceRoot),
        this.options.discoverWorkspaceSkills?.(runtime.workspaceRoot),
        this.#acquireMcpTools(runtime.workspaceRoot),
        this.#loadStopHookConfig(runtime.workspaceRoot),
        this.#loadMemory(begunRun, command.signal),
      ]);
      const promptInput = {
        workspaceRoot: runtime.workspaceRoot,
        workspaceInstructions,
        workspaceSkillsCatalog: workspaceSkills?.catalog,
      };
      const hasMcpTools = mcpResult !== undefined && mcpResult.tools.length > 0;
      const memoryBlock = memoryBlockFor(memory);
      const systemPrompt = assembleSystemPrompt({
        ...promptInput,
        subAgent: "parent",
        hasMcpTools,
        ...(stopHookConfig === undefined ? {} : { stopHook: true }),
        ...(memoryBlock === undefined ? {} : { memory: memoryBlock }),
      });
      // 子 Run 不跑完成检查，它的 system prompt 不含检查反馈段落。
      const childSystemPrompt = assembleSystemPrompt({
        ...promptInput,
        subAgent: "child",
        hasMcpTools,
      });
      this.options.conversationStore.recordRunSystemPrompt(
        begunRun.conversationId,
        begunRun.turnId,
        begunRun.runId,
        systemPrompt,
      );
      const run = createAgentRun({
        runId: begunRun.runId,
        usageOptions: {
          onInvalid: (call) => {
            process.stderr.write(`${JSON.stringify({
              event: "usage.invalid",
              runId: begunRun.runId,
              kind: call.kind,
              ...(call.step === undefined ? {} : { step: call.step }),
              model: call.model,
            })}\n`);
          },
        },
      });
      const usageLog = run.usageLog;
      const contextBuilder = this.#createContextBuilder(
        begunRun.runId,
        usageLog,
        this.options.conversationStore
          .loadConversationCompactions(begunRun.conversationId),
      );
      const baseTools = [...runtime.tools];
      if (workspaceSkills !== undefined && workspaceSkills.skills.length > 0) {
        baseTools.push(createSkillTool(workspaceSkills));
      }
      if (hasMcpTools) baseTools.push(...mcpResult.tools);
      const toolPermissionContext = {
        workspaceRoot: runtime.workspaceRoot,
        executionMode: begunRun.executionMode,
        conversationId: command.conversationId,
      };
      const authorizedToolExecutor = this.options.authorizedToolExecutor ??
        new AuthorizedToolExecutor({ policy: allowAllToolPermissionPolicy });
      const steeringSource = this.options.steeringSource?.(runId);
      const stopHook = stopHookConfig === undefined
        ? undefined
        : this.#createStopHook(
          stopHookConfig,
          runtime,
          begunRun,
          command,
          run,
        );
      coordinator = new SubAgentCoordinator({
        eventFactory: run.eventFactory,
        provider: this.options.provider,
        tools: baseTools,
        systemPrompt: childSystemPrompt,
        authorizedToolExecutor,
        toolPermissionContext,
        createContextBuilder: (childRunId, childUsage) =>
          this.#createContextBuilder(childRunId, childUsage, []),
        usageLog,
        persist: (finish) => {
          this.options.conversationStore.appendSubAgentRun(
            {
              id: finish.record.runId,
              parentRunId: begunRun.runId,
              toolCallId: finish.record.toolCallId,
              description: finish.record.description,
              status: finish.record.status,
              ...(finish.record.stopReason === undefined
                ? {}
                : { stopReason: finish.record.stopReason }),
              ...(finish.record.finalAnswer === undefined
                ? {}
                : { finalAnswer: finish.record.finalAnswer }),
              ...(finish.record.error === undefined
                ? {}
                : {
                    errorCode: finish.record.error.code,
                    errorMessage: finish.record.error.message,
                  }),
              ...(finish.record.internalError === undefined
                ? {}
                : { internalError: finish.record.internalError }),
              systemPrompt: finish.record.systemPrompt,
              transcript: finish.record.transcript,
              createdAt: finish.record.createdAt,
            },
            {
              modelCalls: finish.modelCalls,
            },
          );
        },
        pendingSteering: () => steeringSource?.hasPending?.() ?? false,
      });
      coordinatorRef.current = coordinator;
      // 子 Agent 使用 baseTools：不获得 memory 工具，也不加载项目记忆。
      const tools: Tool[] = [
        ...baseTools,
        ...(memory?.store === undefined
          ? []
          : [createMemoryTool(memory.store)]),
        ...createSubAgentTools({
          coordinator,
          onSteeringEnqueued: (listener) =>
            steeringSource?.onEnqueued?.(listener) ?? (() => {}),
        }),
      ];
      const events = streamAgentRun({
        transcript: initialTranscript,
        systemPrompt,
        provider: this.options.provider,
        maxSteps: command.maxSteps,
        run,
        signal: command.signal,
        toolEnvironment: {
          tools,
          executor: authorizedToolExecutor,
          permissionContext: toolPermissionContext,
        },
        ...(steeringSource === undefined ? {} : { steeringSource }),
        ...(stopHook === undefined ? {} : { stopHook }),
        ...runStartedDataOption(memory),
        subAgents: coordinator,
        contextBuilder,
        lifecycle: {
          beforeCompleted: ({ answer, transcript }) => {
            this.options.conversationStore.appendRunMessages(
              begunRun.conversationId,
              begunRun.turnId,
              begunRun.runId,
              appendedMessages(initialTranscript, transcript),
              {
                status: "completed",
                finalAnswer: answer,
                contextCompactions: contextBuilder.compactions,
                modelCalls: usageLog.calls,
              },
            );
            storeTerminal = true;
          },
          beforeFailed: ({ cancelled, error, internalError, transcript }) => {
            this.options.conversationStore.appendRunMessages(
              begunRun.conversationId,
              begunRun.turnId,
              begunRun.runId,
              appendedMessages(initialTranscript, transcript),
              {
                status: cancelled ? "cancelled" : "failed",
                ...(error === undefined
                  ? {}
                  : {
                      errorCode: error.code,
                      errorMessage: error.message,
                    }),
                internalError,
                contextCompactions: contextBuilder.compactions,
                modelCalls: usageLog.calls,
              },
            );
            storeTerminal = true;
          },
        },
      });

      for await (const source of mergeAgentEvents({
        parentEvents: events,
        coordinator,
        eventFactory: coordinator.eventFactory,
      })) {
        const { event } = source;
        if (
          source.subAgent === undefined && event.type === AgentEventType.RunError &&
          !storeTerminal
        ) {
          this.options.conversationStore.appendRunMessages(
            begunRun.conversationId,
            begunRun.turnId,
            begunRun.runId,
            [],
            { status: "failed" },
          );
          storeTerminal = true;
        }
        yield source;
      }
    } catch (error) {
      terminalError = error;
      throw error;
    } finally {
      if (coordinator !== undefined) {
        await coordinator.close(
          command.signal?.aborted === true ? "parent_cancelled" : "parent_failed",
        ).catch(() => {});
        coordinator.release();
      }
      if (!storeTerminal) {
        const cancelled = command.signal?.aborted === true;
        // 装配阶段失败也走公开错误映射；没有具体错误时才用通用文案。
        const publicError = terminalError === undefined
          ? { code: "AGENT_RUN_FAILED", message: "Agent run failed before execution started." }
          : publicRunError(terminalError);
        this.options.conversationStore.appendRunMessages(
          begunRun.conversationId,
          begunRun.turnId,
          begunRun.runId,
          [],
          {
            status: cancelled ? "cancelled" : "failed",
            ...(cancelled
              ? {}
              : {
                  errorCode: publicError.code,
                  errorMessage: publicError.message,
                }),
            ...(terminalError === undefined
              ? {}
              : { internalError: formatInternalError(terminalError) }),
          },
        );
      }
      resolveFinished();
    }
  }

  /**
   * 打开一次 Run：装配 workspace runtime、工具、协调器与父循环，并把两条事件来源
   * 合成一条订阅来源流。组装阶段同步返回，异步初始化（runtime、MCP）在事件流内部完成。
   */
  #openRun(
    command: StartConversationRunCommand,
    runId: string,
    begunRun: BegunConversationRun,
  ): {
    readonly events: AsyncIterable<RunEventSource>;
    readonly coordinatorRef: { current?: SubAgentCoordinator };
    readonly finished: Promise<void>;
  } {
    const coordinatorRef: { current?: SubAgentCoordinator } = {};
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const events = this.#runEvents(
      command,
      runId,
      begunRun,
      coordinatorRef,
      resolveFinished,
    );
    return { events, coordinatorRef, finished };
  }

  /** 子任务协调器的收尾完成 Promise，供 Registry 等待。 */
  async #acquireMcpTools(
    workspaceRoot: string,
  ): Promise<{ readonly tools: readonly Tool[] } | undefined> {
    if (this.options.acquireMcpTools === undefined) return undefined;
    try {
      return await this.options.acquireMcpTools(workspaceRoot);
    } catch {
      // acquireMcpTools 自己抛错时 Run 照常跑，只是没有 MCP 工具。
      return undefined;
    }
  }

  #loadStopHookConfig(
    workspaceRoot: string,
  ): ReturnType<NonNullable<ConversationRunServiceOptions["loadStopHookConfig"]>> {
    // 配置非法时让错误冒到 Run 装配阶段，本轮以 STOP_HOOK_CONFIG_INVALID 失败。
    return this.options.loadStopHookConfig?.(workspaceRoot) ??
      Promise.resolve(undefined);
  }

  #loadMemory(
    begunRun: BegunConversationRun,
    signal: AbortSignal | undefined,
  ): Promise<RunMemory | undefined> {
    return this.options.loadMemory?.(begunRun, signal) ??
      Promise.resolve(undefined);
  }

  #createStopHook(
    config: {
      readonly command: string;
      readonly timeoutMs: number;
      readonly maxContinuations: number;
    },
    runtime: Awaited<ReturnType<WorkspaceRuntimeProvider["get"]>>,
    begunRun: BegunConversationRun,
    command: StartConversationRunCommand,
    run: ReturnType<typeof createAgentRun>,
  ): StopHook {
    return createCommandStopHook({
      command: config.command,
      timeoutMs: config.timeoutMs,
      maxContinuations: config.maxContinuations,
      workspaceRoot: runtime.workspaceRoot,
      executionMode: begunRun.executionMode,
      conversationId: begunRun.conversationId,
      runId: begunRun.runId,
      input: command.input,
      sandboxRunner: runtime.sandboxRunner,
      eventFactory: run.eventFactory,
      authorizedToolExecutor: this.options.authorizedToolExecutor ??
        new AuthorizedToolExecutor({ policy: allowAllToolPermissionPolicy }),
      toolPermissionContext: {
        workspaceRoot: runtime.workspaceRoot,
        executionMode: begunRun.executionMode,
        conversationId: begunRun.conversationId,
      },
    });
  }

  #createContextBuilder(
    runId: string,
    usageLog: RunUsageLog,
    initialCompactions: readonly RunContextCompaction[],
  ): ContextBuilder {
    return new ContextBuilder({
      provider: this.options.provider,
      runId,
      usageLog,
      initialCompactions,
      onRequestEstimate: (report) => {
        process.stderr.write(`${JSON.stringify({
          event: "context.request_estimate",
          ...report,
        })}\n`);
      },
      ...(this.options.bytesPerToken === undefined
        ? {}
        : { bytesPerToken: this.options.bytesPerToken }),
      ...(this.options.summaryBudgetRatio === undefined
        ? {}
        : { summaryBudgetRatio: this.options.summaryBudgetRatio }),
      ...(this.options.compactionRecentPairs === undefined
        ? {}
        : { compactionRecentPairs: this.options.compactionRecentPairs }),
    });
  }

  async #getWorkspaceRuntime(
    begunRun: BegunConversationRun,
  ) {
      const runtime = await this.options.workspaceRuntimeProvider.get(
        begunRun.workspaceRoot,
        begunRun.executionMode,
      );
    if (runtime.workspaceRoot !== begunRun.workspaceRoot) {
      throw new Error(
        "Conversation workspace does not match the resolved runtime.",
      );
    }
    if (runtime.executionMode !== begunRun.executionMode) {
      throw new Error(
        "Conversation execution mode does not match the resolved runtime.",
      );
    }
    return runtime;
  }
}

/** 记忆索引进入 system prompt 的区块；不可用时不写区块。 */
function memoryBlockFor(
  memory: RunMemory | undefined,
): { readonly index: string; readonly nextLine: number | null } | undefined {
  if (memory === undefined) return undefined;
  if (memory.status.status === "unavailable") return undefined;
  return { index: memory.index, nextLine: memory.nextLine };
}

/** `run.started` 携带的记忆状态；没有记忆能力时保持旧空 data。 */
function runStartedDataOption(
  memory: RunMemory | undefined,
): { readonly runStartedData?: RunStartedData } {
  return memory === undefined ? {} : { runStartedData: { memory: memory.status } };
}

function appendedMessages(
  initialTranscript: readonly TranscriptMessage[],
  finalTranscript: readonly TranscriptMessage[],
): readonly TranscriptMessage[] {
  return finalTranscript.slice(initialTranscript.length);
}
