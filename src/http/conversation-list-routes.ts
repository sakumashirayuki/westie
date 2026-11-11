import type { IncomingMessage, ServerResponse } from "node:http";

import {
  InvalidConversationListRequestError,
  MAX_CONVERSATION_LIST_LIMIT,
  type ConversationService,
} from "../application/conversation-service.js";
import type { ConversationSummaryView } from "../domain/conversation.js";
import { writeHttpError, writeJson } from "./http-response.js";
import { defineRoute } from "./route.js";

export interface ConversationListRoutesOptions {
  readonly conversationService: ConversationService;
}

/** 会话列表与分页。只读，不要求 Origin。 */
export class ConversationListRoutes {
  constructor(private readonly options: ConversationListRoutesOptions) {}

  readonly route = defineRoute(
    {
      methods: ["GET"],
      origin: "public",
      denyMessage: "This origin cannot list conversations.",
      handle: ({ request, response }) => this.#list(request, response),
    },
    {},
  );

  async #list(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const keys = [...url.searchParams.keys()];
      if (
        keys.some(
          (key) =>
            key !== "limit" && key !== "cursor" && key !== "archived",
        ) ||
        url.searchParams.getAll("limit").length > 1 ||
        url.searchParams.getAll("cursor").length > 1 ||
        url.searchParams.getAll("archived").length > 1
      ) {
        throw new InvalidConversationListRequestError();
      }
      const rawLimit = url.searchParams.get("limit");
      const rawCursor = url.searchParams.get("cursor");
      const rawArchived = url.searchParams.get("archived");
      const limit = rawLimit === null
        ? undefined
        : parseConversationListLimit(rawLimit);
      const page = await this.options.conversationService.listConversations({
  ...(limit === undefined ? {} : { limit }),
  ...(rawCursor === null ? {} : { cursor: rawCursor }),
  ...(rawArchived === null
    ? {}
    : { archived: parseArchived(rawArchived) }),
});
      writeJson(response, 200, {
        items: page.items.map(toConversationListItem),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      if (error instanceof InvalidConversationListRequestError) {
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
}

/** 列表只返回用于项目分组和会话摘要展示的数据；详情接口返回完整工作目录状态。 */
function toConversationListItem(conversation: ConversationSummaryView) {
  return {
    id: conversation.id,
    revision: conversation.revision,
    executionMode: conversation.executionMode,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    workspace: { name: conversation.workspace.name },
    project: conversation.project,
    workspaceKind: conversation.workspaceKind,
    archived: conversation.archived,
  };
}

function parseArchived(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new InvalidConversationListRequestError();
}

function parseConversationListLimit(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new InvalidConversationListRequestError();
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > MAX_CONVERSATION_LIST_LIMIT) {
    throw new InvalidConversationListRequestError();
  }
  return limit;
}
