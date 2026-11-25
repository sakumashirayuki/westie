import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { ExecutionMode } from "../domain/conversation.js";
import type {
  SQLitePersistentServiceStore,
  PersistentServiceRow,
} from "../infrastructure/sqlite/persistent-service-store.js";
import type {
  ServiceLauncher,
  ServiceExit,
} from "../sandbox/service-sandbox-launcher.js";
import { ServiceArtifacts } from "../sandbox/service-artifacts.js";

export const MAX_LIVE_SERVICES_PER_WORKSPACE = 16;
export const SERVICE_START_GRACE_PERIOD_MS = 1_500;
export const SERVICE_STOP_GRACE_PERIOD_MS = 5_000;
export const SERVICE_SHUTDOWN_BUDGET_MS = 10_000;
export const SERVICE_FINAL_LOG_TAIL_BYTES = 4 * 1024;
export const SERVICE_TERMINAL_LIST_LIMIT = 10;
export interface ServiceSnapshot {
  readonly id: string;
  readonly name: string | null;
  readonly command: string;
  readonly cwd: string;
  readonly status: PersistentServiceRow["status"];
  readonly pid: number | null;
  readonly startedAt: string;
  readonly logBytes: number;
  readonly logTail?: string;
  readonly logTruncated: boolean;
  readonly finalLogTail?: string;
  readonly exitCode?: number | null;
  readonly exitSignal?: string | null;
  readonly endedAt?: string | null;
}

export interface ServiceSummary {
  readonly id: string;
  readonly name: string | null;
  readonly command: string;
  readonly cwd: string;
  readonly status: PersistentServiceRow["status"];
  readonly pid: number | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface ServiceLogs {
  readonly id: string;
  readonly status: PersistentServiceRow["status"];
  readonly logBytes: number;
  readonly logTruncated: boolean;
  readonly tail: string;
}

export interface StartServiceCommand {
  readonly command: string;
  readonly name: string | null;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly executionMode: ExecutionMode;
  readonly createdByConversationId: string | null;
  readonly createdByToolCallId: string | null;
}

export interface ServiceProcessManagerOptions {
  readonly store: SQLitePersistentServiceStore;
  readonly launcher: ServiceLauncher;
  readonly artifactsRoot: string;
  readonly now?: () => number;
  readonly startGracePeriodMs?: number;
  readonly stopGracePeriodMs?: number;
  readonly shutdownBudgetMs?: number;
}

interface LiveService {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly artifacts: ServiceArtifacts;
  readonly exit: Promise<ServiceExit>;
  /** exit 事件处理完成（已写终态并清理 artifacts）后 resolve。 */
  exitHandled: Promise<void>;
  status: "starting" | "running" | "stopping";
}

/**
 * 进程内单例：持有工作区 → 活进程句柄的 Map，编排 start/list/status/logs/stop、
 * 宽限窗口与 exit watcher、启动恢复与关停。service 生命周期跨 Run、跨会话，
 * 只随进程退出或显式 stop 结束；manager 不接收 Run 的 AbortSignal。
 */
export class ServiceProcessManager {
  readonly #store: SQLitePersistentServiceStore;
  readonly #launcher: ServiceLauncher;
  readonly #artifactsRoot: string;
  readonly #now: () => number;
  readonly #startGracePeriodMs: number;
  readonly #stopGracePeriodMs: number;
  readonly #shutdownBudgetMs: number;
  readonly #live = new Map<string, LiveService>();
  /** 正在启动（占用名额、尚未进入 live Map）的 service id → workspaceRoot。 */
  readonly #starting = new Map<string, string>();
  #shutdownStarted = false;

  constructor(options: ServiceProcessManagerOptions) {
    this.#store = options.store;
    this.#launcher = options.launcher;
    this.#artifactsRoot = options.artifactsRoot;
    this.#now = options.now ?? (() => Date.now());
    this.#startGracePeriodMs =
      options.startGracePeriodMs ?? SERVICE_START_GRACE_PERIOD_MS;
    this.#stopGracePeriodMs =
      options.stopGracePeriodMs ?? SERVICE_STOP_GRACE_PERIOD_MS;
    this.#shutdownBudgetMs =
      options.shutdownBudgetMs ?? SERVICE_SHUTDOWN_BUDGET_MS;
  }

