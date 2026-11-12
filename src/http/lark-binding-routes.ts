import type { IncomingMessage, ServerResponse } from "node:http";

import type { ConversationService } from "../application/conversation-service.js";
import type { LarkBindingTokenStore } from "../application/lark-binding-token-store.js";
import type { LarkBindingStore } from "../infrastructure/sqlite/lark-binding-store.js";
import { ConversationNotFoundError } from "../domain/conversation.js";
import { writeConversationNotFound, writeHttpError, writeJson } from "./http-response.js";
import { defineRoute } from "./route.js";

export interface LarkBindingRoutesOptions {
  readonly bindingStore: LarkBindingStore;
  readonly tokenStore: LarkBindingTokenStore;
  readonly conversationService: ConversationService;
  /** 桥接是否已配置凭证；未配置时变更接口返回 501。 */
  readonly bridgeEnabled: boolean;
  readonly allowedOrigin?: string;
}

/**
 * 网页使用的飞书绑定接口：能力查询、绑定码签发、绑定状态查询与解绑。
 *
 * - `GET /lark/capability` 只返回是否配置了凭证，不返回任何密钥；为假时前端不
 *   显示绑定入口。
 * - 签发绑定码是变更操作（trusted Origin）；重复调用会作废旧码。
 * - 所有写入以数据库约束为最终裁决，返回结果与前端展示一致。
 */
export class LarkBindingRoutes {
  constructor(private readonly options: LarkBindingRoutesOptions) {}

  readonly capability = defineRoute(
    {
      methods: ["GET"],
      origin: "public",
      denyMessage: "This origin cannot query Lark capability.",
      handle: ({ response }) =>
        writeJson(response, 200, { enabled: this.options.bridgeEnabled }),
    },
    {},
  );

  readonly issueCode = defineRoute(
    {
      methods: ["POST"],
      origin: "trusted",
      denyMessage: "This origin cannot issue a Lark binding code.",
      handle: ({ request, response }) => this.#issueCode(request, response),
    },
    {},
  );

  readonly getBinding = defineRoute(
    {
      methods: ["GET"],
      origin: "public",
      denyMessage: "This origin cannot read a Lark binding.",
      handle: ({ request, response }) => this.#getBinding(request, response),
    },
    {},
  );

  readonly unbind = defineRoute(
    {
      methods: ["DELETE"],
      origin: "trusted",
      denyMessage: "This origin cannot unbind a Lark chat.",
      handle: ({ request, response }) => this.#unbind(request, response),
    },
    {},
  );

  async #issueCode(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const conversationId = readConversationId(request.url);
    if (conversationId === undefined) {
      writeConversationNotFound(response);
      return;
    }
    if (!this.options.bridgeEnabled) {
      writeBridgeDisabled(response);
      return;
    }
    try {
      await this.options.conversationService.getConversation(conversationId);
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        writeConversationNotFound(response);
        return;
      }
      throw error;
    }
    const issued = this.options.tokenStore.issue(conversationId);
    writeJson(response, 200, {
      code: issued.code,
      expiresAt: issued.expiresAt,
    });
  }

  #getBinding(request: IncomingMessage, response: ServerResponse): void {
    const conversationId = readConversationId(request.url);
    if (conversationId === undefined) {
      writeConversationNotFound(response);
      return;
    }
    if (!this.options.bridgeEnabled) {
      writeBridgeDisabled(response);
      return;
    }
    const binding = this.options.bindingStore.findByConversationId(conversationId);
    if (binding === undefined) {
      writeJson(response, 200, { bound: false });
      return;
    }
    writeJson(response, 200, { bound: true, createdAt: binding.createdAt });
  }

  #unbind(request: IncomingMessage, response: ServerResponse): void {
    const conversationId = readConversationId(request.url);
    if (conversationId === undefined) {
      writeConversationNotFound(response);
      return;
    }
    if (!this.options.bridgeEnabled) {
      writeBridgeDisabled(response);
      return;
    }
    this.options.bindingStore.unbindByConversationId(conversationId);
    writeJson(response, 200, {});
  }
}

export function writeBridgeDisabled(response: ServerResponse): void {
  writeHttpError(response, {
    status: 501,
    code: "LARK_BRIDGE_DISABLED",
    message: "The Lark bridge is not configured.",
  });
}

function readConversationId(url: string | undefined): string | undefined {
  const match = /^\/v1\/agent\/conversations\/([^/]+)\/lark-binding/.exec(
    new URL(url ?? "/", "http://localhost").pathname,
  );
  return match?.[1];
}