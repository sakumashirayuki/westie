import { useState } from "react";

import { conversationRenameErrorMessage } from "../error-messages";
import {
  HttpRunError,
  renameConversation,
  type ConversationSummary,
} from "../run-client";

export interface ConversationRenameState {
  /** 正在改名的会话；关闭时为 null。 */
  readonly conversation: ConversationSummary;
  readonly draft: string;
  readonly status: "editing" | "submitting";
  readonly error?: string;
}

export interface ConversationRenameOptions {
  /** 此刻是否不允许开始改名（正在打开项目、正在删除等）。 */
  readonly isBlocked: () => boolean;
  /** 这个会话当前是否有 Run 在跑；运行中的会话不能改名。 */
  readonly isRunActive: (conversationId: string) => boolean;
  /** 服务端落定后调用，用返回的 summary 更新列表。 */
  readonly onRenamed: (conversation: ConversationSummary) => void;
  /**
   * 服务端说这个会话已不存在（404）时调用。与删除流程一致：会话在别处被删掉，
   * 本地列表也要移除，避免留下点不开的幽灵行。
   */
  readonly onMissing: (conversationId: string) => void;
}

/**
 * 会话改名的编辑状态与提交流程。草稿去掉首尾空白后为空即清除标题，
 * 与服务端 `title: null` 的语义一致。
 */
export function useConversationRename({
  isBlocked,
  isRunActive,
  onRenamed,
  onMissing,
}: ConversationRenameOptions) {
  const [state, setState] = useState<ConversationRenameState | null>(null);

  function request(target: ConversationSummary): void {
    if (isBlocked() || state !== null) return;
    if (isRunActive(target.id)) {
      setState({
        conversation: target,
        draft: target.title ?? target.workspace.name,
        status: "editing",
        error: "会话正在运行，请等待运行结束后再改名。",
      });
      return;
    }
    setState({
      conversation: target,
      draft: target.title ?? target.workspace.name,
      status: "editing",
    });
  }

  function change(draft: string): void {
    setState((current) =>
      current === null ? null : { ...current, draft, error: undefined }
    );
  }

  async function submit(): Promise<void> {
    if (state === null || state.status === "submitting") return;
    const target = state.conversation;
    if (isRunActive(target.id)) {
      setState({
        ...state,
        error: "会话正在运行，请等待运行结束后再改名。",
      });
      return;
    }
    const trimmed = state.draft.trim();
    const title = trimmed.length === 0 ? null : trimmed;
    const isUnchanged =
      title === target.title ||
      (target.title === null && state.draft === target.workspace.name);
    if (isUnchanged) {
      setState(null);
      return;
    }
    setState({ ...state, status: "submitting" });
    try {
      const renamed = await renameConversation(target.id, title);
      setState(null);
      onRenamed(renamed);
    } catch (error) {
      if (error instanceof HttpRunError && error.status === 404) {
        setState(null);
        onMissing(target.id);
        return;
      }
      setState({
        ...state,
        status: "editing",
        error: conversationRenameErrorMessage(error),
      });
    }
  }

  function cancel(): void {
    setState(null);
  }

  return { state, request, change, submit, cancel };
}
