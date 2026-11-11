import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConversationService } from "../application/conversation-service.js";
import { RunRegistryNotReplayableError, type RunRegistry } from "../application/run-registry.js";
import {
  findRunStatus,
  getAccessibleRunConversation,
} from "./conversation-run-access.js";
import { writeHttpError } from "./http-response.js";
import { writeSseEvent } from "./sse.js";
import { watchClientDisconnect } from "./client-disconnect.js";

export interface ConversationRunEventsRouteOptions {
  readonly conversationService: ConversationService;
  readonly registry: RunRegistry;
  readonly allowedOrigin?: string;
  readonly fullAccessAvailable?: boolean;
}

/**
 * 启动之后的所有订阅都走这里：断线重连、刷新页面、切回会话、另开标签页。
 * 从 `Last-Event-ID`（`{runId}:{seq}`）或 `?after={seq}` 之后续传，都没有则从头
 * 回放，然后接上实时事件。
 */
export class ConversationRunEventsRoute {
  constructor(private readonly options: ConversationRunEventsRouteOptions) {}

  /** 方法校验与 Allow 头由挂载处的 defineRoute 负责。 */
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
      // Run 不在 registry：查数据库里的状态。
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
          status: 410,
          code: "RUN_STREAM_NOT_REPLAYABLE",
          message: "The run's event stream cannot be replayed.",
        });
        return;
      }
      writeHttpError(response, {
        status: 410,
        code: "RUN_STREAM_ENDED",
        message: "The run has already ended.",
      });
      return;
    }

    const snapshot = new URL(request.url ?? "/", "http://localhost").searchParams.get("snapshot") === "1";
    const watcher = watchClientDisconnect(request, response);
    try {
      const live = snapshot
        ? this.options.registry.subscribeSnapshot(runId, watcher.signal)
        : this.options.registry.subscribe(runId, parseAfterSeq(request, runId), watcher.signal);
      writeSseHead(response);
      for await (const event of live) {
        await writeSseEvent(response, event, watcher.signal, runId);
      }
      if (!response.destroyed) response.end();
    } catch (error) {
      if (error instanceof RunRegistryNotReplayableError && !response.headersSent) {
        writeHttpError(response, {
          status: 410, code: "RUN_STREAM_NOT_REPLAYABLE",
          message: "The run's event stream cannot be replayed.",
        });
        return;
      }
      throw error;
    } finally {
      watcher.release();
    }
  }
}

function writeSseHead(response: ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
}

function parseAfterSeq(request: IncomingMessage, runId: string): number {
  const lastEventId = request.headers["last-event-id"];
  if (typeof lastEventId === "string") {
    const colon = lastEventId.lastIndexOf(":");
    if (colon !== -1) {
      const head = lastEventId.slice(0, colon);
      // Last-Event-ID 中的 runId 与路径 runId 不一致时忽略该头。
      if (head === runId) {
        const seq = Number(lastEventId.slice(colon + 1));
        if (Number.isSafeInteger(seq) && seq >= 0) return seq;
      }
    }
  }
  const url = new URL(request.url ?? "/", "http://localhost");
  const after = url.searchParams.get("after");
  if (after !== null) {
    const seq = Number(after);
    if (Number.isSafeInteger(seq) && seq >= 0) return seq;
  }
  return 0;
}
