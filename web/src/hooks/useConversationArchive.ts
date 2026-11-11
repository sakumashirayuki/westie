import { useState } from "react";

import type { ArchiveConversationDialogState } from "../components/ArchiveConversationDialog";
import { conversationArchiveErrorMessage } from "../error-messages";
import {
  archiveConversation,
  HttpRunError,
  type ConversationSummary,
} from "../run-client";

export interface ConversationArchiveOptions {
  /** 此刻是否不允许开始归档（运行中、正在打开项目等）。 */
  readonly isBlocked: () => boolean;
  /** 确认时这个会话是否有 Run 在跑；运行中的会话不能归档。 */
  readonly isRunActive: (conversationId: string) => boolean;
  /** 归档落定（包括服务端已不存在）后调用，由页面决定是否清掉当前会话。 */
  readonly onArchived: (conversationId: string) => void;
}

/** 归档会话的确认弹窗状态与提交流程。 */
export function useConversationArchive({
  isBlocked,
  isRunActive,
  onArchived,
}: ConversationArchiveOptions) {
  const [state, setState] = useState<ArchiveConversationDialogState | null>(null);

  function request(target: ConversationSummary): void {
    if (isBlocked() || state !== null) return;
    setState({ conversation: target, status: "confirming" });
  }

  async function confirm(): Promise<void> {
    if (state === null || state.status === "submitting") return;
    const target = state.conversation;
    if (isRunActive(target.id)) {
      setState({
        conversation: target,
        status: "error",
        error: "会话正在运行，请等待运行结束后再归档。",
      });
      return;
    }
    setState({ conversation: target, status: "submitting" });
    try {
      await archiveConversation(target.id);
    } catch (error) {
      // 服务端已经没有这个会话，结果与归档成功相同。
      if (!(error instanceof HttpRunError && error.status === 404)) {
        setState({
          conversation: target,
          status: "error",
          error: conversationArchiveErrorMessage(error),
        });
        return;
      }
    }
    setState(null);
    onArchived(target.id);
  }

  function cancel(): void {
    setState(null);
  }

  return { state, request, confirm, cancel };
}