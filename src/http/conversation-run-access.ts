import type { IncomingMessage, ServerResponse } from "node:http";

import type { ConversationService } from "../application/conversation-service.js";
import {
  ConversationNotFoundError,
  type ConversationView,
} from "../domain/conversation.js";
import {
  writeConversationNotFound,
  writeFullAccessRequiresLoopback,
  writeUntrustedFullAccessOrigin,
} from "./http-response.js";
import { evaluateFullAccessRequest } from "./origin-policy.js";

interface ConversationRunAccessOptions {
  readonly conversationService: ConversationService;
  readonly allowedOrigin?: string;
  readonly fullAccessAvailable?: boolean;
}

/** 获取会话并校验访问条件；拒绝时写入错误响应。 */
export async function getAccessibleRunConversation(
  request: IncomingMessage,
  response: ServerResponse,
  conversationId: string,
  options: ConversationRunAccessOptions,
): Promise<ConversationView | undefined> {
  let conversation: ConversationView;
  try {
    conversation = await options.conversationService.getConversation(
      conversationId,
    );
  } catch (error) {
    if (error instanceof ConversationNotFoundError) {
      writeConversationNotFound(response);
      return;
    }
    throw error;
  }

  const accessDecision = evaluateFullAccessRequest(
    conversation.executionMode,
    options.fullAccessAvailable,
    request,
    options.allowedOrigin,
  );
  if (accessDecision === "requires_loopback") {
    writeFullAccessRequiresLoopback(response);
    return;
  }
  if (accessDecision === "untrusted_origin") {
    writeUntrustedFullAccessOrigin(response);
    return;
  }

  return conversation;
}

export function findRunStatus(
  conversation: ConversationView,
  runId: string,
): "running" | "completed" | "failed" | "cancelled" | undefined {
  for (const turn of conversation.turns) {
    for (const run of turn.runs) {
      if (run.id === runId) return run.status;
    }
  }
  return undefined;
}
