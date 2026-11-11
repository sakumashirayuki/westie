import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useState } from "react";

import type { ConversationSummary } from "../run-client";
import type { RunActivityState } from "../hooks/useRunActivity";
import {
  groupConversationsByProject,
  type SidebarProjectGroup,
} from "../project-groups";
import { conversationDisplayName } from "./conversation-display-name";
import { RowActionMenu, type RowAction } from "./ui/row-action-menu";

export interface ConversationRunMarker {
  runId: string;
  state: RunActivityState;
}

export interface ProjectGroupActions {
  readonly newConversationDisabled: boolean;
  readonly onNewConversationInProject: (project: {
    key: string;
    name: string;
    root: string;
  }) => void;
}

/** 未归档（活动）会话的删除与归档分别独立禁用。 */
export interface ConversationDisableState {
  readonly switchingDisabled: boolean;
  readonly deletionDisabled: boolean;
  readonly archiveDisabled: boolean;
}

/**
 * 侧栏会话列表：第一层是项目，第二层是会话。项目与组内会话都按最近活动排序；
 * 未识别归属的会话单独成组并显示原目录，不会被隐藏。
 *
 * 分组只覆盖已加载的会话，列表末尾的「加载更多」可能为已有项目追加会话。
 */
export function ConversationList({
  conversations,
  selectedId,
  status,
  error,
  nextCursor,
  switchingDisabled,
  deletionDisabled,
  archiveDisabled,
  runActivities,
  projectActions,
  onSelect,
  onRename,
  onArchive,
  onDelete,
  onLoadMore,
  onRetry,
}: {
  conversations: readonly ConversationSummary[];
  selectedId?: string;
  status: "loading" | "ready" | "loading-more" | "error";
  error?: string;
  nextCursor: string | null;
  switchingDisabled: boolean;
  deletionDisabled: boolean;
  archiveDisabled: boolean;
  runActivities: ReadonlyMap<string, ConversationRunMarker>;
  projectActions?: ProjectGroupActions;
  onSelect: (conversationId: string) => void;
  onRename: (conversation: ConversationSummary) => void;
  onArchive: (conversation: ConversationSummary) => void;
  onDelete: (conversation: ConversationSummary) => void;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  const groups = groupConversationsByProject(conversations);
  // 折叠状态按项目 key 保留：刷新或新增会话后仍沿用用户的选择。
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  function toggle(groupKey: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-2 py-2">
        <h2 className="text-xs font-bold tracking-[0.08em] text-[#6c766f]">项目</h2>
        <span className="font-mono text-[11px] text-[#78817b]">
          {conversations.length}
        </span>
      </div>

      {status === "loading" && conversations.length === 0 && (
        <p className="px-2 py-5 text-sm text-[#69736d]">正在加载会话…</p>
      )}
      {status === "error" && conversations.length === 0 && (
        <div className="px-2 py-4">
          <p className="text-sm text-[#a33d35]" role="alert">
            {error ?? "加载会话失败。"}
          </p>
          <button
            type="button"
            className="mt-3 cursor-pointer text-sm font-bold text-[#276c52]"
            onClick={onRetry}
          >
            重试
          </button>
        </div>
      )}
      {status === "ready" && conversations.length === 0 && (
        <p className="px-2 py-5 text-sm leading-6 text-[#69736d]">
          还没有历史会话。点上方「新建会话」打开一个项目。
        </p>
      )}

      {conversations.length > 0 && (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 max-[760px]:max-h-64">
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            // 未识别归属的会话没有项目锚点，不提供项目内新建入口。
            const project = identifiedProject(group);
            return (
              <section key={group.key} aria-label={`项目 ${group.name}`}>
                <div className="flex items-center gap-1 rounded-lg px-1 py-1">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggle(group.key)}
                  >
                    {isCollapsed
                      ? <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
                      : <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />}
                    <span className="min-w-0 flex-1 truncate text-xs font-bold tracking-[0.04em] text-[#3c4741]">
                      {group.name}
                    </span>
                  </button>
                  {project !== null && projectActions !== undefined && (
                    <button
                      type="button"
                      className="cursor-pointer rounded-md p-1 text-[#3c4741] hover:bg-[#eef4ef] disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label={`在 ${group.name} 中新建会话`}
                      title={`在 ${group.name} 中新建会话`}
                      disabled={projectActions.newConversationDisabled}
                      onClick={() =>
                        projectActions.onNewConversationInProject({
                          key: project.key,
                          name: project.name,
                          root: project.root,
                        })}
                    >
                      <Plus className="size-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
                {group.root !== null && (
                  <p
                    className="truncate px-6 font-mono text-[11px] text-[#8a938d]"
                    title={group.root}
                  >
                    {group.root}
                  </p>
                )}
                {!isCollapsed && (
                  <div className="mt-1 space-y-1">
                    {group.conversations.map((conversation) => (
                      <ConversationRow
                        key={conversation.id}
                        conversation={conversation}
                        selected={conversation.id === selectedId}
                        runActivity={runActivities.get(conversation.id)}
                        switchingDisabled={switchingDisabled}
                        deletionDisabled={deletionDisabled}
                        archiveDisabled={archiveDisabled}
                        onSelect={onSelect}
                        onRename={onRename}
                        onArchive={onArchive}
                        onDelete={onDelete}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {nextCursor !== null && (
        <button
          type="button"
          className="mt-2 w-full cursor-pointer rounded-xl px-3 py-2 text-sm font-bold text-[#276c52] hover:bg-[#eef4ef] disabled:cursor-not-allowed disabled:opacity-50"
          disabled={status === "loading-more" || switchingDisabled}
          onClick={onLoadMore}
        >
          {status === "loading-more" ? "正在加载…" : "加载更多（显示已加载的会话）"}
        </button>
      )}
      {status === "error" && conversations.length > 0 && (
        <p className="px-2 pt-2 text-xs text-[#a33d35]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ConversationRow({
  conversation,
  selected,
  runActivity,
  switchingDisabled,
  deletionDisabled,
  archiveDisabled,
  onSelect,
  onRename,
  onArchive,
  onDelete,
}: {
  conversation: ConversationSummary;
  selected: boolean;
  runActivity: ConversationRunMarker | undefined;
  switchingDisabled: boolean;
  deletionDisabled: boolean;
  archiveDisabled: boolean;
  onSelect: (conversationId: string) => void;
  onRename: (conversation: ConversationSummary) => void;
  onArchive: (conversation: ConversationSummary) => void;
  onDelete: (conversation: ConversationSummary) => void;
}) {
  const runningHere = runActivity !== undefined && runActivity.state === "running";
  const awaitingHere =
    runActivity !== undefined && runActivity.state === "awaiting_interaction";
  const waitingSubAgents = runActivity?.state === "waiting_sub_agents";
  // 运行中的会话不能改名、归档或删除，原因写进菜单项的副标题。
  const busyReason = runActivity === undefined ? undefined : "会话正在运行";
  const disabledReason = (fallback: string): { disabled: true; disabledReason: string } =>
    busyReason === undefined
      ? { disabled: true, disabledReason: fallback }
      : { disabled: true, disabledReason: busyReason };
  const rowActions = (target: ConversationSummary): readonly RowAction[] => [
    {
      label: "重命名",
      onSelect: () => onRename(target),
      ...(switchingDisabled || busyReason !== undefined
        ? disabledReason("当前有其他操作进行中")
        : {}),
    },
    {
      label: "归档",
      onSelect: () => onArchive(target),
      ...(archiveDisabled || busyReason !== undefined
        ? disabledReason("当前有其他操作进行中")
        : {}),
    },
    {
      label: "删除",
      tone: "danger" as const,
      onSelect: () => onDelete(target),
      ...(deletionDisabled || busyReason !== undefined
        ? disabledReason("当前有其他操作进行中")
        : {}),
    },
  ];
  return (
    <div
      className={`ml-3 flex items-stretch rounded-xl border transition ${
        selected
          ? "border-[#7aae99] bg-[#eaf3ed]"
          : "border-transparent hover:border-[#d5dbd5] hover:bg-[#f5f6f2]"
      }`}
    >
      <button
        type="button"
        className="min-w-0 flex-1 cursor-pointer px-3 py-3 text-left disabled:cursor-not-allowed disabled:opacity-50"
        disabled={switchingDisabled}
        aria-current={selected ? "page" : undefined}
        onClick={() => onSelect(conversation.id)}
      >
        <span className="flex items-center gap-2">
          {runningHere && (
            <span
              className="run-status-dot run-status-dot--running"
              aria-label="运行中"
              role="status"
            />
          )}
          {awaitingHere && (
            <span
              className="run-status-dot run-status-dot--awaiting"
              aria-label="等待审批"
              role="status"
            />
          )}
          {waitingSubAgents && (
            <span
              className="run-status-dot run-status-dot--awaiting"
              aria-label="等待子任务"
              role="status"
            />
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-bold">
            {conversationDisplayName(conversation)}
          </span>
        </span>
        {waitingSubAgents && (
          <span className="mt-1 block text-[11px] text-[#a5650d]">等待子任务</span>
        )}
        <time
          className="mt-1 block text-[11px] text-[#858d87]"
          dateTime={conversation.updatedAt}
        >
          {formatUpdatedAt(conversation.updatedAt)}
          {" · "}
          {conversation.id.slice(0, 8)}
        </time>
      </button>
      <RowActionMenu
        label={`会话操作 ${conversationDisplayName(conversation)} ${conversation.id.slice(0, 8)}`}
        actions={rowActions(conversation)}
      />
    </div>
  );
}

/**
 * 分组对应的项目。只有 key 以 `git:` 或 `dir:` 开头的服务端归属才能作为
 * 项目锚点；其它来源（例如测试里拼出来的对象）不提供项目内新建入口。
 */
function identifiedProject(
  group: SidebarProjectGroup,
): SidebarProjectGroup["project"] {
  const project = group.project;
  if (
    project === null ||
    !(project.key.startsWith("git:") || project.key.startsWith("dir:"))
  ) {
    return null;
  }
  return project;
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
