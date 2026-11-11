import {
  JsonRpcProtocolError,
  McpServerRpcError,
  type JsonRpcNotification,
} from "./json-rpc.js";
import {
  DEFAULT_MCP_CALL_TIMEOUT_MS,
  MCP_INITIALIZE_TIMEOUT_MS,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./constants.js";
import type {
  JsonRpcInbound,
  McpCallResult,
  McpRemoteTool,
  McpTransport,
} from "./types.js";

/**
 * MCP 协议客户端：在某个 {@link McpTransport} 之上做 initialize 握手、tools/list
 * 翻页与 tools/call。它只关心协议语义，不管连接复用（见 server-pool）。
 */
export class McpClient {
  readonly #transport: McpTransport;
  #nextId = 1;
  #pending = new Map<number, PendingCall>();
  #receiver: Promise<void> | undefined;
  #toolsDirty = false;

  constructor(transport: McpTransport) {
    this.#transport = transport;
  }

  /** tools/list_changed 之后置脏；server-pool 据此在下一次 acquire 重拉工具。 */
  get toolsDirty(): boolean {
    return this.#toolsDirty;
  }

  /** 底层传输是否已关闭（主动 close 或 Server 崩溃）；关闭后不能再复用。 */
  get closed(): boolean {
    return this.#transport.closed;
  }

  /** 建立连接：起传输、initialize 握手、发 initialized 通知。 */
  async connect(): Promise<void> {
    await this.#transport.start();
    this.#receiver = this.#receiveLoop();

    const response = (await this.#call(
      "initialize",
      {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: {},
        clientInfo: { name: "my-agent-harness", version: "0.1.0" },
      },
      MCP_INITIALIZE_TIMEOUT_MS,
    )) as { protocolVersion?: unknown; capabilities?: unknown };

    const version = response.protocolVersion;
    if (
      typeof version !== "string" ||
      !SUPPORTED_PROTOCOL_VERSIONS.includes(
        version as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number],
      )
    ) {
      throw new JsonRpcProtocolError(
        `MCP server protocol version ${String(version)} is not supported.`,
      );
    }

    await this.notify("notifications/initialized", {});
  }

  /** 拉取全部工具，自动按 nextCursor 翻页。 */
  async listTools(): Promise<readonly McpRemoteTool[]> {
    const tools: McpRemoteTool[] = [];
    let cursor: string | undefined;
    for (;;) {
      this.#toolsDirty = false;
      const result = (await this.#call(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        MCP_INITIALIZE_TIMEOUT_MS,
      )) as {
        tools?: unknown;
        nextCursor?: unknown;
      };
      const batch = result.tools;
      if (!Array.isArray(batch)) {
        throw new JsonRpcProtocolError(
          "MCP tools/list response is missing a tools array.",
        );
      }
      for (const entry of batch) {
        const tool = parseRemoteTool(entry);
        if (tool !== undefined) tools.push(tool);
      }
      cursor = typeof result.nextCursor === "string"
        ? result.nextCursor
        : undefined;
      if (cursor === undefined || cursor === "") break;
    }
    return tools;
  }

  /** 调用远端工具；超时或 signal 取消时先发 notifications/cancelled。 */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = DEFAULT_MCP_CALL_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const raw = (await this.#call(
      "tools/call",
      { name, arguments: args },
      timeoutMs,
      signal,
    )) as Record<string, unknown>;

    return parseCallResult(raw);
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /** 关闭底层传输并结算所有挂起的调用。 */
  async close(): Promise<void> {
    await this.#transport.close();
    for (const pending of this.#pending.values()) {
      pending.fail(
        new JsonRpcProtocolError("MCP client closed while a request was pending."),
      );
    }
    this.#pending.clear();
  }

  /** 发一条通知（不带 id）。 */
  notify(method: string, params: Record<string, unknown>): Promise<void> {
    return this.#transport.notify({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  #call(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = this.#nextId++;
    const request = { jsonrpc: "2.0" as const, id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        this.#transport.notify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, reason: "timeout" },
        }).catch(() => {});
        reject(new JsonRpcProtocolError(`MCP request ${method} timed out.`));
      }, timeoutMs);

      const onAbort = (): void => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        clearTimeout(timeout);
        this.#transport.notify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, reason: "cancelled" },
        }).catch(() => {});
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        fail: (error) => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });

      this.#transport.send(request).catch((error) => {
        this.#pending.delete(id);
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async #receiveLoop(): Promise<void> {
    for (;;) {
      let message: JsonRpcInbound | null;
      try {
        message = await this.#transport.receive();
      } catch (error) {
        // 传输在我们等待时被关掉（例如 close() 与入站消息竞争）：与收到 null 同样处理，
        // 绝不让这个 Promise 悬空 reject。
        this.#settlePending(
          `MCP transport failed while receiving: ${errorMessage(error)}`,
        );
        return;
      }
      if (message === null) {
        this.#settlePending("MCP server closed the connection.");
        return;
      }
      this.#handleInbound(message);
    }
  }

  #settlePending(reason: string): void {
    for (const pending of this.#pending.values()) {
      pending.fail(new JsonRpcProtocolError(reason));
    }
    this.#pending.clear();
  }

  #handleInbound(message: JsonRpcInbound): void {
    switch (message.kind) {
      case "response":
      case "error": {
        const id = typeof message.id === "number" ? message.id : undefined;
        if (id === undefined || !this.#pending.has(id)) return;
        const pending = this.#pending.get(id)!;
        this.#pending.delete(id);
        if (message.kind === "error") {
          pending.fail(new McpServerRpcError(
            message.code,
            message.message,
            message.data,
          ));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      case "notification":
        this.#handleNotification(message.method, message.params);
        return;
      case "request":
        // sampling / roots / elicitation 等一律按 JSON-RPC 回 -32601 错误响应，
        // id 取自入站请求，否则 Server 会一直等这条回复。
        this.#transport.respond({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        }).catch(() => {});
        return;
    }
  }

  #handleNotification(
    method: string,
    params: unknown,
  ): void {
    const record = isRecord(params) ? params : {};
    switch (method) {
      case "notifications/tools/list_changed":
        this.#toolsDirty = true;
        return;
      case "notifications/message": {
        const level = record.level;
        const data = record.data;
        const text = typeof data === "string" ? data : "";
        const target = level === "error" || level === "warning"
          ? process.stderr
          : process.stdout;
        target.write(`[mcp] ${text}\n`);
        return;
      }
      // Server 发来的请求（sampling、roots、elicitation）统一回 -32601。
      default:
        return;
    }
  }

}

