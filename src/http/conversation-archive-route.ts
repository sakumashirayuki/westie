import type { IncomingMessage, ServerResponse } from "node:http";

import type { ConversationService } from "../application/conversation-service.js";
import {
  ConversationArchivedError,
  ConversationBusyError,
  ConversationNotFoundError,
  ConversationWorkspaceSharedError,
} from "../domain/conversation.js";
import {
  writeConversationNotFound,
  writeHttpError,
} from "./http-response.js";

export interface ConversationArchiveRouteOptions {
  readonly conversationService: ConversationService;
}

/**
 * `POST /v1/agent/conversations/:id:archive`：归档一个没有活动 Run 的会话。
 * 归档同时清理该会话创建的 worktree；成功后返回 204。方法与 Origin 由
 * `AgentController` 的 `guardRoute` 统一校验。
 */
export class ConversationArchiveRoute {
  constructor(private readonly options: ConversationArchiveRouteOptions) {}

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    conversationId: string,
  ): Promise<void> {
    try {
      await this.options.conversationService.archiveConversation(conversationId);
      response.writeHead(204);
      response.end();
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        writeConversationNotFound(response);
        return;
      }
      if (error instanceof ConversationBusyError) {
        writeHttpError(response, {
          status: 409,
          code: "CONVERSATION_BUSY",
          message: "Conversation already has an active run.",
        });
        return;
      }
      if (error instanceof ConversationArchivedError) {
        writeHttpError(response, {
          status: 409,
          code: "CONVERSATION_ARCHIVED",
          message: "Conversation is already archived.",
        });
        return;
      }
      if (error instanceof ConversationWorkspaceSharedError) {
        writeHttpError(response, {
          status: 409,
          code: "CONVERSATION_WORKSPACE_SHARED",
          message: error.message,
        });
        return;
      }
      throw error;
    }
  }
}