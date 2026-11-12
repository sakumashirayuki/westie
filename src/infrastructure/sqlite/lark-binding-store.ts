import type { DatabaseSync } from "node:sqlite";

import { ConversationNotFoundError } from "../../domain/conversation.js";

/** 入站消息去重记录仅保留 24 小时。 */
export const LARK_INBOUND_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface LarkChatBinding {
  readonly chatId: string;
  readonly openId: string;
  readonly conversationId: string;
  readonly createdAt: string;
}

export type BindResult =
  | { readonly status: "bound" }
  | { readonly status: "chat_already_bound" }
  | { readonly status: "conversation_already_bound" };

/**
 * 「飞书单聊 ↔ 会话」绑定关系与入站消息去重记录的读写。
 *
 * 绑定关系以 `chat_id` 为主键（一个单聊至多一行），`conversation_id` 有 UNIQUE
 * 约束并外键指向 `conversations(id)`，会话删除时级联删除绑定行。并发抢绑由
 * 数据库约束裁决，调用方通过声明式返回值区分结果。所有列都是普通文本，不存
 * JSON。
 */
export class LarkBindingStore {
  constructor(private readonly database: DatabaseSync) {}

  /** 插入绑定行。冲突时由调用方按返回结果区分「单聊已绑」与「会话已绑」。 */
  bind(binding: LarkChatBinding): BindResult {
    try {
      this.database.prepare(`
        INSERT INTO lark_chat_bindings (chat_id, open_id, conversation_id, created_at)
        VALUES ($chatId, $openId, $conversationId, $createdAt)
      `).run({
        "$chatId": binding.chatId,
        "$openId": binding.openId,
        "$conversationId": binding.conversationId,
        "$createdAt": binding.createdAt,
      });
      return { status: "bound" };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const chatBound = this.findByChatId(binding.chatId) !== undefined;
        return chatBound
          ? { status: "chat_already_bound" }
          : { status: "conversation_already_bound" };
      }
      // 会话已被删除时外键约束失败：转成领域错误，交由路由层提示用户重新绑定，
      // 避免原始 SQLite 错误穿透到 worker 被静默吞掉。
      if (isForeignKeyViolation(error)) {
        throw new ConversationNotFoundError(binding.conversationId);
      }
      throw error;
    }
  }

  findByChatId(chatId: string): LarkChatBinding | undefined {
    const row = this.database.prepare(`
      SELECT chat_id, open_id, conversation_id, created_at
      FROM lark_chat_bindings
      WHERE chat_id = $chatId
    `).get({ "$chatId": chatId });
    return row === undefined ? undefined : mapBindingRow(row);
  }

  findByConversationId(conversationId: string): LarkChatBinding | undefined {
    const row = this.database.prepare(`
      SELECT chat_id, open_id, conversation_id, created_at
      FROM lark_chat_bindings
      WHERE conversation_id = $conversationId
    `).get({ "$conversationId": conversationId });
    return row === undefined ? undefined : mapBindingRow(row);
  }

  /** 给定多个会话 id，返回其中已经绑定的会话 id 集合。 */
  findBoundConversationIds(
    conversationIds: readonly string[],
  ): ReadonlySet<string> {
    if (conversationIds.length === 0) return new Set();
    const placeholders = conversationIds.map(() => "?").join(",");
    const rows = this.database
      .prepare(
        `SELECT conversation_id FROM lark_chat_bindings
         WHERE conversation_id IN (${placeholders})`,
      )
      .all(...conversationIds) as unknown;
    const result = new Set<string>();
    for (const row of rows as Array<Record<string, unknown>>) {
      result.add(String(row.conversation_id));
    }
    return result;
  }

  /** 删除绑定。重复删除返回 0，调用方按幂等处理。 */
  unbindByChatId(chatId: string): boolean {
    const deleted = this.database.prepare(`
      DELETE FROM lark_chat_bindings WHERE chat_id = $chatId
    `).run({ "$chatId": chatId });
    return deleted.changes === 1;
  }

  /** 按会话删除绑定（网页入口主键是 conversation_id）。重复删除按幂等处理。 */
  unbindByConversationId(conversationId: string): boolean {
    const deleted = this.database.prepare(`
      DELETE FROM lark_chat_bindings WHERE conversation_id = $conversationId
    `).run({ "$conversationId": conversationId });
    return deleted.changes === 1;
  }

  /** 去重记录：插入冲突即已处理过，返回 false。 */
  ensureInboundMessageSeen(messageId: string, chatId: string, receivedAt: string): boolean {
    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO lark_inbound_messages (message_id, chat_id, received_at)
      VALUES ($messageId, $chatId, $receivedAt)
    `).run({
      "$messageId": messageId,
      "$chatId": chatId,
      "$receivedAt": receivedAt,
    });
    return inserted.changes === 1;
  }

  /** 清理 24 小时前的去重记录，返回删除的行数。 */
  purgeOldInboundMessages(before: string): number {
    const deleted = this.database.prepare(`
      DELETE FROM lark_inbound_messages WHERE received_at < $before
    `).run({ "$before": before });
    return Number(deleted.changes);
  }
}

function mapBindingRow(row: Record<string, unknown>): LarkChatBinding {
  return {
    chatId: String(row.chat_id),
    openId: String(row.open_id),
    conversationId: String(row.conversation_id),
    createdAt: String(row.created_at),
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes("UNIQUE constraint failed");
  }
  return false;
}

function isForeignKeyViolation(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes("FOREIGN KEY constraint failed");
  }
  return false;
}