interface PendingCall {
  resolve(value: unknown): void;
  fail(error: unknown): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRemoteTool(value: unknown): McpRemoteTool | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name === "") return undefined;
  const inputSchema = record.inputSchema;
  if (typeof inputSchema !== "object" || inputSchema === null) return undefined;
  return {
    name: record.name,
    ...(typeof record.description === "string"
      ? { description: record.description }
      : {}),
    inputSchema: inputSchema as Record<string, unknown>,
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.readOnlyHint === "boolean"
      ? { readOnlyHint: record.readOnlyHint }
      : {}),
    ...(typeof record.destructiveHint === "boolean"
      ? { destructiveHint: record.destructiveHint }
      : {}),
  };
}

function parseCallResult(value: Record<string, unknown>): McpCallResult {
  const isError = value.isError === true;
  const structuredContent = value.structuredContent;
  const rawContent = value.content;
  if (!Array.isArray(rawContent)) {
    throw new JsonRpcProtocolError(
      "MCP tools/call response is missing a content array.",
    );
  }
  const content = rawContent.map(parseContentBlock).filter(
    (block): block is NonNullable<typeof block> => block !== undefined,
  );
  return {
    content,
    ...(structuredContent === undefined
      ? {}
      : { structuredContent }),
    ...(isError ? { isError: true } : {}),
  };
}

function parseContentBlock(
  value: unknown,
):
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; bytes: number }
  | { type: "audio"; mimeType: string; bytes: number }
  | { type: "resource"; uri: string; mimeType?: string; text?: string }
  | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type === "text" && typeof record.text === "string") {
    return { type: "text", text: record.text };
  }
  if (type === "image" || type === "audio") {
    const mimeType = typeof record.mimeType === "string"
      ? record.mimeType
      : "";
    const data = typeof record.data === "string" ? record.data : "";
    return { type, mimeType, bytes: Buffer.byteLength(data, "utf8") };
  }
  if (type === "resource" && typeof record.uri === "string") {
    return {
      type: "resource",
      uri: record.uri,
      ...(typeof record.mimeType === "string"
        ? { mimeType: record.mimeType }
        : {}),
      ...(typeof record.text === "string" ? { text: record.text } : {}),
    };
  }
  return undefined;
}
