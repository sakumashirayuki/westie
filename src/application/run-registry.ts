import { AgentEventType, type AgentEvent, type RunSnapshotData } from "../agent-events.js";
import type { StartedConversationRun, SubAgentRunHandle } from "./conversation-run-service.js";
import {
  RunEventLog,
  RunEventLogTruncatedError,
} from "./run-event-log.js";
import { RunSnapshotProjection } from "./run-snapshot.js";
import { ToolExecutionError } from "../tools.js";
import { publicRunError } from "../agent-run-errors.js";
import type { RunStreamRecord } from "../run-stream.js";

export interface StartRunCommand {
  readonly conversationId: string;
  readonly input: string;
  readonly maxSteps?: number;
}

export type RunActivityState = "running" | "awaiting_interaction" | "waiting_sub_agents" | "ended";

export interface ActiveRunSnapshot {
  readonly conversationId: string;
  readonly runId: string;
  readonly state: RunActivityState;
  readonly startedAt: string;
}

export interface EndRunStatus {
  readonly status: "completed" | "failed" | "cancelled";
}

export interface RunActivityEvent {
  readonly conversationId: string;
  readonly runId: string;
  readonly state: RunActivityState;
  readonly status?: "completed" | "failed" | "cancelled";
}

interface ActiveRun {
  readonly runId: string;
  readonly conversationId: string;
  readonly controller: AbortController;
  readonly log: RunEventLog;
  readonly startedAt: string;
  readonly done: Promise<void>;
  readonly projection: RunSnapshotProjection;
  readonly subAgents?: SubAgentRunHandle;
  state: RunActivityState;
  endStatus?: EndRunStatus;
}

export type CancelRunResult = "cancelling" | "not_found";

export class RunCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunCancelledError";
  }
}

export const RUN_CANCELLED_BY_REQUEST = "Run cancelled by request.";
export const RUN_CANCELLED_SHUTDOWN = "Agent service is shutting down.";

export interface RunRegistryOptions {
  /** Run 结束事件流之后的保留时长，客户端重连窗口。 */
  readonly retentionMs?: number;
  readonly now?: () => number;
}

export interface RunRegistryDeps {
  readonly runService: {
    startRun(command: {
      readonly conversationId: string;
      readonly input: string;
      readonly maxSteps?: number;
      readonly signal: AbortSignal;
    }): StartedConversationRun;
  };
  readonly retentionMs?: number;
  readonly now?: () => number;
  readonly eventLogMaxBytes?: number;
}

/**
 * Run 由服务端持有：HTTP 连接只是订阅者。registry 是一个进程内单例，持有
 * `Map<runId, ActiveRun>`，可同时持有多个会话的 Run。「一个会话同一时间只有一个
 * Run」由 beginRun 的 active_run_id 条件保证。
 */
export class RunRegistry {
  readonly #runs = new Map<string, ActiveRun>();
  readonly #retentionMs: number;
  readonly #now: () => number;
  readonly #runService: RunRegistryDeps["runService"];
  readonly #eventLogMaxBytes: number | undefined;
  readonly #activityListeners = new Set<(event: RunActivityEvent) => void>();

  constructor(deps: RunRegistryDeps) {
    this.#runService = deps.runService;
    this.#retentionMs = deps.retentionMs ?? 60_000;
    this.#now = deps.now ?? (() => Date.now());
    this.#eventLogMaxBytes = deps.eventLogMaxBytes;
  }

  start(command: StartRunCommand): { runId: string } {
    const controller = new AbortController();
    const log = new RunEventLog(this.#eventLogMaxBytes);
    const startedAt = new Date(this.#now()).toISOString();

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    let startedRun: StartedConversationRun;
    try {
      startedRun = this.#runService.startRun({
        conversationId: command.conversationId,
        input: command.input,
        ...(command.maxSteps === undefined
          ? {}
          : { maxSteps: command.maxSteps }),
        signal: controller.signal,
      });
    } catch (error) {
      resolveDone();
      throw error;
    }

    const runId = startedRun.runId;
    const active: ActiveRun = {
      runId,
      conversationId: command.conversationId,
      controller,
      log,
      startedAt,
      done,
      state: "running",
      projection: new RunSnapshotProjection(),
      subAgents: startedRun.subAgents,
    };
    this.#runs.set(runId, active);
    this.#emit(active);

    this.#pump(active, startedRun, resolveDone);

    return { runId };
  }

