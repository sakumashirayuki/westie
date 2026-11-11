// 单个父 Run 的子任务协调器：登记、并发限制、结果队列、等待通知、单任务取消与
// 统一收尾。它不碰数据库、不建进程级注册表，持久化通过 `persist` 回调交给应用层。

import {
  AgentEventFactory,
  type AgentEvent,
} from "./agent-events.js";
import type { AgentContextBuilder } from "./agent-loop.js";
import { MAX_ACTIVE_SUB_AGENTS } from "./protocol.js";
import type { LlmProvider } from "./provider-protocol.js";
import type {
  AuthorizedToolExecutor,
  ToolPermissionContext,
} from "./tool-permissions.js";
import type { Tool } from "./tools.js";
import { ToolExecutionError } from "./tools.js";
import type { RunUsageLog } from "./run-usage.js";
import {
  startSubAgent,
  type RunningSubAgent,
  type SubAgentFinish,
  type SubAgentRunRecord,
  type SubAgentStatus,
} from "./sub-agent-runner.js";
import type {
  SubAgentRunControl,
  SubAgentResult,
  SubAgentWaitReason as WaitReason,
} from "./sub-agent-run-control.js";

export type { SubAgentResult, SubAgentWaitReason as WaitReason } from "./sub-agent-run-control.js";

/** 停止子任务的原因；用户直接停止记为 user_request，父 Agent 判断不再需要记为 no_longer_needed。 */
export type ChildCancelReason =
  | "user_request"
  | "no_longer_needed"
  | "parent_cancelled"
  | "parent_failed"
  | "parent_step_limit";

export interface SubAgentCoordinatorOptions {
  readonly provider: LlmProvider;
  readonly tools: readonly Tool[];
  readonly systemPrompt: string;
  readonly authorizedToolExecutor: AuthorizedToolExecutor;
  readonly toolPermissionContext: Omit<ToolPermissionContext, "runId">;
  readonly createContextBuilder?: (
    runId: string,
    usageLog: RunUsageLog,
  ) => AgentContextBuilder;
  /** 父 Run 的事件工厂，与父循环共享，用于等待及停止控制事件。 */
  readonly eventFactory: AgentEventFactory;
  readonly usageLog: RunUsageLog;
  /** 应用层保存一个结束的子 Run 及其用量；抛错视为父 Run 的基础设施故障。 */
  readonly persist: (finish: SubAgentFinish) => void;
  /** 父 Run 是否有尚未读走的真实 steering；等待条件的一部分。 */
  readonly pendingSteering?: () => boolean;
}

export interface SubAgentStartInput {
  readonly description: string;
  readonly task: string;
  readonly toolCallId: string;
}

export class SubAgentCoordinator implements SubAgentRunControl {
  readonly #options: SubAgentCoordinatorOptions;
  /** 父 Run 的原始事件编号；子 Run 使用各自的事件工厂。 */
  readonly eventFactory: AgentEventFactory;
  /** 收尾（子任务全部结束、事件源关闭）后 resolve。 */
  readonly closed: Promise<void>;
  readonly #children = new Map<string, RunningSubAgent>();
  readonly #finished = new Map<string, SubAgentResult>();
  /** 子任务事件的展示出口；由事件合流器注册。 */
  readonly #sinks = new Set<(event: DisplayEvent) => void>();
  #ready: SubAgentResult[] = [];
  #delivered = new Set<string>();
  #failure: unknown;
  #closed = false;
  #parentEnding = false;
  #waiters = new Set<() => void>();

  #resolveClosed: (() => void) | undefined;

