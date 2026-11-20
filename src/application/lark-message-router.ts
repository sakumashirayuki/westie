import type { LarkBindingStore, LarkChatBinding } from "../infrastructure/sqlite/lark-binding-store.js";
import type { LarkBindingTokenStore } from "./lark-binding-token-store.js";
import type { ConversationService } from "./conversation-service.js";
import type { ConversationStore } from "./conversation-store.js";
import type { RunRegistry } from "./run-registry.js";
import type { RunSteeringQueue } from "./run-steering-queue.js";
import type { LarkRunBridge } from "./lark-run-bridge.js";
import type { LarkOutbound } from "./lark-outbound.js";
import {
  ConversationBusyError,
  ConversationNotFoundError,
  SteeringQueueFullError,
} from "../domain/conversation.js";
import {
  MAX_PENDING_STEERING_MESSAGES,
  MAX_STEERING_MESSAGE_BYTES,
  ProtocolError,
} from "../protocol.js";

export const UNBIND_COMMANDS = ["/unbind", "/解绑"];

export interface InboundMessageContext {
  readonly chatId: string;
  readonly chatType: string;
  readonly senderType: string;
  readonly senderOpenId: string;
  readonly messageId: string;
  readonly messageType: string;
  readonly text: string;
}

export interface LarkMessageRouterOptions {
  readonly store: LarkBindingStore;
  readonly tokenStore: LarkBindingTokenStore;
  readonly allowedOpenIds: ReadonlySet<string>;
  readonly conversationService: ConversationService;
  readonly conversationStore: ConversationStore;
  readonly registry: RunRegistry;
  readonly steeringQueue: RunSteeringQueue;
  readonly runBridge: LarkRunBridge;
  readonly outbound: LarkOutbound;
  /** 当前时间 ISO 字符串；注入便于测试。 */
  readonly now?: () => string;
}

/**
 * 入站消息路由决策：严格按优先级顺序处理，命中即停止。worker 已先写入去重记录，
 * 因此这里的所有回复与任务动作对于同一条 message_id 最多执行一次。
 */
export class LarkMessageRouter {
  readonly #options: LarkMessageRouterOptions;

  constructor(options: LarkMessageRouterOptions) {
    this.#options = options;
  }

  async route(context: InboundMessageContext): Promise<void> {
    // 规则 1：群聊忽略。
    if (context.chatType !== "p2p") return;
    // 规则 2：非用户发送者忽略（过滤机器人自己与应用消息）。
    if (context.senderType !== "user") return;

    // 规则 4：白名单；配置了列表且发送者不在名单时，后续绑定与消息规则全部不执行。
    if (
      this.#options.allowedOpenIds.size > 0 &&
      !this.#options.allowedOpenIds.has(context.senderOpenId)
    ) {
      return this.#reply(context.chatId, "你没有权限使用这个机器人。", context.messageId, "no-permission");
    }

    // 规则 5：非文本消息。
    if (context.messageType !== "text") {
      return this.#reply(
        context.chatId,
        "当前仅支持文本消息，图片、文件和语音暂不支持。",
        context.messageId,
        "non-text",
      );
    }

    // 规则 6：空消息忽略（trim 后为空），不回复。
    if (context.text.trim() === "") return;

    // 规则 7：绑定码。
    const bindingCode = normalizeBindingCode(context.text);
    if (bindingCode !== null) {
      await this.#handleBinding(context, bindingCode);
      return;
    }

    // 规则 8：解绑指令。
    if (UNBIND_COMMANDS.includes(context.text.trim())) {
      await this.#handleUnbind(context);
      return;
    }