  get(runId: string): ActiveRun | undefined {
    return this.#runs.get(runId);
  }

  getByConversation(
    conversationId: string,
    runId: string,
  ): ActiveRun | undefined {
    const active = this.#runs.get(runId);
    return active !== undefined && active.conversationId === conversationId
      ? active
      : undefined;
  }

  cancel(runId: string, reason: string): CancelRunResult {
    const active = this.#runs.get(runId);
    if (active === undefined || active.state === "ended") return "not_found";
    if (!active.controller.signal.aborted) {
      active.controller.abort(new RunCancelledError(reason));
    }
    return "cancelling";
  }

  cancelChild(parentRunId: string, childRunId: string, reason: "user_request" = "user_request"):
    { readonly runId: string; readonly status: string } | "not_found" {
    const active = this.#runs.get(parentRunId);
    if (active?.subAgents === undefined) return "not_found";
    const existing = active.subAgents.snapshotChildren().find((child) => child.runId === childRunId);
    if (existing !== undefined && (existing.status === "completed" || existing.status === "failed" || existing.status === "cancelled")) {
      return { runId: childRunId, status: existing.status };
    }
    try {
      return active.subAgents.cancelChild(childRunId, reason);
    } catch (error) {
      if (error instanceof ToolExecutionError && error.code === "SUB_AGENT_NOT_FOUND") return "not_found";
      throw error;
    }
  }

