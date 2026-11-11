// MCP 子集的领域类型：传输接口、远端工具描述与调用结果。client、transport、
// server-pool 与 mcp-tool 共享这些形状。

import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponseMessage,
} from "./json-rpc.js";

/**
 * 一个 MCP 传输：负责把 JSON-RPC 消息送出去、把入站消息送回来。实现有两个：
 * stdio（子进程）与 Streamable HTTP。生命周期由 McpClient 驱动。
 */
export interface McpTransport extends AsyncDisposable {
  /** 建立连接（起子进程 / 完成握手前置的 HTTP 准备）。 */
  start(): Promise<void>;
  /** 发一条请求，返回对应的响应（响应或错误都以消息对象返回）。 */
  send(request: JsonRpcRequest): Promise<void>;
  /** 发一条单向通知。 */
  notify(notification: JsonRpcNotification): Promise<void>;
  /** 回应一条 Server 发来的请求（成功或错误响应），id 取自入站请求。 */
  respond(response: JsonRpcResponseMessage): Promise<void>;
  /**
   * 读取下一条入站消息。多个入站消息会排队。连接关闭后 resolve 为 null。
   */
  receive(): Promise<JsonRpcInbound | null>;
  /** 关闭连接并释放资源。close 应当是幂等的；`await using` 走 Symbol.asyncDispose 同样到这里。 */
  close(): Promise<void>;
  /** 是否仍可用（未关闭）。 */
  readonly closed: boolean;
  /** 连接诊断信息（子进程退出、HTTP 状态等），失败时供上层记录。 */
  readonly lastError?: string;
}

/** 传输层回传的入站消息。 */
export type JsonRpcInbound =
  | { readonly kind: "response"; readonly id: number | string; readonly result: unknown }
  | { readonly kind: "error"; readonly id: number | string; readonly code: number; readonly message: string; readonly data?: unknown }
  | { readonly kind: "request"; readonly id: number | string; readonly method: string; readonly params?: unknown }
  | { readonly kind: "notification"; readonly method: string; readonly params?: unknown };

/**
 * Server 通过 tools/list 公布的一个工具。inputSchema 是原始 JSON Schema。
 */
export interface McpRemoteTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
}

/**
 * tools/call 返回内容块。text 之外的块只保留元信息，不进 transcript。
 */
export type McpContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mimeType: string; readonly bytes: number }
  | { readonly type: "audio"; readonly mimeType: string; readonly bytes: number }
  | { readonly type: "resource"; readonly uri: string; readonly mimeType?: string; readonly text?: string };

/** tools/call 的完整结果。 */
export interface McpCallResult {
  readonly content: readonly McpContentBlock[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}
