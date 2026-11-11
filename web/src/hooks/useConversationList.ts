import { useCallback, useEffect, useRef, useState } from "react";

import {
  HttpRunError,
  listConversations,
  type ConversationDetail,
  type ConversationSummary,
} from "../run-client";

export type ConversationListStatus =
  | "loading"
  | "ready"
  | "loading-more"
  | "error";

interface ConversationListState {
  readonly status: ConversationListStatus;
  readonly nextCursor: string | null;
  readonly error?: string;
}

export function useConversationList(archived = false) {
  const removedIdsRef = useRef(new Set<string>());
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [state, setState] = useState<ConversationListState>({
    status: "loading",
    nextCursor: null,
  });

  const loadPage = useCallback(async (
    cursor: string | undefined,
    signal: AbortSignal,
    replace: boolean,
  ) => {
    setState((current) => ({
      ...current,
      status: cursor === undefined ? "loading" : "loading-more",
      error: undefined,
    }));
    try {
      const page = await listConversations({ cursor, archived, signal });
      const visibleItems = page.items.filter(
        (conversation) => !removedIdsRef.current.has(conversation.id),
      );
      setConversations((current) =>
        replace
          ? visibleItems
          : mergeConversationSummaries(current, visibleItems)
      );
      setState({ status: "ready", nextCursor: page.nextCursor });
    } catch (error) {
      if (signal.aborted) return;
      setState((current) => ({
        ...current,
        status: "error",
        error:
          error instanceof HttpRunError
            ? error.message
            : "加载会话列表失败，请重试。",
      }));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadPage(undefined, controller.signal, true);
    return () => controller.abort();
  }, [loadPage]);

  const refresh = useCallback(() => {
    const controller = new AbortController();
    void loadPage(undefined, controller.signal, true);
  }, [loadPage]);

  const loadMore = useCallback(() => {
    if (state.nextCursor === null || state.status === "loading-more") return;
    const controller = new AbortController();
    void loadPage(state.nextCursor, controller.signal, false);
  }, [loadPage, state.nextCursor, state.status]);

  const upsert = useCallback((conversation: ConversationDetail) => {
    if (removedIdsRef.current.has(conversation.id)) return;
    setConversations((current) =>
      mergeConversationSummaries(
        [toConversationSummary(conversation)],
        current,
      )
    );
  }, []);

  const remove = useCallback((conversationId: string) => {
    removedIdsRef.current.add(conversationId);
    setConversations((current) =>
      current.filter((conversation) => conversation.id !== conversationId)
    );
  }, []);

  /**
   * 改名成功后用服务端返回的 summary 覆盖本地条目。服务端不改 `updated_at`，
   * 所以合并后排序位置不变。
   */
  const rename = useCallback((conversation: ConversationSummary) => {
    if (removedIdsRef.current.has(conversation.id)) return;
    setConversations((current) =>
      mergeConversationSummaries([conversation], current)
    );
  }, []);

  /** 归档成功后从当前列表移除；归档会话是只读的，不会再有后续更新。 */
  const removeArchived = useCallback((conversationId: string) => {
    removedIdsRef.current.add(conversationId);
    setConversations((current) =>
      current.filter((conversation) => conversation.id !== conversationId)
    );
  }, []);

  return {
    conversations,
    state,
    refresh,
    loadMore,
    upsert,
    remove,
    removeArchived,
    rename,
  };
}

function toConversationSummary(
  conversation: ConversationDetail,
): ConversationSummary {
  return {
    id: conversation.id,
    revision: conversation.revision,
    executionMode: conversation.executionMode,
    title: conversation.title,
    workspace: { name: conversation.workspace.name },
    project: conversation.project,
    archived: conversation.archived,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

export function mergeConversationSummaries(
  first: readonly ConversationSummary[],
  second: readonly ConversationSummary[],
): ConversationSummary[] {
  const merged = new Map<string, ConversationSummary>();
  // first 优先：upsert 时 first 是最新 summary，须覆盖 second 里的旧条目。
  for (const conversation of [...second, ...first]) {
    merged.set(conversation.id, conversation);
  }
  return Array.from(merged.values()).sort(compareConversations);
}

/**
 * 与服务端 listConversations 的 `ORDER BY updated_at DESC, id DESC` 对齐，
 * 保证 upsert 更新已有条目后列表顺序稳定，不会把点中的会话挪到头部。
 */
function compareConversations(
  left: ConversationSummary,
  right: ConversationSummary,
): number {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt > right.updatedAt ? -1 : 1;
  }
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}
