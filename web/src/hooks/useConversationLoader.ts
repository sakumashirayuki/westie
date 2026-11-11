import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  getConversation,
  HttpRunError,
  type ConversationDetail,
} from "../run-client";
import type { useConversationList } from "./useConversationList";
import type { useConversationRun } from "./useConversationRun";

export interface ConversationLoaderOptions {
  /** 路由里的会话 id；undefined 表示首页，没有当前会话。 */
  readonly conversationId: string | undefined;
  readonly run: ReturnType<typeof useConversationRun>;
  readonly catalog: ReturnType<typeof useConversationList>;
}

/**
 * 当前会话跟着路由走：id 变了就加载并灌进运行状态。运行中不切换，反而把路由拉回
 * 正在运行的会话。404 回首页。
 */
export function useConversationLoader({
  conversationId,
  run,
  catalog,
}: ConversationLoaderOptions) {
  const navigate = useNavigate();
  const [conversation, setConversation] =
    useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (conversationId === undefined) {
      setConversation(null);
      run.setInput("");
      run.reset();
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setError(undefined);
    setLoading(true);
    setConversation(null);
    run.reset();
    void getConversation(conversationId, { signal: controller.signal })
      .then((detail) => {
        setConversation(detail);
        run.hydrate(detail);
        catalog.upsert(detail);
        // 打开运行中的会话：最后一个 turn 的 Run 是 running 时，接回事件流。
        const lastTurn = detail.turns.at(-1);
        const lastRun = lastTurn?.runs.at(-1);
        if (lastTurn !== undefined && lastRun?.status === "running") {
          run.resume(detail.id, lastTurn.id, lastRun.id);
        }
      })
      .catch((loadError: unknown) => {
        if (controller.signal.aborted) return;
        const notFound = loadError instanceof HttpRunError &&
          loadError.status === 404;
        setError(notFound ? "会话不存在或已被删除。" : "加载会话失败，请重试。");
        if (notFound) navigate("/", { replace: true });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // 只跟路由 id 走；run、catalog、conversation 都是读当下的值，不应触发重载。
  }, [conversationId]);

  /** 外部动作（打开新项目、删除当前会话）直接指定当前会话，不经过加载。 */
  function show(detail: ConversationDetail | null): void {
    setConversation(detail);
    setError(undefined);
    setLoading(false);
  }

  return { conversation, loading, error, show };
}
