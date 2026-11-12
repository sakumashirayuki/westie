import {
  Client,
  EventDispatcher,
  WSClient,
  LoggerLevel,
} from "@larksuiteoapi/node-sdk";

import type { LarkBridgeEnabledConfig } from "./lark-config.js";

export interface SendMessageRequest {
  readonly chatId: string;
  /** 消息内容（单个内）。 */
  readonly content: string;
  /** 出站幂等键；由出站层派生，同一通知的重试保持同一值。 */
  readonly uuid: string;
}

export type SendOutcome =
  | { readonly status: "sent" }
  | { readonly status: "failed"; readonly code?: number; readonly message?: string };

/**
 * 飞书 SDK 生命周期封装：对上层只暴露「事件源注册」与「消息发送」两个端口。
 *
 * - 只建 `Client`（发消息）与 `WSClient`（长连接收事件），不对外暴露原始对象。
 * - 启动调用 `WSClient.start({ eventDispatcher })`；连接建立、断线探测与自动重连
 *   都由 SDK 内部完成，进程不自行实现重连。
 * - 处理函数由调用方统一入队后立即返回（飞书要求事件处理函数 3 秒内返回）。
 * - `sendMessage` 只做一次发送尝试，不抛错、不做重试与频控：重试、按单聊串行、
 *   切片与 uuid 幂等都归出站层负责，这里只保留与 SDK 直接相关的原始操作。
 */
export class LarkClient {
  readonly #client: Client;
  readonly #ws: WSClient;

  constructor(config: LarkBridgeEnabledConfig) {
    this.#client = new Client({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.domain,
      loggerLevel: LoggerLevel.info,
    });
    this.#ws = new WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.domain,
      loggerLevel: LoggerLevel.info,
      onError: (errorValue: Error) => {
        console.error(JSON.stringify({
          event: "lark.ws.error",
          message: errorValue.message,
        }));
      },
      onReconnecting: () => {
        console.warn(JSON.stringify({ event: "lark.ws.reconnecting" }));
      },
      onReconnected: () => {
        console.warn(JSON.stringify({ event: "lark.ws.reconnected" }));
      },
    });
  }

  /** 注册入站事件处理函数并启动长连接。参数由调用方封装成内存入队。 */
  async start(onMessage: (data: unknown) => void | Promise<void>): Promise<void> {
    const dispatcher = new EventDispatcher({});
    dispatcher.register({ "im.message.receive_v1": (data) => onMessage(data) });
    await this.#ws.start({ eventDispatcher: dispatcher });
  }

  /** 关闭长连接。`force` 使用 terminate 而非 graceful close。 */
  close(): void {
    this.#ws.close({ force: true });
  }

  /** 向指定单聊发送一条文本消息，做一次尝试，不抛错。 */
  async sendMessage(request: SendMessageRequest): Promise<SendOutcome> {
    try {
      const result = await this.#client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: request.chatId,
          msg_type: "text",
          content: JSON.stringify({ text: request.content }),
          uuid: request.uuid,
        },
      });
      return result.code === 0
        ? { status: "sent" }
        : {
            status: "failed",
            code: result.code,
            message: result.msg,
          };
    } catch (error) {
      if (error instanceof Error) {
        return { status: "failed", message: error.message };
      }
      return { status: "failed" };
    }
  }
}