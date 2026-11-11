import { Archive, Plus, Server } from "lucide-react";
import type { ComponentProps } from "react";

import { ConversationList } from "./ConversationList";
import { surfaceClasses } from "./view-styles";

export interface SidebarProps {
  conversations: ComponentProps<typeof ConversationList>;
  newConversationDisabled: boolean;
  onNewConversation: () => void;
  /** 底部导航里当前高亮的项；弹窗打开时高亮对应入口。 */
  activeNav?: "mcp" | "archived";
  onOpenMcpSettings: () => void;
  onShowArchived: () => void;
}

/**
 * 三段式左栏：品牌区加主操作、会话列表、底部导航。窄屏（760px 以下）折成
 * 顶部区块：品牌与导航同行，列表限高可滚动。
 */
export function Sidebar({
  conversations,
  newConversationDisabled,
  onNewConversation,
  activeNav,
  onOpenMcpSettings,
  onShowArchived,
}: SidebarProps) {
  return (
    <aside
      className={`${surfaceClasses} flex min-h-0 flex-col rounded-[18px] p-3 max-[760px]:rounded-[14px]`}
      aria-label="导航"
    >
      <div className="flex items-center justify-between gap-3 px-2 pb-3 pt-1 max-[760px]:pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <img
            src={new URL("../../../build/icon.png", import.meta.url).href}
            className="size-7 shrink-0"
            alt=""
            aria-hidden="true"
          />
          <span className="truncate text-sm font-bold">westie</span>
        </div>
        <nav aria-label="设置" className="hidden max-[760px]:block">
          <ArchiveNavButton
            active={activeNav === "archived"}
            compact
            onClick={onShowArchived}
          />
          <McpNavButton
            active={activeNav === "mcp"}
            compact
            onClick={onOpenMcpSettings}
          />
        </nav>
      </div>

      <button
        type="button"
        className="mb-3 inline-flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-[#276c53] px-3 py-2.5 text-sm font-bold text-white transition hover:bg-[#1f5943] disabled:cursor-not-allowed disabled:opacity-45"
        disabled={newConversationDisabled}
        onClick={onNewConversation}
      >
        <Plus className="size-4" aria-hidden="true" />
        新建会话
      </button>

      <ConversationList {...conversations} />

      <nav
        aria-label="设置"
        className="mt-3 border-t border-[rgba(20,32,27,0.1)] pt-3 max-[760px]:hidden"
      >
        <ArchiveNavButton
          active={activeNav === "archived"}
          onClick={onShowArchived}
        />
        <McpNavButton active={activeNav === "mcp"} onClick={onOpenMcpSettings} />
      </nav>
    </aside>
  );
}

function ArchiveNavButton({
  active,
  compact = false,
  onClick,
}: {
  active: boolean;
  compact?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`inline-flex cursor-pointer items-center gap-2.5 rounded-xl border text-sm font-bold transition ${
        compact ? "px-2.5 py-2" : "w-full px-3 py-2.5"
      } ${
        active
          ? "border-[#7aae99] bg-[#eaf3ed] text-[#204f3d]"
          : "border-transparent text-[#3c4741] hover:border-[#d5dbd5] hover:bg-[#f5f6f2]"
      }`}
      aria-current={active ? "true" : undefined}
      onClick={onClick}
    >
      <Archive className="size-4 shrink-0 text-[#276c53]" aria-hidden="true" />
      <span className={compact ? "sr-only" : ""}>已归档</span>
    </button>
  );
}

function McpNavButton({
  active,
  compact = false,
  onClick,
}: {
  active: boolean;
  compact?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`inline-flex cursor-pointer items-center gap-2.5 rounded-xl border text-sm font-bold transition ${
        compact ? "px-2.5 py-2" : "w-full px-3 py-2.5"
      } ${
        active
          ? "border-[#7aae99] bg-[#eaf3ed] text-[#204f3d]"
          : "border-transparent text-[#3c4741] hover:border-[#d5dbd5] hover:bg-[#f5f6f2]"
      }`}
      aria-current={active ? "true" : undefined}
      onClick={onClick}
    >
      <Server className="size-4 shrink-0 text-[#276c53]" aria-hidden="true" />
      <span className={compact ? "sr-only" : ""}>MCP 服务器</span>
    </button>
  );
}
