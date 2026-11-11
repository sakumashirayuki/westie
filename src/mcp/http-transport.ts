import { MAX_MCP_MESSAGE_BYTES } from "./constants.js";
import {
  JsonRpcProtocolError,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponseMessage,
} from "./json-rpc.js";
import type { JsonRpcInbound, McpTransport } from "./types.js";

/**
 * Streamable HTTP 传输：每条消息一次 POST 到同一个 URL。Accept 声明 JSON 或
 * SSE；响应若是 JSON 直接解析，若是 SSE 就读 data: 事件直到看到对应 id。保存
 * 并回带 Mcp-Session-Id，请求带 MCP-Protocol-Version。不开 GET 长连接，关闭时
 * DELETE 一次（失败忽略）。
 */
export interface HttpTransportOptions {
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly fetch?: typeof globalThis.fetch;
}

const PROTOCOL_VERSION = "2025-06-18";

export class HttpTransport implements McpTransport {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof globalThis.fetch;

  #sessionId: string | undefined;
  #closed = false;
  #lastError: string | undefined;
  #inboundQueue: JsonRpcInbound[] = [];
  #waiters: Array<(message: JsonRpcInbound | null) => void> = [];

  constructor(options: HttpTransportOptions) {
    this.#url = options.url;
    this.#headers = options.headers ?? {};
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get lastError(): string | undefined {
    return this.#lastError;
  }

  async start(): Promise<void> {
    // Streamable HTTP 拆成逐个 POST，没有独立的连接建立阶段。
  }

  async send(request: JsonRpcRequest): Promise<void> {
    await this.#post(request.id, serialize(request));
  }

  async notify(notification: JsonRpcNotification): Promise<void> {
    await this.#post(undefined, serialize(notification));
  }

  /** 客户端对入站请求的响应也是一次 POST，Server 以 202 收下，没有响应体。 */
  async respond(response: JsonRpcResponseMessage): Promise<void> {
    await this.#post(undefined, serialize(response));
  }

  async receive(): Promise<JsonRpcInbound | null> {
    const queued = this.#inboundQueue.shift();
    if (queued !== undefined) return queued;
    if (this.#closed) return null;
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#drainWaiters(null);
    try {
      await this.#fetch(this.#url, {
        method: "DELETE",
        headers: this.#buildHeaders(),
      });
    } catch {
      // 关闭失败忽略。
    }
  }

  async #post(
    id: number | string | undefined,
    body: string,
  ): Promise<void> {
    this.#assertOpen();
    const response = await this.#fetch(this.#url, {
      method: "POST",
      headers: this.#buildHeaders(),
      body,
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId !== null && sessionId !== "") this.#sessionId = sessionId;

    if (!response.ok) {
      this.#lastError = `MCP HTTP request failed with HTTP ${response.status}.`;
      this.#closed = true;
      this.#drainWaiters(null);
      throw new JsonRpcProtocolError(this.#lastError);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      await this.#readSse(response, id);
    } else {
      const text = await response.text();
      if (id === undefined) return; // 通知无响应。
      const inbound = parseBody(text);
      if (inbound.kind === "notification") {
        this.#drainWaiters(inbound);
      } else {
        this.#drainWaiters(inbound);
      }
    }
  }

  async #readSse(response: Response, id: number | string | undefined): Promise<void> {
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new JsonRpcProtocolError("MCP SSE response has no body.");
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_MCP_MESSAGE_BYTES) {
        this.#lastError = "MCP SSE response exceeded the maximum message size.";
        this.#closed = true;
        await reader.cancel();
        this.#drainWaiters(null);
        throw new JsonRpcProtocolError(this.#lastError);
      }
      buffer += decoder.decode(value, { stream: true });
      const events = extractDataEvents(buffer);
      buffer = events.remainder;
      for (const data of events.data) {
        const message = parseBody(data);
        // 只丢弃别人的响应；Server 发起的请求和通知都要送到上层。
        if (
          id !== undefined &&
          (message.kind === "response" || message.kind === "error") &&
          message.id !== id
        ) {
          continue;
        }
        this.#drainWaiters(message);
      }
    }
  }

  #buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      ...(this.#sessionId === undefined
        ? {}
        : { "Mcp-Session-Id": this.#sessionId }),
      ...this.#headers,
    };
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new JsonRpcProtocolError("MCP HTTP transport is closed.");
    }
  }

  #drainWaiters(message: JsonRpcInbound | null): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter(message);
      return;
    }
    if (message !== null) this.#inboundQueue.push(message);
  }
}

function serialize(
  message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponseMessage,
): string {
  return JSON.stringify(message);
}

function parseBody(text: string): JsonRpcInbound {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new JsonRpcProtocolError("MCP response is not valid JSON.", {
      cause: error,
    });
  }
  return toInbound(value as Record<string, unknown>);
}

function toInbound(value: Record<string, unknown>): JsonRpcInbound {
  if (value.jsonrpc !== "2.0") {
    throw new JsonRpcProtocolError("MCP response is not a JSON-RPC 2.0 object.");
  }
  if ("error" in value && value.error !== undefined) {
    const error = value.error as Record<string, unknown>;
    return {
      kind: "error",
      id: value.id as number | string,
      code: error.code as number,
      message: error.message as string,
      ...(error.data === undefined ? {} : { data: error.data }),
    };
  }
  if ("result" in value) {
    return {
      kind: "response",
      id: value.id as number | string,
      result: value.result,
    };
  }
  if (typeof value.method === "string") {
    const params = value.params === undefined
      ? {}
      : { params: value.params as Record<string, unknown> };
    if (typeof value.id === "number" || typeof value.id === "string") {
      return { kind: "request", id: value.id, method: value.method, ...params };
    }
    return { kind: "notification", method: value.method, ...params };
  }
  throw new JsonRpcProtocolError("Unrecognized JSON-RPC inbound message.");
}

function extractDataEvents(buffer: string): {
  readonly data: string[];
  readonly remainder: string;
} {
  const data: string[] = [];
  const lines = buffer.split("\n");
  let current = "";
  let lastComplete = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line === "") {
      // 空行表示事件结束。
      if (current !== "") data.push(current.trim());
      current = "";
      lastComplete = i + 1;
      continue;
    }
    if (line.startsWith("data:")) {
      current += (current === "" ? "" : "\n") + line.slice(5).trimStart();
    }
  }
  return {
    data,
    remainder: lines.slice(lastComplete).join("\n"),
  };
}
