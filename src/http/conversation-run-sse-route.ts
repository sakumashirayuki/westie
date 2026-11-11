import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import type { ConversationService } from "../application/conversation-service.js";
import type { RunRegistry } from "../application/run-registry.js";
import {
  ConversationArchivedError,
  ConversationBusyError,
  ConversationNotFoundError,
} from "../domain/conversation.js";
import {
  writeConversationNotFound,
  writeFullAccessRequiresLoopback,
  writeHttpError,
  writeUntrustedFullAccessOrigin,
} from "./http-response.js";
import { evaluateFullAccessRequest } from "./origin-policy.js";
import { parseJsonRequest } from "./request-json.js";
import { watchClientDisconnect } from "./client-disconnect.js";
import { writeSseEvent } from "./sse.js";

const runRequestSchema = z.strictObject({
  input: z.string().trim().min(1),
  maxSteps: z.number().int().positive().max(512).optional(),
});

export interface ConversationRunSseRouteOptions {
  readonly conversationService: ConversationService;
  readonly registry: RunRegistry;
  readonly allowedOrigin?: string;
  readonly fullAccessAvailable?: boolean;
}

export class ConversationRunSseRoute {
  constructor(private readonly options: ConversationRunSseRouteOptions) {}

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    conversationId: string,
  ): Promise<void> {
    const parsed = await parseJsonRequest(request, runRequestSchema, {
      code: "INVALID_REQUEST",
      message: "Request body does not match the run schema.",
    });
    if (!parsed.ok) {
      writeHttpError(response, parsed.error);
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

    let runId: string;
    try {
      ({ runId } = this.options.registry.start({
        conversationId,
        input: parsed.data.input,
        ...(parsed.data.maxSteps === undefined
          ? {}
          : { maxSteps: parsed.data.maxSteps }),
      }));
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
          message: "Conversation is archived.",
        });
        return;
      }
      throw error;
    }

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Run-Id": runId,
    });
    response.flushHeaders();

    // 从头推送 Run 事件；连接断开时结束订阅，Run 继续执行。
    const watcher = watchClientDisconnect(request, response);
    try {
      const iterable = this.options.registry.subscribe(
        runId,
        0,
        watcher.signal,
      );
      for await (const event of iterable) {
        await writeSseEvent(response, event, watcher.signal, runId);
      }
      if (!response.destroyed) response.end();
    } finally {
      watcher.release();
    }
  }
}