    // 规则 9：未绑定单聊的其他文本。
    const binding = this.#options.store.findByChatId(context.chatId);
    if (binding === undefined) {
      await this.#reply(
        context.chatId,
        "我只响应已绑定的 Westie 会话。请先在 Westie 界面生成绑定码，再发送给我。",
        context.messageId,
        "unbound",
      );
      return;
    }

    // 规则 10 / 11：已绑定。
    await this.#handleBound(context, binding);
  }

  async #handleBinding(context: InboundMessageContext, code: string): Promise<void> {
    if (this.#options.tokenStore.isBlocked(context.chatId)) {
      await this.#reply(
        context.chatId,
        "绑定尝试过于频繁，请稍后在 Westie 界面重新生成绑定码。",
        context.messageId,
        "blocked",
      );
      return;
    }
    const consumed = this.#options.tokenStore.consume(code, context.chatId);
    if (consumed.status === "invalid") {
      await this.#reply(
        context.chatId,
        "绑定码无效或已过期，请在 Westie 界面重新生成。",
        context.messageId,
        "bad-code",
      );
      return;
    }
    const consumedEntry = consumed.entry;
    let result: ReturnType<LarkBindingStore["bind"]>;
    try {
      result = this.#options.store.bind({
        chatId: context.chatId,
        openId: context.senderOpenId,
        conversationId: consumedEntry.conversationId,
        createdAt: this.#options.now?.() ?? new Date().toISOString(),
      });
    } catch (error) {
      // 落库失败一律还码，用户可用原码重试；会话已删除时给出明确提示。
      this.#options.tokenStore.restore(consumedEntry);
      if (error instanceof ConversationNotFoundError) {
        await this.#reply(
          context.chatId,
          "原会话已不存在，请在 Westie 重新选择会话生成绑定码。",
          context.messageId,
          "conversation-gone",
        );
        return;
      }
      throw error;
    }
    if (result.status === "chat_already_bound") {
      // 冲突不消费码：还码后提示用户先解绑，原码在有效期内仍可重试。
      this.#options.tokenStore.restore(consumedEntry);
      await this.#reply(
        context.chatId,
        "本单聊已绑定其他会话。请先发送 /unbind 解绑后再绑定。",
        context.messageId,
        "chat-bound",
      );
      return;
    }
    if (result.status === "conversation_already_bound") {
      this.#options.tokenStore.restore(consumedEntry);
      await this.#reply(
        context.chatId,
        "目标会话已被其他单聊绑定，请先在 Westie 界面解除原绑定。",
        context.messageId,
        "conversation-bound",
      );
      return;
    }
    const name = await this.#conversationName(consumedEntry.conversationId);
    await this.#reply(
      context.chatId,
      `已绑定到会话「${name}」。之后直接在本聊天发消息即可驱动该会话。`,
      context.messageId,
      "bound",
    );
  }

  async #handleUnbind(context: InboundMessageContext): Promise<void> {
    this.#options.store.unbindByChatId(context.chatId);
    await this.#reply(
      context.chatId,
      "已解除绑定。本聊天不再驱动该会话，会话历史仍保留在 Westie。",
      context.messageId,
      "unbound-ack",
    );
  }

  async #handleBound(
    context: InboundMessageContext,
    binding: LarkChatBinding,
  ): Promise<void> {
    // 新任务与 steering 使用同一入站上限；放在分流前，空闲、忙与两条竞态
    // 回退路径都会被拦截。
    if (Buffer.byteLength(context.text, "utf8") > MAX_STEERING_MESSAGE_BYTES) {
      await this.#reply(
        context.chatId,
        `消息过长，单条消息不能超过 ${Math.floor(MAX_STEERING_MESSAGE_BYTES / 1024)} KiB。`,
        context.messageId,
        "message-too-long",
      );
      return;
    }
    let activeRunId: string | undefined;
    try {
      activeRunId = this.#options.conversationStore.getActiveRunId(
        binding.conversationId,
      );
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        this.#options.store.unbindByChatId(context.chatId);
        await this.#reply(
          context.chatId,
          "原会话已不存在，绑定已失效，请在 Westie 重新绑定。",
          context.messageId,
          "conversation-gone",
        );
        return;
      }
      throw error;
    }

    if (activeRunId === undefined) {
      // 空闲：新开一轮任务。
      let runId: string;
      try {
        ({ runId } = this.#options.registry.start({
          conversationId: binding.conversationId,
          input: context.text,
        }));
      } catch (error) {
        if (error instanceof ConversationBusyError) {
          // 忙闲竞态：判定空闲后网页先开了 Run，改走追加消息。
          await this.#steer(context, binding.conversationId, true);
          return;
        }
        if (error instanceof ConversationNotFoundError) {
          // 会话在绑定后被删除；防御性处理。
          this.#options.store.unbindByChatId(context.chatId);
          await this.#reply(
            context.chatId,
            "原会话已不存在，绑定已失效，请在 Westie 重新绑定。",
            context.messageId,
            "conversation-gone",
          );
          return;
        }
        throw error;
      }
      // 启动与登记在同一 worker 步内，保证终态事件不漏接。
      this.#options.runBridge.register(runId, context.chatId);
      await this.#reply(
        context.chatId,
        "收到，已开始处理。任务结束后我会把结果发到这里。",
        context.messageId,
        "ack",
      );
      return;
    }

    // 忙：作为追加消息进入当前任务的 steering 队列。
    await this.#steer(context, binding.conversationId, false);
  }

  async #steer(
    context: InboundMessageContext,
    conversationId: string,
    allowRetryStart: boolean,
  ): Promise<void> {
    const activeRunId = this.#options.conversationStore.getActiveRunId(conversationId);
    if (activeRunId === undefined) {
      // 忙闲竞态反转：排队等待时 Run 已结束，退回按空闲处理（新开任务）。
      if (allowRetryStart) {
        const binding = { chatId: context.chatId, openId: "", conversationId, createdAt: "" };
        await this.#handleBound(context, binding);
      } else {
        await this.#reply(
          context.chatId,
          "原会话已不存在，绑定已失效，请在 Westie 重新绑定。",
          context.messageId,
          "conversation-gone",
        );
      }
      return;
    }
    try {
      this.#options.steeringQueue.enqueue(activeRunId, context.text);
      await this.#reply(
        context.chatId,
        "已作为追加消息交给当前任务，不会另开新任务。",
        context.messageId,
        "steer-ack",
      );
    } catch (error) {
      if (error instanceof SteeringQueueFullError) {
        await this.#reply(
          context.chatId,
          `当前任务待处理的追加消息已满（最多 ${MAX_PENDING_STEERING_MESSAGES} 条），请稍后再发。`,
          context.messageId,
          "steer-full",
        );
        return;
      }
      if (error instanceof ProtocolError) {
        await this.#reply(
          context.chatId,
          `消息过长，单条消息不能超过 ${Math.floor(MAX_STEERING_MESSAGE_BYTES / 1024)} KiB。`,
          context.messageId,
          "steer-too-long",
        );
        return;
      }
      throw error;
    }
  }

  async #conversationName(conversationId: string): Promise<string> {
    try {
      const conversation = await this.#options.conversationService.getConversation(
        conversationId,
      );
      return conversation.title ?? conversation.workspace.name;
    } catch {
      return "未命名会话";
    }
  }

  async #reply(
    chatId: string,
    text: string,
    messageId: string,
    tag: string,
  ): Promise<void> {
    // uuid 由业务身份派生：同一入站消息的同一回复保持同一 uuid，飞书侧一小时内幂等。
    await this.#options.outbound.enqueue({
      chatId,
      content: text,
      uuid: `westie-${tag}-${messageId}`,
    });
  }
}

/** 绑定码规范化：trim、大写化、去空格后补回缺省连字符。非绑定码格式返回 null。 */
export function normalizeBindingCode(text: string): string | null {
  const normalized = text.trim().toUpperCase().replace(/\s+/g, "");
  const match = /^WST-?([A-Z2-9]{6})$/.exec(normalized);
  if (match === null) return null;
  return `WST-${match[1]}`;
}