  async start(command: StartServiceCommand): Promise<ServiceSnapshot> {
    if (this.#shutdownStarted) {
      throw new Error("The service manager is shutting down.");
    }
    if (
      this.#store.countLive(command.workspaceRoot) +
        this.#startingCount(command.workspaceRoot) >=
        MAX_LIVE_SERVICES_PER_WORKSPACE
    ) {
      throw new Error("SERVICE_LIMIT_REACHED");
    }

    const id = randomUUID();
    this.#starting.set(id, command.workspaceRoot);
    try {
      return await this.#startReserved(command, id);
    } finally {
      this.#starting.delete(id);
    }
  }

  async #startReserved(
    command: StartServiceCommand,
    id: string,
  ): Promise<ServiceSnapshot> {
    const startedAt = this.#isoNow();
    const artifactsDir = path.join(this.#artifactsRoot, id);
    let artifacts: ServiceArtifacts;
    try {
      artifacts = await ServiceArtifacts.create(artifactsDir);
    } catch (error) {
      this.#store.insertFailed(
        {
          id,
          workspaceRoot: command.workspaceRoot,
          name: command.name,
          command: command.command,
          cwd: command.cwd,
          executionMode: command.executionMode,
          artifactsDir,
          createdByConversationId: command.createdByConversationId,
          createdByToolCallId: command.createdByToolCallId,
        },
        startedAt,
      );
      throw error;
    }

    let pid: number;
    let exit: Promise<ServiceExit>;
    try {
      const spawned = await this.#launcher.spawn({
        command: command.command,
        cwd: command.cwd,
        workspaceRoot: command.workspaceRoot,
        executionMode: command.executionMode,
        artifacts: {
          allowedCanaryPath: artifacts.layout.allowedCanaryPath,
          deniedCanaryPath: artifacts.layout.deniedCanaryPath,
          homeDirectory: artifacts.layout.homeDirectory,
          tmpDirectory: artifacts.layout.tmpDirectory,
        },
        onStdout: (chunk) => artifacts.append(chunk),
        onStderr: (chunk) => artifacts.append(chunk),
      });
      pid = spawned.pid;
      exit = spawned.exit;
    } catch (error) {
      await artifacts.remove().catch(() => {});
      this.#store.insertFailed(
        {
          id,
          workspaceRoot: command.workspaceRoot,
          name: command.name,
          command: command.command,
          cwd: command.cwd,
          executionMode: command.executionMode,
          artifactsDir,
          createdByConversationId: command.createdByConversationId,
          createdByToolCallId: command.createdByToolCallId,
        },
        startedAt,
      );
      throw error;
    }

    try {
      this.#store.insert({
        id,
        workspaceRoot: command.workspaceRoot,
        name: command.name,
        command: command.command,
        cwd: command.cwd,
        executionMode: command.executionMode,
        status: "starting",
        pid,
        artifactsDir,
        exitCode: null,
        exitSignal: null,
        createdByConversationId: command.createdByConversationId,
        createdByToolCallId: command.createdByToolCallId,
        createdAt: startedAt,
      });
    } catch (error) {
      // 落库失败不留活进程：直接 SIGKILL 刚 spawn 的进程树。
      await this.#launcher.terminate(pid, "SIGKILL").catch(() => {});
      await artifacts.remove().catch(() => {});
      throw error;
    }
    // 行落库后 live 名额由 countLive 计入，释放启动预留，避免宽限期内重复计数。
    this.#starting.delete(id);

    const live: LiveService = {
      id,
      workspaceRoot: command.workspaceRoot,
      artifacts,
      exit,
      exitHandled: Promise.resolve(),
      status: "starting",
    };
    this.#live.set(id, live);
    void this.#watchExit(live);

    // 宽限窗口内退出：直接捕获退出结果并等待 exit 监听落库（exited）；窗口结束
    // 时仍存活才由这里推进为 running。两者用同一份 exit promise 裁决，避免把
    // 「exit 事件已到达但监听尚未写库」误判为存活。
    const outcome = await Promise.race([
      exit.then((value) => ({ exited: true as const, value })),
      delay(this.#startGracePeriodMs).then(() => ({ exited: false as const })),
    ]);
    if (outcome.exited) {
      await live.exitHandled;
    } else {
      this.#store.markRunning(id, this.#isoNow());
      live.status = "running";
    }
    return this.#snapshot(id, live);
  }

  list(workspaceRoot: string): readonly ServiceSummary[] {
    return this.#store
      .listForWorkspace(workspaceRoot, SERVICE_TERMINAL_LIST_LIMIT)
      .map(toServiceSummary);
  }

  status(id: string, workspaceRoot: string): ServiceSnapshot {
    const live = this.#live.get(id);
    const row = this.#store.read(id);
    if (row === undefined || row.workspaceRoot !== workspaceRoot) {
      throw new Error("SERVICE_NOT_FOUND");
    }
    return toServiceSnapshot(row, live?.artifacts);
  }

  logs(
    id: string,
    workspaceRoot: string,
    tailBytes: number,
  ): Promise<ServiceLogs> {
    const live = this.#live.get(id);
    const row = this.#store.read(id);
    if (row === undefined || row.workspaceRoot !== workspaceRoot) {
      return Promise.reject(new Error("SERVICE_NOT_FOUND"));
    }
    return this.#logsFor(row, live?.artifacts, tailBytes);
  }

  async stop(
    id: string,
    workspaceRoot: string,
    force: boolean,
  ): Promise<ServiceSnapshot> {
    const live = this.#live.get(id);
    const row = this.#store.read(id);
    if (row === undefined || row.workspaceRoot !== workspaceRoot) {
      throw new Error("SERVICE_NOT_FOUND");
    }
    if (row.status === "exited" ||
      row.status === "stopped" ||
      row.status === "failed" ||
      row.status === "interrupted"
    ) {
      return toServiceSnapshot(row, live?.artifacts);
    }

    if (this.#shutdownStarted) {
      // 关停序列中的 stop 不再走优雅等待，直接强杀当前进程。
      await this.#forceStopLive(live!);
      return this.#snapshot(id, live!);
    }

    const now = this.#isoNow();
    if (live === undefined) {
      // 进程句柄不在本进程（不应发生在单进程运行内），保守标记 interrupted。
      this.#store.markInterrupted(id, now);
      const updated = this.#store.read(id)!;
      return toServiceSnapshot(updated, undefined);
    }

    this.#store.markStopping(id, now);
    live.status = "stopping";
    const pendingOutcome = this.#captureExitOutcome(live);
    await this.#terminateLive(live, force);
    const outcome = await Promise.race([
      pendingOutcome,
      Promise.resolve(undefined),
    ]);
    // 优雅/强杀后 exit 监听尚未落库时，用捕获到的退出信息补一条 stopped 终态。
    const current = this.#store.read(id);
    if (current !== undefined && current.status === "stopping") {
      const finalLogTail = await live.artifacts.captureFinalTail(
        SERVICE_FINAL_LOG_TAIL_BYTES,
      );
      this.#store.markStopped(
        id,
        {
          exitCode: outcome?.exitCode ?? null,
          exitSignal: outcome?.exitSignal ?? null,
          finalLogTail,
          logTruncated: live.artifacts.truncated,
        },
        this.#isoNow(),
      );
      await this.#removeLiveArtifacts(live);
      this.#live.delete(id);
    } else {
      await live.exitHandled;
    }
    return this.#snapshot(id, live);
  }

  /** 启动恢复：把历史 live 行清理孤儿进程后置 interrupted 并删除 artifacts。 */
  async reconcileInterrupted(): Promise<number> {
    const rows = this.#store.listInterruptible();
    for (const row of rows) {
      try {
        await this.#launcher.cleanupCanary(
          path.join(row.artifactsDir, "canary", "allowed.canary"),
          path.join(row.artifactsDir, "canary", "denied.canary"),
        );
      } catch {
        // canary 目录已丢失时无法按指纹匹配，跳过杀进程只做标记。
      }
      await this.#removeArtifactsDir(row.artifactsDir);
      this.#store.markInterrupted(row.id, this.#isoNow());
    }
    return rows.length;
  }

  async shutdown(): Promise<void> {
    if (this.#shutdownStarted) return;
    this.#shutdownStarted = true;
    const liveEntries = [...this.#live.values()];
    // 空闲服务端直接返回：不创建预算定时器，避免无活进程时仍拖住事件循环。
    if (liveEntries.length === 0) return;
    const stopAll = Promise.all(
      liveEntries.map(async (live) => {
        try {
          this.#store.markStopping(live.id, this.#isoNow());
          live.status = "stopping";
          await this.#terminateLive(live, false);
        } catch {
          // 关停阶段每条 service 独立处理；残留由下面统一兜底。
        }
      }),
    );
    let budgetTimer: NodeJS.Timeout | undefined;
    const budget = new Promise<void>((resolve) => {
      budgetTimer = setTimeout(resolve, this.#shutdownBudgetMs);
    });
    try {
      await Promise.race([stopAll, budget]);
    } finally {
      // 关停工作完成后立即清掉预算定时器，避免空闲服务端也被拖住到预算耗尽。
      if (budgetTimer !== undefined) clearTimeout(budgetTimer);
    }
    // 预算耗尽后仍在活的进程统一 SIGKILL + 指纹清理并置 stopped。
    await Promise.all(
      [...this.#live.values()].map((live) => this.#forceStopLive(live)),
    );
    this.#live.clear();
  }

  #startingCount(workspaceRoot: string): number {
    let count = 0;
    for (const root of this.#starting.values()) {
      if (root === workspaceRoot) count += 1;
    }
    return count;
  }

  #waitOutcome(
    live: LiveService,
    exit: Promise<ServiceExit>,
    timeoutMs: number,
  ): Promise<void> {
    return Promise.race([
      exit.then(() => undefined),
      delay(timeoutMs).then(() => undefined),
    ]);
  }

  async #waitForExitHandled(live: LiveService): Promise<void> {
    // exitHandled 只在进程真正退出时 resolve；未退出时保持 pending，允许调用方
    // 在「等待退出落库」与「继续走 live 路径」之间用 timeout 切换。
    await live.exitHandled;
  }

  /** 捕获 exit 的退出码/信号，供 stop 在强制清理后仍然返回真实退出信息。 */
  async #captureExitOutcome(live: LiveService): Promise<ServiceExit | undefined> {
    try {
      return await live.exit;
    } catch {
      return undefined;
    }
  }

  async #waitForLiveRow(live: LiveService): Promise<void> {
    // spawn 与 insert 之间进程可能已退出：此时 exit 监听先落库会因行不存在而
    // 静默丢失终态。这里轮询等 insert 完成，再继续状态推进。
    while (this.#store.read(live.id) === undefined) {
      await delay(1);
    }
  }

  #watchExit(live: LiveService): Promise<void> {
    let resolveHandled: () => void = () => {};
    live.exitHandled = new Promise<void>((resolve) => {
      resolveHandled = resolve;
    });
    return (async () => {
      try {
        const outcome = await live.exit;
        await this.#onExit(live, outcome);
      } catch {
        // spawn 错误已被 start 路径处理；这里不重复落库。
      } finally {
        resolveHandled();
      }
    })();
  }

  async #onExit(live: LiveService, outcome: ServiceExit): Promise<void> {
    // exit 事件不保证按 spawn 顺序到达，也不保证 start 已经 insert 完。等待行
    // 出现后再落终态；live 状态下清 pid 的 UPDATE 才是真正的状态推进。
    await this.#waitForLiveRow(live);
    const now = this.#isoNow();
    const finalLogTail = await live.artifacts.captureFinalTail(
      SERVICE_FINAL_LOG_TAIL_BYTES,
    );
    const stored: ServiceExit = {
      exitCode: outcome.exitCode,
      exitSignal: outcome.exitSignal,
    };
    if (live.status === "stopping") {
      this.#store.markStopped(
        live.id,
        { ...stored, finalLogTail, logTruncated: live.artifacts.truncated },
        now,
      );
    } else {
      this.#store.markExited(
        live.id,
        { ...stored, finalLogTail, logTruncated: live.artifacts.truncated },
        now,
      );
    }
    await this.#removeLiveArtifacts(live);
    this.#live.delete(live.id);
  }

  async #terminateLive(live: LiveService, force: boolean): Promise<void> {
    const row = this.#store.read(live.id);
    if (row?.pid === null || row?.pid === undefined) return;

    if (!force) {
      try {
        await this.#launcher.terminate(row.pid, "SIGTERM");
        const exited = await Promise.race([
          live.exit.then(() => true),
          delay(this.#stopGracePeriodMs).then(() => false),
        ]);
        if (exited) {
          await this.#waitForExitHandled(live);
          return;
        }
      } catch {
        // SIGTERM 失败时继续走强杀路径。
      }
    }
    await this.#forceStopLive(live);
  }

  async #forceStopLive(live: LiveService, outcome?: ServiceExit): Promise<void> {
    const row = this.#store.read(live.id);
    if (row?.pid !== null && row?.pid !== undefined) {
      await this.#launcher.terminate(row.pid, "SIGKILL").catch(() => {});
    }
    await this.#launcher
      .cleanupCanary(
        live.artifacts.layout.allowedCanaryPath,
        live.artifacts.layout.deniedCanaryPath,
      )
      .catch(() => {});

    // 强杀兜底后若 exit 事件尚未落库，这里按 stopping 推进为 stopped。
    const now = this.#isoNow();
    const current = this.#store.read(live.id);
    if (current !== undefined && current.status === "stopping") {
      const finalLogTail = await live.artifacts.captureFinalTail(
        SERVICE_FINAL_LOG_TAIL_BYTES,
      );
      this.#store.markStopped(
        live.id,
        {
          exitCode: outcome?.exitCode ?? null,
          exitSignal: outcome?.exitSignal ?? null,
          finalLogTail,
          logTruncated: live.artifacts.truncated,
        },
        now,
      );
    }
    await this.#removeLiveArtifacts(live);
    this.#live.delete(live.id);
  }

  async #removeLiveArtifacts(live: LiveService): Promise<void> {
    await live.artifacts.remove().catch(() => {});
  }

  async #removeArtifactsDir(artifactsDir: string): Promise<void> {
    const { rm } = await import("node:fs/promises");
    await rm(artifactsDir, { recursive: true, force: true });
  }

  #snapshot(id: string, live: LiveService): ServiceSnapshot {
    const row = this.#store.read(id);
    if (row === undefined) throw new Error("SERVICE_NOT_FOUND");
    return toServiceSnapshot(row, live.artifacts);
  }

  async #logsFor(
    row: PersistentServiceRow,
    artifacts: ServiceArtifacts | undefined,
    tailBytes: number,
  ): Promise<ServiceLogs> {
    const tail = artifacts === undefined
      ? tailOf(row.finalLogTail ?? "", tailBytes)
      : await artifacts.readTail(tailBytes);
    return {
      id: row.id,
      status: row.status,
      logBytes: artifacts?.byteLength ?? 0,
      logTruncated: artifacts?.truncated ?? row.logTruncated,
      tail,
    };
  }

  #isoNow(): string {
    return new Date(this.#now()).toISOString();
  }
}

function tailOf(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return value;
  let start = buffer.byteLength - maxBytes;
  // 起点落在 UTF-8 中间字节时，向后跳到下一个完整字符边界，避免解码出替换
  // 字符使返回字节数超过上限。
  while (start < buffer.byteLength && (buffer[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return buffer.subarray(start).toString("utf8");
}

function toServiceSummary(row: PersistentServiceRow): ServiceSummary {
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    cwd: row.cwd,
    status: row.status,
    pid: row.pid,
    startedAt: row.createdAt,
    endedAt: row.endedAt,
  };
}

function toServiceSnapshot(
  row: PersistentServiceRow,
  artifacts?: ServiceArtifacts,
): ServiceSnapshot {
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    cwd: row.cwd,
    status: row.status,
    pid: row.pid,
    startedAt: row.createdAt,
    logBytes: artifacts?.byteLength ?? 0,
    logTruncated: artifacts?.truncated ?? row.logTruncated,
    ...(row.status === "exited" || row.status === "stopped"
      ? {
          exitCode: row.exitCode,
          exitSignal: row.exitSignal,
          endedAt: row.endedAt,
          ...(row.finalLogTail === null
            ? {}
            : { finalLogTail: row.finalLogTail }),
        }
      : {}),
  };
}
