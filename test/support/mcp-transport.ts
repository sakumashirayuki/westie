import type {
  JsonRpcInbound,
  McpTransport,
} from "../../src/mcp/types.js";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponseMessage,
} from "../../src/mcp/json-rpc.js";

export class MemoryTransport implements McpTransport {
  readonly outbound: Array<JsonRpcRequest | JsonRpcNotification> = [];
  /** 客户端对入站请求的回应。 */
  readonly responses: JsonRpcResponseMessage[] = [];
  /** close() 被调用的次数；连接失败必须关传输的测试用。 */
  closeCalls = 0;
  #inbound: JsonRpcInbound[] = [];
  #closed = false;
  #consumedRequests = 0;

  get closed(): boolean {
    return this.#closed;
  }

  lastError: string | undefined;

  async start(): Promise<void> {}

  async send(request: JsonRpcRequest): Promise<void> {
    this.outbound.push(request);
  }

  async notify(notification: JsonRpcNotification): Promise<void> {
    this.outbound.push(notification);
  }

  async respond(response: JsonRpcResponseMessage): Promise<void> {
    this.responses.push(response);
  }

  /** 已发但尚未消费的请求（方便测试按 id 匹配）。 */
  requests(): JsonRpcRequest[] {
    return this.outbound.filter((m): m is JsonRpcRequest => "id" in m);
  }

  /** 等待并返回下一条尚未被消费的带 id 请求。 */
  async nextRequest(
    timeoutMs = 1_000,
  ): Promise<JsonRpcRequest> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const requests = this.requests();
      if (requests.length > this.#consumedRequests) {
        const request = requests[this.#consumedRequests]!;
        this.#consumedRequests += 1;
        return request;
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for request");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  async receive(): Promise<JsonRpcInbound | null> {
    if (this.#closed) return null;
    if (this.#inbound.length > 0) return this.#inbound.shift()!;
    return new Promise((resolve, reject) => {
      this.#waiting.push({ resolve, reject });
    });
  }

  #waiting: Array<{
    resolve: (m: JsonRpcInbound | null) => void;
    reject: (error: unknown) => void;
  }> = [];

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.#closed = true;
    for (const w of this.#waiting) w.resolve(null);
    this.#waiting = [];
  }

  push(message: JsonRpcInbound): void {
    const w = this.#waiting.shift();
    if (w !== undefined) w.resolve(message);
    else this.#inbound.push(message);
  }

  /** 让正在等待的 receive() 以给定错误 reject，模拟传输在收包时损坏。 */
  failNextReceive(error: unknown): void {
    const w = this.#waiting.shift();
    if (w !== undefined) w.reject(error);
  }
}