  async cancelAll(reason: string): Promise<void> {
    for (const active of [...this.#runs.values()]) {
      this.cancel(active.runId, reason);
    }
    await Promise.all([...this.#runs.values()].map((active) => active.done));
  }

  snapshot(): readonly ActiveRunSnapshot[] {
    return [...this.#runs.values()]
      .filter((active) => active.state !== "ended")
      .map((active) => ({
        conversationId: active.conversationId,
        runId: active.runId,
        state: active.state,
        startedAt: active.startedAt,
      }));
  }

  getSnapshot(runId: string): RunSnapshotData | undefined {
    return this.#runs.get(runId)?.projection.snapshot();
  }

  /** 注册全局运行状态变化的监听器，返回取消函数。 */
  onActivity(listener: (event: RunActivityEvent) => void): () => void {
    this.#activityListeners.add(listener);
    return () => this.#activityListeners.delete(listener);
  }

  subscribe(
    runId: string,
    afterSeq: number,
    signal: AbortSignal,
  ): AsyncIterable<RunStreamRecord> {
    const active = this.#runs.get(runId);
    if (active === undefined) {
      throw new RunRegistryRunNotFoundError();
    }
    try {
      return active.log.subscribe(afterSeq, signal);
    } catch (error) {
      if (error instanceof RunEventLogTruncatedError) {
        throw new RunRegistryNotReplayableError();
      }
      throw error;
    }
  }

  /** 在写响应头前检查日志是否可回放；超限抛 RunRegistryNotReplayableError。 */
  assertReplayable(runId: string): void {
    const active = this.#runs.get(runId);
    if (active === undefined) return;
    if (active.log.truncated) {
      throw new RunRegistryNotReplayableError();
    }
  }

  subscribeSnapshot(runId: string, signal: AbortSignal): AsyncIterable<RunStreamRecord> {
    const active = this.#runs.get(runId);
    if (active === undefined) throw new RunRegistryRunNotFoundError();
    const seq = active.log.latestStreamSeq;
    const live = active.log.subscribeLive(seq, signal);
    const snapshot: RunStreamRecord = { streamSeq: seq, snapshot: active.projection.snapshot() };
    return (async function* () {
      const iterator = live[Symbol.asyncIterator]();
      try {
        if (signal.aborted) return;
        yield snapshot;
        while (true) {
          const next = await iterator.next();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        await iterator.return?.();
      }
    })();
  }

  async #pump(
    active: ActiveRun,
    startedRun: StartedConversationRun,
    resolveDone: () => void,
  ): Promise<void> {
    let lastSeq = 0;
    let lastTerminal: AgentEvent | undefined;
    try {
      for await (const source of startedRun.events) {
        const event = source.event;
        if (source.subAgent === undefined) lastSeq = event.seq;
        if (isTerminalEvent(event) && source.subAgent === undefined) lastTerminal = event;
        active.projection.apply(source);
        this.#updateState(active);
        active.log.append(source);
      }
      active.state = "ended";
      active.endStatus = this.#terminalStatus(active, lastTerminal);
      this.#emit(active);
    } catch (error) {
      if (active.controller.signal.aborted) {
        const event: AgentEvent = {
          v: 1,
          runId: active.runId,
          seq: lastSeq + 1,
          type: AgentEventType.RunCancelled,
          data: {},
        };
        active.state = "ended";
        active.endStatus = { status: "cancelled" };
        active.projection.apply({ event });
        active.log.append({ event });
        this.#emit(active);
      } else if (lastTerminal === undefined) {
        // 装配阶段抛出的错误（例如非法的 Stop Hook 配置）也要用同一套公开映射，
        // 客户端才能看到 STOP_HOOK_CONFIG_INVALID 这类可诊断的错误码。
        const event: AgentEvent = {
          v: 1,
          runId: active.runId,
          seq: lastSeq + 1,
          type: AgentEventType.RunError,
          data: publicRunError(error),
        };
        active.state = "ended";
        active.endStatus = { status: "failed" };
        active.projection.apply({ event });
        active.log.append({ event });
        this.#emit(active);
      } else {
        active.state = "ended";
        active.endStatus = this.#terminalStatus(active, lastTerminal);
        this.#emit(active);
      }
    } finally {
      active.log.close();
      resolveDone();
      setTimeout(() => {
        if (this.#runs.get(active.runId) === active) {
          this.#runs.delete(active.runId);
        }
      }, this.#retentionMs + 1).unref();
    }
  }

  #terminalStatus(
    active: ActiveRun,
    lastTerminal: AgentEvent | undefined,
  ): EndRunStatus {
    if (active.endStatus !== undefined) return active.endStatus;
    if (lastTerminal === undefined) return { status: "failed" };
    if (lastTerminal.type === AgentEventType.RunCompleted) {
      return { status: "completed" };
    }
    if (lastTerminal.type === AgentEventType.RunCancelled) {
      return { status: "cancelled" };
    }
    return { status: "failed" };
  }

  #updateState(active: ActiveRun): void {
    if (active.state === "ended") return;
    const snapshot = active.projection.snapshot();
    if (snapshot.status !== "running") {
      active.endStatus = { status: snapshot.status };
      this.#transition(active, "ended");
      return;
    }
    this.#transition(active, snapshot.pendingInteractions.length > 0
      ? "awaiting_interaction"
      : snapshot.waitingForSubAgents ? "waiting_sub_agents" : "running");
  }

  #transition(active: ActiveRun, next: RunActivityState): void {
    if (active.state === next) return;
    active.state = next;
    this.#emit(active);
  }

  #emit(active: ActiveRun): void {
    const event: RunActivityEvent = {
      conversationId: active.conversationId,
      runId: active.runId,
      state: active.state,
      ...(active.state === "ended" && active.endStatus !== undefined
        ? { status: active.endStatus.status }
        : {}),
    };
    for (const listener of [...this.#activityListeners]) {
      listener(event);
    }
  }
}

function isTerminalEvent(event: AgentEvent): boolean {
  return (
    event.type === AgentEventType.RunCompleted ||
    event.type === AgentEventType.RunError ||
    event.type === AgentEventType.RunCancelled
  );
}


export class RunRegistryRunNotFoundError extends Error {
  constructor() {
    super("Run is not registered.");
    this.name = "RunRegistryRunNotFoundError";
  }
}

export class RunRegistryNotReplayableError extends Error {
  constructor() {
    super("Run event log is no longer replayable.");
    this.name = "RunRegistryNotReplayableError";
  }
}
