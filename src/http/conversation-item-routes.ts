import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import {
  InvalidConversationTitleError,
  type ConversationService,
} from "../application/conversation-service.js";
import {
  ConversationArchivedError,
  ConversationBusyError,
  ConversationNotFoundError,
} from "../domain/conversation.js";
import type { LarkBindingStore } from "../infrastructure/sqlite/lark-binding-store.js";
import {
  writeConversationNotFound,
  writeHttpError,
  writeJson,
} from "./http-response.js";
import { parseJsonRequest } from "./request-json.js";
import { defineRoute } from "./route.js";

const renameRequestSchema = z.strictObject({
  // 长度上限由 ConversationService 校验，这里只约束类型。
  title: z.string().nullable(),
});

export interface ConversationItemRoutesOptions {
  readonly conversationService: ConversationService;
  readonly allowedOrigin?: string;
  /** 详情装饰 `larkBound` 字段；缺省时不查绑定（false）。 */
  readonly larkBindingStore?: LarkBindingStore;
}

/**
 * 单个会话的三个操作挂在同一路径 `/v1/agent/conversations/:id` 上。
 *
 * 三者共用一条 `defineRoute`：方法校验、`Allow` 头和 Origin 校验只声明一次，
 * 处理函数只按方法分发。`Allow` 头因此不会与实际支持的方法脱节，新增方法也不会
 * 落进“兜底分支”被当成读详情处理。
 */
export class ConversationItemRoutes {
  private readonly options: ConversationItemRoutesOptions;
  readonly route: (request: IncomingMessage, response: ServerResponse) => Promise<void>;

  constructor(options: ConversationItemRoutesOptions) {
    this.options = options;
    this.route = defineRoute(
      {
        methods: ["GET", "PATCH", "DELETE"],
        origin: "trusted",
        denyMessage: "This origin cannot modify a conversation.",
        handle: ({ request, response }) => this.#dispatch(request, response),
      },
      {
        ...(options.allowedOrigin === undefined
          ? {}
          : { allowedOrigin: options.allowedOrigin }),
      },
    );
  }

  #dispatch(
    request: IncomingMessage,
    response: ServerResponse,
  ): void | Promise<void> {
    const conversationId = readConversationId(request.url);
    if (conversationId === undefined) {
      writeConversationNotFound(response);
      return;
    }
    if (request.method === "GET") {
      return this.#getConversation(response, conversationId);
    }
    if (request.method === "PATCH") {
      return this.#renameConversation(request, response, conversationId);
    }
    // defineRoute 已排除其它方法，这里只剩 DELETE。
    this.#deleteConversation(response, conversationId);
  }

  async #getConversation(
    response: ServerResponse,
    conversationId: string,
  ): Promise<void> {
    try {
      const conversation = await this.options.conversationService.getConversation(
        conversationId,
      );
      const larkBound = this.options.larkBindingStore?.findByConversationId(
        conversationId,
      ) !== undefined;
      writeJson(response, 200, { ...conversation, larkBound });
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        writeConversationNotFound(response);
        return;
      }
      throw error;
    }
  }

  async #renameConversation(
    request: IncomingMessage,
    response: ServerResponse,
    conversationId: string,
  ): Promise<void> {
    const parsed = await parseJsonRequest(request, renameRequestSchema, {
      code: "INVALID_REQUEST",
      message: "Request body does not match the rename schema.",
    });
    if (!parsed.ok) {
      writeHttpError(response, parsed.error);
      return;
    }
    try {
      writeJson(
        response,
        200,
        await this.options.conversationService.renameConversation(
          conversationId,
          parsed.data.title,
        ),
      );
    } catch (error) {
      this.#writeConversationError(response, error);
    }
  }

  #deleteConversation(response: ServerResponse, conversationId: string): void {
    try {
      this.options.conversationService.deleteConversation(conversationId);
      response.writeHead(204);
      response.end();
    } catch (error) {
      this.#writeConversationError(response, error);
    }
  }

  /** 改名与删除共用的错误映射：不存在 404，有活跃 Run 409，已归档 409。 */
  #writeConversationError(response: ServerResponse, error: unknown): void {
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
    if (error instanceof InvalidConversationTitleError) {
      writeHttpError(response, {
        status: 422,
        code: "INVALID_REQUEST",
        message: error.message,
      });
      return;
    }
    throw error;
  }
}

/** 从 `/v1/agent/conversations/<id>` 取 id；路径形状由 `AgentController` 保证。 */
function readConversationId(url: string | undefined): string | undefined {
  const match = /^\/v1\/agent\/conversations\/([^/]+)$/.exec(
    new URL(url ?? "/", "http://localhost").pathname,
  );
  return match?.[1];
}
