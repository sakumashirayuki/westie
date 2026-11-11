import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import type { ConversationSummary } from "../run-client";
import {
  groupConversationsByProject,
  workspaceKindLabel,
} from "../project-groups";
import { conversationDisplayName } from "./conversation-display-name";
import { RowActionMenu, type RowAction } from "./ui/row-action-menu";
import { surfaceClasses } from "./view-styles";

/**
 * 已归档视图：按项目分组展示归档会话（只读），点击卡片打开只读详情，
 * 卡片操作菜单只保留「删除」。归档会话列表由页面把 `useConversationList(true)`
 * 的结果作为 `catalog` 传入，删除成功后由页面同步更新列表。
 */
export function ArchivedConversationView({
  conversations,
  status,
  error,
  nextCursor,
  onOpen,
  onDelete,
  onLoadMore,
  onRetry,
}: {
  conversations: readonly ConversationSummary[];
  status: "loading" | "ready" | "loading-more" | "error";
  error?: string;
  nextCursor: string | null;
  onOpen: (conversationId: string) => void;
  onDelete: (conversation: ConversationSummary) => void;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const groups = groupConversationsByProject(conversations);

  function toggle(groupKey: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div
        className={`${surfaceClasses} mb-[18px] rounded-[18px] p-[18px] max-[600px]:rounded-[14px]`}
      >
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1 text-sm font-bold text-[#275f49] hover:text-[#1f5943]"
          onClick={() => navigate("/")}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          返回
        </button>
        <div className="mt-3 flex items-center justify-between gap-3">
          <h1 className="text-lg font-bold">已归档会话</h1>
          <span className="font-mono text-xs text-[#78817b]">
            {conversations.length}
          </span>
        </div>
        <p className="mt-1 text-sm text-[#657068]">
          归档会话仅保留历史记录，无法继续对话。
        </p>
      </div>

      {status === "loading" && conversations.length === 0 && (
        <p className="px-2 py-5 text-sm text-[#69736d]">正在加载已归档会话…</p>
      )}
      {status === "error" && conversations.length === 0 && (
        <div className={`${surfaceClasses} rounded-[18px] p-[18px] text-sm text-[#a33d35]`} role="alert">
          {error}
          <button
            type="button"
            className="mt-3 block cursor-pointer font-bold text-[#276c52]"
            onClick={onRetry}
          >
            重试
          </button>
        </div>
      )}
      {status === "ready" && conversations.length === 0 && (
        <div className={`${surfaceClasses} rounded-[18px] p-[18px] text-sm text-[#69736d]`}>
          还没有归档会话。活动会话的「⋯」菜单里可以归档。
        </div>
      )}

      {groups.length > 0 && (
        <div className="space-y-2">
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            return (
              <section key={group.key} aria-label={`项目 ${group.name}`}>
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-left hover:bg-[#f5f6f2]"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggle(group.key)}
                >
                  <span className="text-xs font-bold tracking-[0.04em] text-[#3c4741]">
                    {isCollapsed ? "▸" : "▾"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-bold tracking-[0.04em] text-[#3c4741]">
                    {group.name}
                  </span>
                </button>
                {!isCollapsed && (
                  <div className="mt-1 grid gap-2 pl-5">
                    {group.conversations.map((conversation) => (
                      <ArchivedCard
                        key={conversation.id}
                        conversation={conversation}
                        onOpen={() => onOpen(conversation.id)}
                        onDelete={onDelete}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
          {nextCursor !== null && (
            <button
              type="button"
              className="mt-2 w-full cursor-pointer rounded-xl px-3 py-2 text-sm font-bold text-[#276c52] hover:bg-[#eef4ef]"
              onClick={onLoadMore}
            >
              加载更多（显示已加载的会话）
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ArchivedCard({
  conversation,
  onOpen,
  onDelete,
}: {
  conversation: ConversationSummary;
  onOpen: () => void;
  onDelete: (conversation: ConversationSummary) => void;
}) {
  const actions = (target: ConversationSummary): readonly RowAction[] => [
    {
      label: "删除",
      tone: "danger" as const,
      onSelect: () => onDelete(target),
    },
  ];
  return (
    <div
      className={`${surfaceClasses} flex items-stretch rounded-xl transition hover:border-[#d5dbd5] hover:bg-[#f5f6f2]`}
    >
      <button
        type="button"
        className="min-w-0 flex-1 cursor-pointer px-3 py-3 text-left"
        onClick={onOpen}
      >
        <span className="block truncate text-sm font-bold">
          {conversationDisplayName(conversation)}
        </span>
        <span className="mt-1 block text-[11px] text-[#858d87]">
          {workspaceKindLabel(conversation.workspaceKind ?? "unknown")}
          {" · "}归档于 {formatDate(conversation.updatedAt)}
        </span>
      </button>
      <RowActionMenu
        label={`已归档会话操作 ${conversationDisplayName(conversation)} ${conversation.id.slice(0, 8)}`}
        actions={actions(conversation)}
      />
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}