  constructor(options: SubAgentCoordinatorOptions) {
    this.#options = options;
    this.eventFactory = options.eventFactory;
    this.closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  /** 注册子任务事件出口（UI 展示）。运行期间可随时加入或移除。 */
  addEventSink(sink: (event: DisplayEvent) => void): () => void {
    this.#sinks.add(sink);
    return () => this.#sinks.delete(sink);
  }

  start(input: SubAgentStartInput): { runId: string; status: "started" } {
    if (this.#parentEnding || this.#closed) {
      throw new ToolExecutionError(
        "SUB_AGENT_PARENT_ENDING",
        "The parent run is finishing and no longer accepts new sub agents.",
      );
    }
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#activeCount() >= MAX_ACTIVE_SUB_AGENTS) {
      throw new ToolExecutionError(
        "SUB_AGENT_LIMIT_REACHED",
        `At most ${MAX_ACTIVE_SUB_AGENTS} sub agents may be active at once; ` +
          "finish or stop one before delegating again.",
      );
    }
    const child = startSubAgent({
      provider: this.#options.provider,
      tools: this.#options.tools,
      systemPrompt: this.#options.systemPrompt,
      toolCallId: input.toolCallId,
      description: input.description,
      task: input.task,
      authorizedToolExecutor: this.#options.authorizedToolExecutor,
      toolPermissionContext: this.#options.toolPermissionContext,
      ...(this.#options.createContextBuilder === undefined
        ? {}
        : { createContextBuilder: this.#options.createContextBuilder }),
      parentUsageLog: this.#options.usageLog,
      // 后台 child 不受本次工具调用的局部控制器影响，只随 `close()` 取消。
      signal: new AbortController().signal,
      onEvent: (event) => {
        this.#publish({ kind: "child_event", child, event });
      },
      persist: (finish) => {
        this.#options.persist(finish);
      },
    });
    this.#children.set(child.runId, child);
    this.#publish({ kind: "child_started", child });
    void child.finished.then(
      (record) => this.#settle(child, record),
      (error: unknown) => {
        this.#children.delete(child.runId);
        this.#finished.set(child.runId, { runId: child.runId, toolCallId: child.toolCallId, description: child.description, status: "failed", error: { code: "SUB_AGENT_SAVE_FAILED", message: "子任务结果保存失败。" } });
        this.#fail(error);
      },
    );
    return { runId: child.runId, status: "started" };
  }

  /** 接受停止请求：立即返回 `stopping`，实际结束前仍占一个活跃名额。 */
  requestStop(
    runId: string,
    reason: ChildCancelReason,
    note?: string,
  ): { runId: string; status: "stopping" | SubAgentStatus } {
    const finished = this.#finished.get(runId);
    if (finished !== undefined) return { runId, status: finished.status };
    const child = this.#children.get(runId);
    if (child === undefined) {
      throw new ToolExecutionError(
        "SUB_AGENT_NOT_FOUND",
        `Sub agent ${runId} does not belong to this run.`,
      );
    }
    if (child.status === "stopping") return { runId, status: "stopping" };
    child.requestStop(reason, note);
    this.#publish({ kind: "child_stopping", child, reason: note ?? reason });
    this.#notify();
    return { runId, status: "stopping" };
  }

  hasActive(): boolean {
    return this.#activeCount() > 0;
  }

  /** 当前活跃（执行中或正在停止）的子任务，供 Web 与 Registry 投影。 */
  activeChildren(): readonly {
    readonly runId: string;
    readonly toolCallId: string;
    readonly description: string;
    readonly status: "running" | "stopping";
  }[] {
    return [...this.#children.values()].map((child) => ({
      runId: child.runId,
      toolCallId: child.toolCallId,
      description: child.description,
      status: child.status,
    }));
  }

