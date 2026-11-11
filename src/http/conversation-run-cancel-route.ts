import type { IncomingMessage, ServerResponse } from "node:http";

import type { ConversationService } from "../application/conversation-service.js";
import type { RunRegistry } from "../application/run-registry.js";
import {
  findRunStatus,
  getAccessibleRunConversation,
} from "./conversation-run-access.js";
import { writeHttpError, writeJson } from "./http-response.js";

export interface ConversationRunCancelRouteOptions {
  readonly conversationService: ConversationService;
  readonly registry: RunRegistry;
  readonly allowedOrigin?: string;
  readonly fullAccessAvailable?: boolean;
}

/**
 * 取消 Run：`registry.cancel`，返回 `202 { runId, status: "cancelling" }`。
 * 幂等：已在取消中也返回 202。
 */
export class ConversationRunCancelRoute {
  constructor(private readonly options: ConversationRunCancelRouteOptions) {}

  /** 方法校验、Origin 校验与 Allow 头由挂载处的 defineRoute 负责。 */
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    conversationId: string,
    runId: string,
  ): Promise<void> {
    const conversation = await getAccessibleRunConversation(
      request,
      response,
      conversationId,
      this.options,
    );
    if (conversation === undefined) return;

    const active = this.options.registry.getByConversation(
      conversationId,
      runId,
    );
    if (active === undefined) {
      // Run 不在 registry 时，根据会话中的 Run 状态返回 404 或 409。
      const runStatus = findRunStatus(conversation, runId);
      if (runStatus === undefined) {
        writeHttpError(response, {
          status: 404,
          code: "NOT_FOUND",
          message: "Run was not found in this conversation.",
        });
        return;
      }
      if (runStatus === "running") {
        writeHttpError(response, {
          status: 409,
          code: "RUN_NOT_ACTIVE",
          message: "The run is not active.",
        });
        return;
      }
      writeHttpError(response, {
        status: 409,
        code: "RUN_NOT_ACTIVE",
        message: "The run has already ended.",
      });
      return;
    }

    const result = this.options.registry.cancel(
      runId,
      "Run cancelled by request.",
    );
    if (result === "not_found") {
      writeHttpError(response, {
        status: 409,
        code: "RUN_NOT_ACTIVE",
        message: "The run has already ended.",
      });
      return;
    }
    writeJson(response, 202, { runId, status: "cancelling" });
  }
}
