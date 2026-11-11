import type { ConversationSummary } from "../run-client";

/**
 * 侧栏显示名：用户设置的标题优先，没有标题时回退到工作区目录名。
 * 服务端对 `title` 只做 trim 校验，空串不会落库，这里只需处理 null。
 */
export function conversationDisplayName(
  conversation: Pick<ConversationSummary, "title" | "workspace">,
): string {
  return conversation.title ?? conversation.workspace.name;
}