  snapshotChildren(): readonly (SubAgentResult | {
    readonly runId: string;
    readonly toolCallId: string;
    readonly description: string;
    readonly status: "running" | "stopping";
  })[] {
    return [...this.#finished.values(), ...this.activeChildren()];
  }

  hasReady(): boolean {
    return this.#ready.length > 0;
  }

  /** 取走所有已经结束并保存成功的报告；每个终态只交付一次。 */
  takeReady(): readonly SubAgentResult[] {
    const ready = this.#ready;
    this.#ready = [];
    return ready;
  }

  throwIfFailed(): void {
    if (this.#failure !== undefined) throw this.#failure;
  }

  /**
   * 等待子结果、steering 或「没有活跃子任务」。先注册通知再同步检查条件，避免
   * 检查和休眠之间丢唤醒；`wake` 由 steering 入队和有结果就绪时调用。
   */
  async waitForReadyOrSteering(
    subscribeSteering: (listener: () => void) => () => void,
    signal?: AbortSignal,
  ): Promise<WaitReason> {
    for (;;) {
      signal?.throwIfAborted();
      if (this.#failure !== undefined) throw this.#failure;
      const found = this.#check();
      if (found !== undefined) return found;
      await new Promise<void>((resolve) => {
        let settled = false;
        let release = (): void => {};
        const finish = (): void => {
          if (settled) return;
          settled = true;
          this.#waiters.delete(finish);
          release();
          removeAbort();
          resolve();
        };
        const removeAbort = (): void => {
          signal?.removeEventListener("abort", finish);
        };
        // 先注册通知，再同步检查条件：检查和休眠之间到达的唤醒不会丢。
        release = subscribeSteering(finish);
        this.#waiters.add(finish);
        signal?.addEventListener("abort", finish, { once: true });
        if (
          this.#failure !== undefined ||
          this.#check() !== undefined ||
          signal?.aborted === true
        ) {
          finish();
        }
      });
    }
  }

  /** 通知等待者重新检查条件，用于 steering 入队。 */
  notify(): void {
    this.#notify();
  }

  markWaiting(toolCallId: string): void {
    if (this.#failure === undefined && this.#check() === undefined) {
      this.#publish({ kind: "parent_waiting", toolCallId });
    }
  }

  /**
   * 关闭子任务入口并收尾：取消全部活跃任务，等它们执行与保存结束。任一保存失败
   * 记录为父 Run 的基础设施故障。
   */
  async close(reason: ChildCancelReason): Promise<void> {
    this.#parentEnding = true;
    const pending = [...this.#children.values()];
    for (const child of pending) {
      if (child.status === "running") child.requestStop(reason);
    }
    const outcomes = await Promise.allSettled(
      pending.map((child) => child.finished),
    );
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    this.#children.clear();
    this.#closed = true;
    this.#resolveClosed?.();
    this.#notify();
    if (failure?.status === "rejected") {
      this.#failure = this.#failure ?? failure.reason;
      throw failure.reason;
    }
  }

  /** 释放执行器、监听器与子 transcript 引用；幂等，用于兜底。 */
  release(): void {
    this.#closed = true;
    this.#parentEnding = true;
    this.#sinks.clear();
    this.#ready = [];
    this.#finished.clear();
    this.#delivered.clear();
    this.#resolveClosed?.();
    this.#notify();
  }

  #check(): WaitReason | undefined {
    if (this.#steeringPending()) return "steering";
    if (this.#ready.length > 0) return "child_result";
    if (this.#activeCount() === 0) return "no_active_children";
    return undefined;
  }

  #activeCount(): number {
    return this.#children.size;
  }

  #steeringPending(): boolean {
    return this.#options.pendingSteering?.() ?? false;
  }

  #settle(child: RunningSubAgent, record: SubAgentRunRecord): void {
    this.#children.delete(child.runId);
    this.#finished.set(child.runId, {
      runId: record.runId,
      toolCallId: record.toolCallId,
      description: record.description,
      status: record.status,
      ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }),
      ...(record.finalAnswer === undefined ? {} : { answer: record.finalAnswer }),
      ...(record.error === undefined ? {} : { error: record.error }),
    });
    if (this.#delivered.has(child.runId)) return;
    this.#delivered.add(child.runId);
    this.#ready.push(this.#toResult(child, record));
    this.#notify();
  }

  #fail(error: unknown): void {
    this.#failure = this.#failure ?? error;
    this.#notify();
  }

  #notify(): void {
    for (const waiter of [...this.#waiters]) {
      this.#waiters.delete(waiter);
      waiter();
    }
  }

  #toResult(
    child: RunningSubAgent,
    record: SubAgentRunRecord,
  ): SubAgentResult {
    const base = {
      runId: record.runId,
      toolCallId: child.toolCallId,
      description: record.description,
      status: record.status,
      ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }),
    };
    if (record.status === "completed") {
      return { ...base, answer: record.finalAnswer ?? "" };
    }
    return {
      ...base,
      error: record.error ?? {
        code: record.status === "cancelled"
          ? "SUB_AGENT_CANCELLED"
          : "SUB_AGENT_FAILED",
        message: child.cancelReason ?? record.internalError ??
          "The sub agent ended before producing an answer.",
      },
    };
  }

  #publish(event: DisplayEvent): void {
    for (const sink of [...this.#sinks]) sink(event);
  }
}

export type DisplayEvent =
  | { readonly kind: "parent_waiting"; readonly toolCallId: string }
  | { readonly kind: "child_started"; readonly child: RunningSubAgent }
  | { readonly kind: "child_event"; readonly child: RunningSubAgent; readonly event: AgentEvent }
  | { readonly kind: "child_stopping"; readonly child: RunningSubAgent; readonly reason: string };
