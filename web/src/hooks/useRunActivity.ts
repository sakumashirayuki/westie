import { useEffect, useRef, useState } from "react";

import { parseSseStream } from "../sse";

export type RunActivityState = "running" | "awaiting_interaction" | "waiting_sub_agents" | "ended";

export interface RunActivity {
  runId: string;
  state: RunActivityState;
  status?: "completed" | "failed" | "cancelled";
}

export interface RunActivitySnapshot {
  conversationId: string;
  runId: string;
  state: RunActivityState;
  startedAt: string;
}

export interface RunStateEvent {
  conversationId: string;
  runId: string;
  state: RunActivityState;
  status?: "completed" | "failed" | "cancelled";
}

export interface RunActivityOptions {
  fetch?: typeof fetch;
}

const RECONNECT_BACKOFF_MS = [500, 1_000, 2_000, 4_000];
const MAX_RECONNECT_ATTEMPTS = 5;

export function applySnapshot(
  current: ReadonlyMap<string, { runId: string; state: RunActivityState }>,
  runs: RunActivitySnapshot[],
): Map<string, { runId: string; state: RunActivityState }> {
  const next = new Map<string, { runId: string; state: RunActivityState }>();
  for (const run of runs) {
    next.set(run.conversationId, { runId: run.runId, state: run.state });
  }
  return next;
}

export function applyRunState(
  current: ReadonlyMap<string, { runId: string; state: RunActivityState }>,
  event: RunStateEvent,
): Map<string, { runId: string; state: RunActivityState }> {
  const next = new Map(current);
  if (event.state === "ended") {
    next.delete(event.conversationId);
  } else {
    next.set(event.conversationId, {
      runId: event.runId,
      state: event.state,
    });
  }
  return next;
}

/**
 * 全局运行状态流：在 App 层建立一条 `runs:watch` 连接，维护
 * `Map<conversationId, { runId, state }>`。断开后按同样的退避重连，重连收到的
 * `snapshot` 直接替换整张表。
 */
export function useRunActivity(options: RunActivityOptions = {}) {
  const fetcher = options.fetch ?? fetch;
  const [activities, setActivities] = useState<
    Map<string, { runId: string; state: RunActivityState }>
  >(new Map());
  const controllerRef = useRef<AbortController | null>(null);
  const stoppingRef = useRef(false);

  useEffect(() => {
    stoppingRef.current = false;
    void connect(0);

    function handleSnapshot(runs: RunActivitySnapshot[]): void {
      setActivities((current) => applySnapshot(current, runs));
    }

    function handleRunState(event: RunStateEvent): void {
      setActivities((current) => applyRunState(current, event));
    }

    async function connect(attempt: number): Promise<void> {
      if (stoppingRef.current) return;
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        const response = await fetcher("/v1/agent/runs:watch", {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!response.body) throw new Error("no body");

        for await (const message of parseSseStream(response.body)) {
          if (message.event === "snapshot") {
            handleSnapshot(parseSnapshot(message.data));
          } else if (message.event === "run.state") {
            handleRunState(parseRunState(message.data));
          }
        }
      } catch {
        if (stoppingRef.current || controller.signal.aborted) return;
        // 重连：snapshot 由重新连接后的第一段事件流补上。
        if (attempt < MAX_RECONNECT_ATTEMPTS) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, RECONNECT_BACKOFF_MS[attempt])
          );
          void connect(attempt + 1);
        }
      }
    }

    return () => {
      stoppingRef.current = true;
      controllerRef.current?.abort();
    };
  }, [fetcher]);

  return { activities };
}

function parseSnapshot(data: string): RunActivitySnapshot[] {
  const value = JSON.parse(data) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    !("runs" in value) ||
    !Array.isArray((value as Record<string, unknown>).runs)
  ) {
    throw new Error("invalid snapshot");
  }
  const runs = (value as { runs: unknown[] }).runs;
  return runs.map((run) => {
    if (
      typeof run !== "object" ||
      run === null ||
      !("conversationId" in run) ||
      !("runId" in run) ||
      !("state" in run) ||
      !("startedAt" in run)
    ) {
      throw new Error("invalid snapshot entry");
    }
    const record = run as Record<string, unknown>;
    if (
      typeof record.conversationId !== "string" ||
      typeof record.runId !== "string" ||
      (record.state !== "running" &&
        record.state !== "awaiting_interaction" &&
        record.state !== "waiting_sub_agents" &&
        record.state !== "ended") ||
      typeof record.startedAt !== "string"
    ) {
      throw new Error("invalid snapshot entry");
    }
    return {
      conversationId: record.conversationId,
      runId: record.runId,
      state: record.state as RunActivityState,
      startedAt: record.startedAt,
    };
  });
}

function parseRunState(data: string): RunStateEvent {
  const value = JSON.parse(data) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    !("conversationId" in value) ||
    !("runId" in value) ||
    !("state" in value)
  ) {
    throw new Error("invalid run.state");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.conversationId !== "string" ||
    typeof record.runId !== "string" ||
      (record.state !== "running" &&
        record.state !== "awaiting_interaction" &&
        record.state !== "waiting_sub_agents" &&
        record.state !== "ended")
  ) {
    throw new Error("invalid run.state");
  }
  return {
    conversationId: record.conversationId,
    runId: record.runId,
    state: record.state as RunActivityState,
    ...(record.status === undefined
      ? {}
      : { status: record.status as "completed" | "failed" | "cancelled" }),
  };
}
