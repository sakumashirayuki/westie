import {
  forwardRef,
  useEffect,
  useImperativeHandle,
} from "react";

import { ArchiveConversationDialog } from "./ArchiveConversationDialog";
import {
  type ConversationRunMarker,
  type ProjectGroupActions,
} from "./ConversationList";
import { DeleteConversationDialog } from "./DeleteConversationDialog";
import { RenameConversationDialog } from "./RenameConversationDialog";
import { Sidebar } from "./Sidebar";
import { useConversationArchive } from "../hooks/useConversationArchive";
import { useConversationDeletion } from "../hooks/useConversationDeletion";
import { useConversationList } from "../hooks/useConversationList";
import { useConversationRename } from "../hooks/useConversationRename";
import type { ConversationSummary } from "../run-client";

export interface ConversationSidebarPanelHandle {
  /**
   * 发起删除确认。侧栏以外的入口（如归档页的归档卡片）通过它共用容器持有的
   * 同一个删除弹窗与提交流程。
   */
  requestDelete: (conversation: ConversationSummary) => void;
}

export interface ConversationSidebarPanelProps {
  /** 侧栏展示的活动会话 catalog；行操作成功后的本地列表同步由容器完成。 */
  catalog: ReturnType<typeof useConversationList>;
  selectedId?: string;
  onSelect: (conversationId: string) => void;
  /**
   * 页面级独占操作（如打开项目弹窗）是否进行中。进行中禁止发起行操作，
   * 行操作弹窗之间的互斥由容器内部维护。
   */
  isOperationBlocked?: () => boolean;
  /** 删除确认弹窗开合变化时通知页面，供页面禁用项目打开等其他独占操作。 */
  onDeletionDialogChange?: (open: boolean) => void;
  /** 各会话的 Run 状态；归档页传空 Map 与恒 false 判定。 */
  runActivities: ReadonlyMap<string, ConversationRunMarker>;
  isRunActive: (conversationId: string) => boolean;
  newConversationDisabled?: boolean;
  onNewConversation: () => void;
  activeNav?: "mcp" | "archived";
  onOpenMcpSettings: () => void;
  onShowArchived: () => void;
  /** 项目分组内的「新建会话」入口；只有主页面提供。 */
  projectActions?: ProjectGroupActions;
  /** 容器完成 catalog 同步后的页面级后置动作（如切走当前视图、跨列表同步）。 */
  onDeleted?: (conversationId: string) => void;
  onArchived?: (conversationId: string) => void;
  onMissing?: (conversationId: string) => void;
  /** 飞书能力启用时传入，行菜单显示「绑定飞书单聊」；未传则不显示入口。 */
  onBindLark?: (conversation: ConversationSummary) => void;
}

/**
 * 侧栏容器：持有重命名、归档、删除三个会话行操作的状态与确认弹窗，渲染
 * 无状态的 {@link Sidebar}。操作落定后先同步本容器的活动会话 catalog，
 * 再调用页面传入的后置回调处理视图切换等页面差异。弹窗为 fixed 定位，
 * 与 Sidebar 同处一个 fragment 不影响布局。
 */
export const ConversationSidebarPanel = forwardRef<
  ConversationSidebarPanelHandle,
  ConversationSidebarPanelProps
>(function ConversationSidebarPanel({
  catalog,
  selectedId,
  onSelect,
  isOperationBlocked = () => false,
  onDeletionDialogChange,
  runActivities,
  isRunActive,
  newConversationDisabled = false,
  onNewConversation,
  activeNav,
  onOpenMcpSettings,
  onShowArchived,
  projectActions,
  onDeleted,
  onArchived,
  onMissing,
  onBindLark,
}, ref) {
  const deletion = useConversationDeletion({
    isBlocked: isOperationBlocked,
    isRunActive,
    onDeleted: (deletedId) => {
      catalog.remove(deletedId);
      onDeleted?.(deletedId);
    },
  });
  const rename = useConversationRename({
    isBlocked: () => isOperationBlocked() || deletion.state !== null,
    isRunActive,
    onRenamed: catalog.rename,
    onMissing: (missingId) => {
      catalog.remove(missingId);
      onMissing?.(missingId);
    },
  });
  const archive = useConversationArchive({
    isBlocked: () =>
      isOperationBlocked() ||
      deletion.state !== null ||
      rename.state !== null,
    isRunActive,
    onArchived: (archivedId) => {
      catalog.removeArchived(archivedId);
      onArchived?.(archivedId);
    },
  });

  const deletionOpen = deletion.state !== null;
  useEffect(() => {
    onDeletionDialogChange?.(deletionOpen);
  }, [deletionOpen, onDeletionDialogChange]);
  useImperativeHandle(ref, () => ({
    requestDelete: deletion.request,
  }), [deletion.request]);

  const operationBlocked = isOperationBlocked();
  // 切换只在删除确认中禁用；删除/归档再叠加页面级独占操作与各自互斥状态，
  // 与两个页面原来的禁用口径一致。
  const sidebarProjectActions =
    projectActions === undefined
      ? undefined
      : {
          ...projectActions,
          newConversationDisabled:
            projectActions.newConversationDisabled || deletionOpen,
        };

  return (
    <>
      <Sidebar
        conversations={{
          conversations: catalog.conversations,
          selectedId,
          status: catalog.state.status,
          error: catalog.state.error,
          nextCursor: catalog.state.nextCursor,
          switchingDisabled: deletionOpen,
          deletionDisabled: operationBlocked || deletionOpen,
          archiveDisabled:
            operationBlocked || deletionOpen || rename.state !== null,
          runActivities,
          projectActions: sidebarProjectActions,
          onSelect,
          onRename: rename.request,
          onArchive: archive.request,
          onDelete: deletion.request,
          onBindLark,
          onLoadMore: catalog.loadMore,
          onRetry: catalog.refresh,
        }}
        newConversationDisabled={newConversationDisabled || deletionOpen}
        onNewConversation={onNewConversation}
        activeNav={activeNav}
        onOpenMcpSettings={onOpenMcpSettings}
        onShowArchived={onShowArchived}
      />
      <DeleteConversationDialog
        state={deletion.state}
        onCancel={deletion.cancel}
        onSubmit={() => void deletion.confirm()}
      />
      <RenameConversationDialog
        state={rename.state}
        onChange={rename.change}
        onCancel={rename.cancel}
        onSubmit={() => void rename.submit()}
      />
      <ArchiveConversationDialog
        state={archive.state}
        onCancel={archive.cancel}
        onSubmit={() => void archive.confirm()}
      />
    </>
  );
});
