import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import type { ConversationService } from "../application/conversation-service.js";
import type { RunSteeringQueue } from "../application/run-steering-queue.js";
import {
  ConversationNotFoundError,
  SteeringQueueFullError,
} from "../domain/conversation.js";
import {
  MAX_PENDING_STEERING_MESSAGES,
  MAX_STEERING_MESSAGE_BYTES,
} from "../protocol.js";
import {
  writeConversationNotFound,
  writeFullAccessRequiresLoopback,
  writeHttpError,
  writeJson,
  writeUntrustedFullAccessOrigin,
} from "./http-response.js";
import { evaluateFullAccessRequest } from "./origin-policy.js";
import { parseJsonRequest } from "./request-json.js";

const steeringRequestSchema = z.strictObject({
  runId: z.string().min(1),
  input: z.string().trim().min(1),
});

export interface ConversationRunSteerRouteOptions {
  readonly conversationService: ConversationService;
  readonly steeringQueue?: RunSteeringQueue;
  readonly getActiveRunId?: (conversationId: string) => string | undefined;
  readonly allowedOrigin?: string;
  readonly fullAccessAvailable?: boolean;
}

export class ConversationRunSteerRoute {
  constructor(private readonly options: ConversationRunSteerRouteOptions) {}

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    conversationId: string,
  ): Promise<void> {
    if (
      this.options.steeringQueue === undefined ||
      this.options.getActiveRunId === undefined
    ) {
      writeHttpError(response, {
        status: 501,
        code: "STEERING_UNAVAILABLE",
        message: "Run steering is unavailable for this server.",
      });
      return;
    }

    const parsed = await parseJsonRequest(request, steeringRequestSchema, {
      code: "INVALID_REQUEST",
      message: "Request body does not match the steering schema.",
    });
    if (!parsed.ok) {
      writeHttpError(response, parsed.error);
      return;
    }
    if (
      Buffer.byteLength(parsed.data.input, "utf8") > MAX_STEERING_MESSAGE_BYTES
    ) {
      writeHttpError(response, {
        status: 422,
        code: "INVALID_REQUEST",
        message: `Steering message exceeds ${MAX_STEERING_MESSAGE_BYTES} bytes.`,
      });
      return;
    }

    let conversation;
    try {
      conversation = await this.options.conversationService.getConversation(
        conversationId,
      );
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        writeConversationNotFound(response);
        return;
      }
      throw error;
    }

    // 转向消息由模型当作用户指令执行，因此与发起 Run 同等的门禁要求。
    const accessDecision = evaluateFullAccessRequest(
      conversation.executionMode,
      this.options.fullAccessAvailable,
      request,
      this.options.allowedOrigin,
    );
    if (accessDecision === "requires_loopback") {
      writeFullAccessRequiresLoopback(response);
      return;
    }
    if (accessDecision === "untrusted_origin") {
      writeUntrustedFullAccessOrigin(response);
      return;
    }

    if (conversation.archived) {
      writeHttpError(response, {
        status: 409,
        code: "CONVERSATION_ARCHIVED",
        message: "Conversation is archived.",
      });
      return;
    }

    const activeRunId = this.options.getActiveRunId(conversationId);
    if (activeRunId === undefined) {
      writeHttpError(response, {
        status: 409,
        code: "CONVERSATION_IDLE",
        message: "This conversation has no active run to steer.",
      });
      return;
    }
    if (parsed.data.runId !== activeRunId) {
      writeHttpError(response, {
        status: 409,
        code: "STEERING_RUN_MISMATCH",
        message: "The supplied runId does not match the active run.",
      });
      return;
    }

    try {
      const seq = this.options.steeringQueue.enqueue(
        activeRunId,
        parsed.data.input,
      );
      writeJson(response, 202, {
        runId: activeRunId,
        seq,
        status: "queued",
      });
    } catch (error) {
      if (error instanceof SteeringQueueFullError) {
        writeHttpError(response, {
          status: 409,
          code: "STEERING_QUEUE_FULL",
          message:
            `At most ${MAX_PENDING_STEERING_MESSAGES} steering messages may be queued.`,
        });
        return;
      }
      throw error;
    }
  }
}
