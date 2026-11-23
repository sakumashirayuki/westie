import type { DatabaseSync } from "node:sqlite";

import type { AgentServerConfig } from "../server-config.js";
import type { ConversationService } from "../application/conversation-service.js";
import type { ConversationStore } from "../application/conversation-store.js";
import { LarkBindingTokenStore } from "../application/lark-binding-token-store.js";
import { LarkInboundQueue } from "../application/lark-inbound-queue.js";
import {
  LarkMessageRouter,
  type InboundMessageContext,
} from "../application/lark-message-router.js";
import { LarkRunBridge } from "../application/lark-run-bridge.js";
import { LarkOutbound } from "../application/lark-outbound.js";
import type { RunRegistry } from "../application/run-registry.js";
import type { RunSteeringQueue } from "../application/run-steering-queue.js";
import { LarkBindingRoutes } from "../http/lark-binding-routes.js";
import { LarkBindingStore } from "../infrastructure/sqlite/lark-binding-store.js";
import { LarkClient } from "./lark-client.js";
import { isLarkConfigEnabled } from "./lark-config.js";

/**
 * 飞书渠道的组合根：把 lark 相关组件的装配、入站协议解析与启停时序收敛在一处。
 * server-bootstrap 只通过这个门面拿到两个 HTTP 出口与生命周期钩子，不再接触
 * 任何飞书组件细节。本模块允许跨层引用 application/http/infrastructure，
 * 定位是渠道级装配，业务规则仍在各组件内部。
 */
export interface LarkBridge {
  /** 网页绑定接口；桥接关闭时 capability 返回 false、变更接口返回 501。 */
  readonly bindingRoutes: LarkBindingRoutes;
  /** 会话列表 / 详情装饰 `larkBound` 字段的绑定查询，桥接关闭时仍存在。 */
  readonly bindingStore: LarkBindingStore;
  /** 建立长连接；失败只记日志，不影响 HTTP 服务启动。 */
  start(): Promise<void>;
  /**
   * 关停飞书侧资源，顺序固定：停收事件 → 入站宽限/丢弃 → 宿主取消 Run →
   * 出站关闭 → 等出站泵落定。cancelRuns 由宿主注入，使飞书启动的 Run 被
   * 取消时，终态事件仍能推动出站泵把取消通知放入出站队列。
   */
  shutdown(cancelRuns: () => Promise<void>): Promise<void>;
}

export interface CreateLarkBridgeDeps {
  readonly config: AgentServerConfig;
  readonly database: DatabaseSync;
  readonly conversationService: ConversationService;
  readonly conversationStore: ConversationStore;
  readonly runRegistry: RunRegistry;
  readonly steeringQueue: RunSteeringQueue;
}

export function createLarkBridge(deps: CreateLarkBridgeDeps): LarkBridge {
  const { config } = deps;
  const bindingStore = new LarkBindingStore(deps.database);
  // 入站去重记录保留 24 小时：进程启动清理一次，之后每小时清理一次。
  const inboundRetentionMs = 24 * 60 * 60 * 1000;
  const purgeInbound = (): void => {
    bindingStore.purgeOldInboundMessages(
      new Date(Date.now() - inboundRetentionMs).toISOString(),
    );
  };
  purgeInbound();
  const inboundPurgeTimer = setInterval(purgeInbound, 60 * 60 * 1000);
  inboundPurgeTimer.unref();

  const enabled = isLarkConfigEnabled(config.lark);
  const client = enabled ? new LarkClient(config.lark) : undefined;
  // 出站发送器始终存在（供 run bridge / router 引用）；桥接关闭时用落日志的空实现，
  // 因为此时不会收到任何事件、也不会发任何东西。
  const outbound = new LarkOutbound({
    client: {
      sendMessage:
        client === undefined
          ? async () => ({ status: "failed" as const })
          : (request) => client.sendMessage(request),
    },
  });
  const runBridge = new LarkRunBridge({
    registry: deps.runRegistry,
    outbound,
  });
  const tokenStore = new LarkBindingTokenStore();
  const router = enabled
    ? new LarkMessageRouter({
        store: bindingStore,
        tokenStore,
        allowedOpenIds: config.lark.allowedOpenIds,
        conversationService: deps.conversationService,
        conversationStore: deps.conversationStore,
        registry: deps.runRegistry,
        steeringQueue: deps.steeringQueue,
        runBridge,
        outbound,
      })
    : undefined;
  const inboundQueue = router === undefined
    ? undefined
    : new LarkInboundQueue((event) =>
        handleInboundEvent(router, bindingStore, event),
      );
  const bindingRoutes = new LarkBindingRoutes({
    bindingStore,
    tokenStore,
    conversationService: deps.conversationService,
    bridgeEnabled: enabled,
    allowedOrigin: config.allowedOrigin,
  });

  return {
    bindingRoutes,
    bindingStore,

    async start(): Promise<void> {
      if (client === undefined || inboundQueue === undefined) return;
      await startLarkConnection(client, inboundQueue);
    },

    async shutdown(cancelRuns): Promise<void> {
      clearInterval(inboundPurgeTimer);
      // 1. WSClient 停止接收飞书事件；worker 已入队事件宽限 3 秒。
      client?.close();
      await waitInboundDrain(inboundQueue);
      // 宽限结束仍积压的入站事件直接丢弃，避免关停期间继续产生副作用。
      const droppedInbound = inboundQueue?.flushPending() ?? 0;
      if (droppedInbound > 0) {
        console.warn(JSON.stringify({
          event: "lark.inbound.dropped_on_shutdown",
          dropped: droppedInbound,
        }));
      }
      // 2. 宿主取消运行中的 Run 并等它们落库；飞书启动的 Run 一并被取消，
      //    终态事件推动出站泵把取消/结果通知放入出站队列。
      await cancelRuns();
      // 3. 中止出站频控与重试等待，再等出站泵结束（桥内部上限 5 秒）。
      outbound.close();
      await runBridge.stop().catch(() => {});
    },
  };
}

