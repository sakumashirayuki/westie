import { useCallback, useReducer, useRef, useState } from "react";

import {
  conversationReducer,
  initialConversationState,
} from "../conversation-state";
import type { AgentEvent, RunEventSource } from "../events";
import {
  selectPendingInteractions,
  type PendingInteraction,
} from "../pending-interactions";
import {
  AgentRunError,
  cancelConversationRun,
  cancelSubAgentRun,
  HttpRunError,
  RunProtocolError,
  steerConversationRun,
  streamConversationRun,
  subscribeConversationRun,
  type ConversationDetail,
} from "../run-client";

import { useRunInteractions } from "./useRunInteractions";

interface ActiveRun {
  controller: AbortController;
  turnId: string;
  conversationId: string;
  runId?: string;
  lastSeq: number;
  terminated: boolean;
  undeliveredSteering: { seq: number; content: string }[];
  appliedSteering: Set<number>;
}

const RECONNECT_BACKOFF_MS = [500, 1_000, 2_000, 4_000];
const MAX_RECONNECT_ATTEMPTS = 5;

export function useConversationRun(onRunSettled: () => void) {
  const [input, setInput] = useState("");
  const [state, dispatch] = useReducer(
    conversationReducer,
    initialConversationState,
  );
  const [stopping, setStopping] = useState(false);
  const [subAgentStopError, setSubAgentStopError] = useState<string | undefined>();
  const activeRef = useRef<ActiveRun | null>(null);
  const interactions = useRunInteractions(isActive);

  const activeTurn = state.turns.find(
    (turn) => turn.id === state.activeTurnId,
  );
  const latestTurn = state.turns.at(-1);
  const status = activeTurn?.run.status ?? latestTurn?.run.status ?? "idle";
  const pendingInteractions: PendingInteraction[] =
    selectPendingInteractions(activeTurn);
  const canSteer = activeRef.current?.runId !== undefined;
  const isStopping = stopping;

  function isActive(): boolean {
    return activeRef.current !== null;
  }

  function clearActiveRun(): void {
    activeRef.current?.controller.abort();
    activeRef.current = null;
    setStopping(false);
    interactions.reset();
  }

  function reset(): void {
    clearActiveRun();
    dispatch({ type: "reset" });
  }

  function hydrate(conversation: ConversationDetail): void {
    clearActiveRun();
    dispatch({ type: "hydrate", conversation });
  }

  function start(conversationId: string, blocked: boolean): void {
    const trimmed = input.trim();
    if (!trimmed || blocked || activeRef.current !== null) return;

    const turnId = crypto.randomUUID();
    const controller = new AbortController();
    setStopping(false);
    activeRef.current = {
      controller,
      turnId,
      conversationId,
      lastSeq: 0,
      terminated: false,
      undeliveredSteering: [],
      appliedSteering: new Set(),
    };
    dispatch({ type: "start", turnId, userMessage: trimmed });
    setInput("");
    void executeRun(conversationId, trimmed, turnId, controller);
  }

  async function executeRun(
    conversationId: string,
    input: string,
    turnId: string,
    controller: AbortController,
  ): Promise<void> {
    try {
      await streamConversationRun(
        conversationId,
        { input },
        {
          signal: controller.signal,
          onEvent: (event, source) => {
            if (activeRef.current?.controller === controller) {
              handleEvent(turnId, event, source);
            }
          },
          onRunId: (runId) => {
            const active = activeRef.current;
            if (active !== null && active.controller === controller) {
              active.runId = runId;
            }
          },
          onStreamSeq: (seq) => {
            if (activeRef.current?.controller === controller) activeRef.current.lastSeq = seq;
          },
          onSnapshot: (snapshot) => dispatch({ type: "snapshot", turnId, snapshot }),
        },
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof AgentRunError) return;
      const active = activeRef.current;
      if (active !== null && active.controller === controller) {
        // 首条事件前断线：runId 仍应为 undefined（无 X-Run-Id），重新 GET 会话
        // 按数据库状态渲染。
        if (active.runId === undefined) {
          failTurn(turnId, {
            kind: "transport",
            message: "无法连接到 Agent 服务。",
          });
          finishActive();
          return;
        }
        await resumeWithReconnect(active, (snapshot) =>
          subscribeConversationRun(active.conversationId, active.runId!, {
            signal: active.controller.signal,
            ...(snapshot === true ? { snapshot: true } : { after: active.lastSeq }),
            onEvent: (event, source) => {
              if (activeRef.current === active) {
                handleEvent(active.turnId, event, source);
              }
            },
            onStreamSeq: (seq) => { if (activeRef.current === active) active.lastSeq = seq; },
            onSnapshot: (snapshot) => dispatch({ type: "snapshot", turnId: active.turnId, snapshot }),
          })
        );
        return;
      }
      failTurn(
        turnId,
        error instanceof HttpRunError
          ? { kind: "http", code: error.code, message: error.message }
          : {
              kind: "transport",
              message:
                error instanceof RunProtocolError
                  ? error.message
                  : "无法连接到 Agent 服务。",
            },
      );
      finishActive();
    } finally {
      const active = activeRef.current;
      // 连接正常结束（读到终态）时清理 activeRef。
      if (
        active !== null &&
        active.controller === controller &&
        active.terminated
      ) {
        finishActive();
      }
    }
  }

  /**
   * 用给定的事件订阅源接续一个 active Run：退避重连，最多 5 次；收到 410 或
   * 重试用尽则按数据库状态渲染（通过 fail 或完成）。返回后 activeRef 已清理。
   */
  async function resumeWithReconnect(
    active: ActiveRun,
    subscribe: (snapshot?: boolean) => Promise<void>,
  ): Promise<void> {
    for (
      let attempt = 0;
      attempt <= MAX_RECONNECT_ATTEMPTS;
      attempt += 1
    ) {
      if (attempt > 0) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, RECONNECT_BACKOFF_MS[attempt - 1])
        );
      }
      const controller = new AbortController();
      active.controller = controller;
      try {
        await subscribe();
        // 读到终态才到这里。
        active.terminated = true;
        finishActive();
        return;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof HttpRunError && error.status === 410 && error.code === "RUN_STREAM_NOT_REPLAYABLE") {
          try {
            await subscribe(true);
            active.terminated = true;
            finishActive();
            return;
          } catch (snapshotError) {
            // 使用快照订阅的错误决定重试或结束。
            error = snapshotError;
          }
        }
        if (controller.signal.aborted) return;
        if (error instanceof AgentRunError) {
          finishActive();
          return;
        }
        if (error instanceof HttpRunError && error.status === 410) {
          dispatch({
            type: "fail",
            turnId: active.turnId,
            error: {
              kind: "run",
              code: error.code ?? "RUN_STREAM_ENDED",
              message: error.message,
            },
          });
          finishActive();
          return;
        }
        // 其他错误退避重试（lastSeq 已由 handleEvent 推进）。
      }
    }
    // 重试用尽：重新渲染为失败状态。
    dispatch({
      type: "fail",
      turnId: active.turnId,
      error: {
        kind: "transport",
        message: "运行连接多次断开，无法恢复。",
      },
    });
    finishActive();
  }

  function failTurn(
    turnId: string,
    error: { kind: "http" | "transport"; code?: string; message: string },
  ): void {
    dispatch({ type: "fail", turnId, error });
  }

  function finishActive(): void {
    const active = activeRef.current;
    if (active === null) return;
    for (const message of active.undeliveredSteering) {
      restoreInput(message.content);
    }
    active.undeliveredSteering = [];
    activeRef.current = null;
    setStopping(false);
    onRunSettled();
  }

  function handleEvent(turnId: string, event: AgentEvent, source?: RunEventSource["subAgent"]): void {
    dispatch({ type: "event", turnId, event, source });
    const active = activeRef.current;
    if (active !== null && source === undefined && event.type === "run.started") {
      active.runId = event.runId;
    }
    // lastSeq is the transport stream cursor, advanced by the stream parser.
    if (
      active !== null &&
      source === undefined &&
      (event.type === "run.completed" ||
        event.type === "run.cancelled" ||
        event.type === "run.error")
    ) {
      active.terminated = true;
      // 收到终态后清除「正在停止」，回到可发送状态。
      setStopping(false);
    }
    if (active !== null && event.type === "steering.applied") {
      active.appliedSteering.add(event.data.messageSeq);
      active.undeliveredSteering = active.undeliveredSteering.filter(
        (message) => message.seq !== event.data.messageSeq,
      );
    }
    interactions.handleEvent(event);
  }

  async function steer(): Promise<void> {
    const active = activeRef.current;
    const trimmed = input.trim();
    if (active === null || active.runId === undefined || trimmed === "") return;
    setInput("");
    try {
      const { seq } = await steerConversationRun(
        active.conversationId,
        { runId: active.runId, input: trimmed },
      );
      if (active.appliedSteering.has(seq)) return;
      active.undeliveredSteering.push({ seq, content: trimmed });
      dispatch({ type: "steer", turnId: active.turnId, seq, content: trimmed });
    } catch (error) {
      restoreInput(trimmed);
      dispatch({
        type: "fail",
        turnId: active.turnId,
        error: {
          kind: error instanceof HttpRunError ? "http" : "transport",
          ...(error instanceof HttpRunError && error.code !== undefined
            ? { code: error.code }
            : {}),
          message: error instanceof HttpRunError
            ? error.message
            : "插话没有送达，请重试。",
        },
      });
    }
  }

  function restoreInput(content: string): void {
    setInput((current) =>
      current.trim() === "" ? content : `${content}\n\n${current}`
    );
  }

  /** 通过 cancel 接口停止 Run。 */
  function stop(): void {
    const active = activeRef.current;
    if (active === null || active.runId === undefined) return;
    setStopping(true);
    void cancelConversationRun(active.conversationId, active.runId).catch(() => {
      if (activeRef.current === active) {
        setStopping(false);
        dispatch({
          type: "fail",
          turnId: active.turnId,
          error: { kind: "transport", message: "停止请求失败，请重试。" },
        });
      }
    });
  }

  function stopSubAgent(toolCallId: string): void {
    const active = activeRef.current;
    const turn = state.turns.find((item) => item.id === active?.turnId);
    const child = turn?.subAgentRuns[toolCallId];
    if (active === null || active.runId === undefined || child?.runId === undefined) return;
    setSubAgentStopError(undefined);
    void cancelSubAgentRun(active.conversationId, active.runId, child.runId).catch(() => {
      setSubAgentStopError("停止子任务失败，请重试。");
    });
  }

  /** 接回运行中的 Run：从 0 回放，衔接实时。 */
  const resume = useCallback(
    (
      conversationId: string,
      turnId: string,
      runId: string,
    ): void => {
      if (activeRef.current !== null) return;
      const controller = new AbortController();
      const active: ActiveRun = {
        controller,
        turnId,
        conversationId,
        runId,
        lastSeq: 0,
        terminated: false,
        undeliveredSteering: [],
        appliedSteering: new Set(),
      };
      activeRef.current = active;
      void (async () => {
        try {
          await subscribeConversationRun(conversationId, runId, {
            signal: controller.signal,
            after: 0,
            onEvent: (event, source) => {
              if (activeRef.current === active) {
                handleEvent(turnId, event, source);
              }
            },
            onStreamSeq: (seq) => { if (activeRef.current === active) active.lastSeq = seq; },
            onSnapshot: (snapshot) => dispatch({ type: "snapshot", turnId, snapshot }),
          });
          active.terminated = true;
          finishActive();
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof HttpRunError && error.status === 410 && error.code === "RUN_STREAM_NOT_REPLAYABLE") {
            try {
              await subscribeConversationRun(active.conversationId, active.runId!, {
                signal: active.controller.signal,
                snapshot: true,
            onEvent: (event, source) => handleEvent(turnId, event, source),
            onStreamSeq: (seq) => { if (activeRef.current === active) active.lastSeq = seq; },
            onSnapshot: (snapshot) => dispatch({ type: "snapshot", turnId, snapshot }),
              });
              active.terminated = true;
              finishActive();
              return;
            } catch (snapshotError) {
              error = snapshotError;
            }
          }
          if (controller.signal.aborted) return;
          if (error instanceof AgentRunError) {
            finishActive();
            return;
          }
          if (error instanceof HttpRunError && error.status === 410) {
            dispatch({
              type: "fail",
              turnId,
              error: {
                kind: "run",
                code: error.code ?? "RUN_STREAM_ENDED",
                message: error.message,
              },
            });
            finishActive();
            return;
          }
          // 其他错误走重连。
          await resumeWithReconnect(active, (snapshot) =>
            subscribeConversationRun(active.conversationId, active.runId!, {
              signal: active.controller.signal,
              ...(snapshot === true ? { snapshot: true } : { after: active.lastSeq }),
              onEvent: (event, source) => {
                if (activeRef.current === active) {
                  handleEvent(active.turnId, event, source);
                }
              },
              onStreamSeq: (seq) => { if (activeRef.current === active) active.lastSeq = seq; },
              onSnapshot: (snapshot) => dispatch({ type: "snapshot", turnId: active.turnId, snapshot }),
            })
          );
        }
      })();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return {
    input,
    setInput,
    state,
    status,
    interactionRequests: interactions.interactionRequests,
    pendingInteractions,
    canSteer,
    isActive,
    isStopping,
    reset,
    hydrate,
    start,
    steer,
    stop,
    stopSubAgent,
    subAgentStopError,
    respond: interactions.respond,
    selectFile: interactions.selectFile,
    resume,
  };
}
