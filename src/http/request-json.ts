import type { IncomingMessage } from "node:http";

import type { z } from "zod";

import type { HttpError } from "./http-response.js";

const MAX_REQUEST_BYTES = 64 * 1024;

/** 读出的请求体；`parse: false` 表示内容不是合法 JSON，由调用方决定错误响应。 */
export type ReadJsonBody =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly error: HttpError };

export type ParsedJsonRequest<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: HttpError };

export async function parseJsonRequest<T>(
  request: IncomingMessage,
  schema: z.ZodType<T>,
  invalidRequest: { readonly code: string; readonly message: string },
): Promise<ParsedJsonRequest<T>> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return {
      ok: false,
      error: {
        status: 415,
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Content-Type must be application/json.",
      },
    };
  }

  const read = await readJsonBody(request);
  if (!read.ok) return { ok: false, error: read.error };
  const body = read.body;

  const parsed = schema.safeParse(body);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : {
        ok: false,
        error: {
          status: 422,
          code: invalidRequest.code,
          message: invalidRequest.message,
        },
      };
}

/**
 * 读取并解析请求体。一个请求体只能读一次，后续校验应使用返回的 `body`。
 */
export async function readJsonBody(
  request: IncomingMessage,
): Promise<ReadJsonBody> {
  try {
    return { ok: true, body: await readJsonStream(request) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof RequestTooLargeError
        ? { status: 413, code: "REQUEST_TOO_LARGE", message: error.message }
        : {
            status: 400,
            code: "INVALID_JSON",
            message: "Request body is not valid JSON.",
          },
    };
  }
}

async function readJsonStream(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new RequestTooLargeError();
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

class RequestTooLargeError extends Error {
  constructor() {
    super(`Request body exceeds ${MAX_REQUEST_BYTES} bytes.`);
  }
}
