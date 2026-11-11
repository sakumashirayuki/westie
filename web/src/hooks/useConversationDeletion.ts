import { useState } from "react";

import type { DeleteConversationDialogState } from "../components/DeleteConversationDialog";
import { conversationDeletionErrorMessage } from "../error-messages";
import {
  deleteConversation,
  HttpRunError,
  type ConversationSummary,
} from "../run-client";

export interface ConversationDeletionOptions {
  /** 此刻是否不允许开始删除（运行中、正在打开项目等）。 */
  readonly isBlocked: () => boolean;
  /** 确认时这个会话是否有 Run 在跑；运行中的会话不能删。 */
  readonly isRunActive: (conversationId: string) => boolean;
  /** 删除落定（包括服务端已不存在）后调用，由页面决定是否清掉当前会话。 */
  readonly onDeleted: (conversationId: string) => void;
}

/** 删除会话的确认弹窗状态与提交流程。 */
export function useConversationDeletion({
  isBlocked,
  isRunActive,
  onDeleted,
}: ConversationDeletionOptions) {
  const [state, setState] = useState<DeleteConversationDialogState | null>(null);

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
        error: "会话正在运行，请等待运行结束后再删除。",
      });
      return;
    }
    setState({ conversation: target, status: "submitting" });
    try {
      await deleteConversation(target.id);
    } catch (error) {
      // 服务端已经没有这个会话，结果与删除成功相同。
      if (!(error instanceof HttpRunError && error.status === 404)) {
        setState({
          conversation: target,
          status: "error",
          error: conversationDeletionErrorMessage(error),
        });
        return;
      }
    }
    setState(null);
    onDeleted(target.id);
  }

  function cancel(): void {
    setState(null);
  }

  return { state, request, confirm, cancel };
}