/** 等待入站队列排空，最多宽限 3 秒；桥接关闭时没有队列，立即结束。 */
function waitInboundDrain(
  queue: LarkInboundQueue | undefined,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 3_000);
    timeout.unref();
    if (queue === undefined) {
      resolve();
      return;
    }
    const poll = (): void => {
      if (queue.pendingCount === 0) {
        resolve();
        return;
      }
      setTimeout(poll, 50).unref();
    };
    poll();
  });
}

async function startLarkConnection(
  client: LarkClient,
  queue: LarkInboundQueue,
): Promise<void> {
  try {
    await client.start((event) => queue.push(event));
    console.warn(JSON.stringify({ event: "lark.ws.started" }));
  } catch (error) {
    console.error(JSON.stringify({
      event: "lark.ws.start_failed",
      message: error instanceof Error ? error.message : String(error),
    }));
    // 启动失败只记录日志，HTTP 服务照常启动（网页功能不受影响）。
  }
}

/**
 * 处理一条飞书事件：先按规则 1/2 过滤在路由器外做，再在 worker 内对消息类事件写
 * 去重记录，保证同一条消息只生效一次。这里从 SDK 原始事件提取本方案需要的字段。
 */
async function handleInboundEvent(
  larkRouter: LarkMessageRouter,
  larkBindingStore: LarkBindingStore,
  event: unknown,
): Promise<void> {
  const context = extractInboundContext(event);
  if (context === undefined || context === "unrouteable") return;
  if (context === "ignored") return;
  // 规则 1/2：群聊与非用户发送者不写去重记录、不路由。
  if (context.chatType !== "p2p" || context.senderType !== "user") return;
  // 规则 3：先写去重记录。已存在说明平台重试推送，忽略。
  const receivedAt = new Date().toISOString();
  const isNew = larkBindingStore.ensureInboundMessageSeen(
    context.messageId,
    context.chatId,
    receivedAt,
  );
  if (!isNew) return;
  await larkRouter.route(context);
}

function extractInboundContext(
  event: unknown,
): InboundMessageContext | "ignored" | "unrouteable" {
  const value = event as {
    sender?: { sender_type?: unknown; sender_id?: { open_id?: unknown } };
    message?: {
      message_id?: unknown;
      chat_id?: unknown;
      chat_type?: unknown;
      message_type?: unknown;
      content?: unknown;
    };
  };
  if (
    !isRecord(value) ||
    !isRecord(value.message) ||
    typeof value.message.chat_id !== "string" ||
    typeof value.message.chat_type !== "string" ||
    typeof value.message.message_type !== "string" ||
    typeof value.message.message_id !== "string" ||
    !isRecord(value.sender) ||
    typeof value.sender.sender_type !== "string" ||
    !isRecord(value.sender.sender_id) ||
    typeof value.sender.sender_id.open_id !== "string"
  ) {
    return "ignored";
  }
  const text = parseInboundText(value.message.content);
  return {
    chatId: value.message.chat_id,
    chatType: value.message.chat_type,
    senderType: value.sender.sender_type,
    senderOpenId: value.sender.sender_id.open_id,
    messageId: value.message.message_id,
    messageType: value.message.message_type,
    text,
  };
}

function parseInboundText(content: unknown): string {
  if (typeof content !== "string") return "";
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
