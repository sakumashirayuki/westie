// MCP 走的 JSON-RPC 2.0 子集：请求、响应与通知的类型定义、zod 校验和错误类。
// 只规定消息形状，不规定怎么传（stdio / HTTP 见各自 transport）。

import { z } from "zod";

/** JSON-RPC 请求。id 只允许递增整数，MCP 客户端一侧自己生成。 */
export const jsonRpcRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.number().int().nonnegative(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;

/** JSON-RPC 成功响应。 */
export const jsonRpcResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number().int().nonnegative(), z.string()]),
  result: z.json(),
});

export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;

/** JSON-RPC 错误对象。 */
export const jsonRpcErrorSchema = z.strictObject({
  code: z.number().int(),
  message: z.string(),
  data: z.json().optional(),
});

export type JsonRpcError = z.infer<typeof jsonRpcErrorSchema>;

/** JSON-RPC 错误响应。 */
export const jsonRpcErrorResponseSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number().int().nonnegative(), z.string()]),
  error: jsonRpcErrorSchema,
});

export type JsonRpcErrorResponse = z.infer<typeof jsonRpcErrorResponseSchema>;

/** 任一响应（成功或失败）。 */
export const jsonRpcResponseMessageSchema = z.union([
  jsonRpcResponseSchema,
  jsonRpcErrorResponseSchema,
]);

export type JsonRpcResponseMessage = z.infer<
  typeof jsonRpcResponseMessageSchema
>;

/** 通知：没有 id 的单向消息。 */
export const jsonRpcNotificationSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>;

/** Server 发给客户端的请求（sampling、roots、elicitation 等）。 */
export const jsonRpcInboundRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number().int().nonnegative(), z.string()]),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export type JsonRpcInboundRequest = z.infer<
  typeof jsonRpcInboundRequestSchema
>;

/** 从同一传输流里读到的任一入站消息：响应、错误、入站请求或通知。 */
export const jsonRpcInboundMessageSchema = z.union([
  jsonRpcResponseSchema,
  jsonRpcErrorResponseSchema,
  jsonRpcInboundRequestSchema,
  jsonRpcNotificationSchema,
]);

export type JsonRpcInboundMessage = z.infer<typeof jsonRpcInboundMessageSchema>;

/** 把一个出站消息对象渲染成单行 JSON。 */
export function serializeJsonRpcMessage(
  message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponseMessage,
): string {
  return JSON.stringify(message);
}

/**
 * 解析一行文本为入站消息。文本非法（不是对象 / 缺 jsonrpc 2.0 / 形状不对）时
 * 抛 {@link JsonRpcProtocolError}。
 */
export function parseJsonRpcMessage(line: string): JsonRpcInboundMessage {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new JsonRpcProtocolError("JSON-RPC message is not valid JSON.", {
      cause: error,
    });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { jsonrpc?: unknown }).jsonrpc !== "2.0"
  ) {
    throw new JsonRpcProtocolError("JSON-RPC message is not a 2.0 object.");
  }
  const parsed = jsonRpcInboundMessageSchema.safeParse(value);
  if (!parsed.success) {
    throw new JsonRpcProtocolError(
      "JSON-RPC message has an invalid shape.",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export class JsonRpcProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JsonRpcProtocolError";
  }
}

/** Server 对客户端请求返回的 JSON-RPC error。 */
export class McpServerRpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string, data?: unknown) {
    super(
      data === undefined
        ? message
        : `${message} ${JSON.stringify(data)}`,
    );
    this.name = "McpServerRpcError";
    this.code = code;
  }
}
