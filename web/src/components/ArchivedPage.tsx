import { useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { useConversationList } from "../hooks/useConversationList";
import { ArchivedConversationDetail } from "./ArchivedConversationDetail";
import { ArchivedConversationView } from "./ArchivedConversationView";
import type { ConversationRunMarker } from "./ConversationList";
import {
  ConversationSidebarPanel,
  type ConversationSidebarPanelHandle,
} from "./ConversationSidebarPanel";

/** 归档页侧栏不展示任何 Run 状态。 */
const EMPTY_RUN_ACTIVITIES: ReadonlyMap<string, ConversationRunMarker> =
  new Map();

/**
 * 已归档页：独立主视图（侧栏仍展示活动会话）。列表路径 `/archived` 显示归档
 * 列表；带 id 的路径显示出该归档会话的只读详情。删除在当前会话时切回列表。
 */
export function ArchivedPage() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  // 侧栏仍展示活动会话，归档列表由独立的归档 catalog 维护（archived=true）。
  const catalog = useConversationList(false);
  const archivedCatalog = useConversationList(true);
  // 归档卡片的删除入口复用侧栏容器持有的同一个删除弹窗。
  const panelRef = useRef<ConversationSidebarPanelHandle>(null);

  return (
    <main className="h-dvh min-w-80 overflow-hidden bg-[radial-gradient(circle_at_15%_10%,rgba(255,255,255,0.85),transparent_28rem),linear-gradient(145deg,#f7f5ee_0%,#eeece3_100%)] font-sans text-[#14201b] antialiased max-[760px]:h-auto max-[760px]:min-h-dvh max-[760px]:overflow-visible">
      <div className="flex h-full w-full flex-col p-4 max-[760px]:h-auto max-[600px]:p-2.5 max-[600px]:pb-6">
        <div className="mx-auto grid min-h-0 w-full max-w-[1320px] flex-1 grid-cols-[270px_minmax(0,1fr)] items-stretch gap-[18px] min-[1120px]:grid-cols-[300px_minmax(0,1fr)] max-[760px]:grid-cols-1">
          <ConversationSidebarPanel
            ref={panelRef}
            catalog={catalog}
            onSelect={(id) => navigate(`/conversations/${encodeURIComponent(id)}`)}
            runActivities={EMPTY_RUN_ACTIVITIES}
            isRunActive={() => false}
            onNewConversation={() => navigate("/")}
            activeNav="archived"
            onOpenMcpSettings={() => navigate("/")}
            onShowArchived={() => navigate("/archived")}
            onDeleted={(deletedId) => {
              archivedCatalog.remove(deletedId);
              if (deletedId === conversationId) navigate("/archived");
            }}
            onMissing={(missingId) => {
              if (missingId === conversationId) navigate("/archived");
            }}
            onArchived={(archivedId) =>
              navigate(`/archived/${encodeURIComponent(archivedId)}`, {
                replace: true,
              })
            }
          />
          {conversationId === undefined ? (
            <ArchivedConversationView
              conversations={archivedCatalog.conversations}
              status={archivedCatalog.state.status}
              error={archivedCatalog.state.error}
              nextCursor={archivedCatalog.state.nextCursor}
              onOpen={(id) => navigate(`/archived/${encodeURIComponent(id)}`)}
              onDelete={(conversation) =>
                panelRef.current?.requestDelete(conversation)
              }
              onLoadMore={archivedCatalog.loadMore}
              onRetry={archivedCatalog.refresh}
            />
          ) : (
            <ArchivedConversationDetail />
          )}
        </div>
      </div>
    </main>
  );
}
