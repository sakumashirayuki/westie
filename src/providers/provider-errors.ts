import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
import type {
  ResponseErrorEvent,
  ResponseFailedEvent,
} from "openai/resources/responses/responses";

import {
  ProviderTransientError,
  type ProviderTransientReason,
} from "../provider-protocol.js";

/**
 * 把一次 provider 调用的失败归类：命中瞬时故障时返回 `ProviderTransientError`，
 * 否则返回 `undefined`，由调用方照原样处理。
 *
 * 只覆盖连接失败、限流、服务端错误、超时和流中途断开。401、余额不足、上下文超长
 * 这类重试无益的错误不在其中。传入 `event` 时按 OpenAI 流里的 `error` /
 * `response.failed` 事件归类。
 */
export function classifyProviderError(
  error: unknown,
  event?: ResponseErrorEvent | ResponseFailedEvent,
): ProviderTransientError | undefined {
  if (event !== undefined) return classifyResponseEvent(event);
  if (error instanceof ProviderTransientError) return error;
  if (error instanceof APIError) return classifyApiError(error);
  if (error instanceof Error) return classifyStreamDisconnect(error);
  return undefined;
}

function classifyApiError(error: APIError): ProviderTransientError | undefined {
  // APIUserAbortError 是用户取消；它和两个连接错误都是 APIError 的子类，要先判断。
  if (error instanceof APIUserAbortError) return undefined;
  if (error instanceof APIConnectionTimeoutError) {
    return transient("timeout", error);
  }
  if (error instanceof APIConnectionError) {
    return transient("connection", error);
  }

  // 服务端显式声明是否可重试时以它为准，与 SDK 行为一致。
  const shouldRetry = error.headers?.get("x-should-retry");
  if (shouldRetry === "false") return undefined;
  const reason = reasonForStatus(error.status, error.code);
  if (reason !== undefined) return transient(reason, error);
  return shouldRetry === "true" ? transient("server_error", error) : undefined;
}

function reasonForStatus(
  status: number | undefined,
  code: string | null | undefined,
): ProviderTransientReason | undefined {
  switch (status) {
    case 408:
      return "timeout";
    case 429:
      // 额度用完不会自己恢复。
      return code === "insufficient_quota" ? undefined : "rate_limited";
    case 500:
    case 502:
    case 504:
      return "server_error";
    case 503:
    case 529:
      return "overloaded";
    default:
      // 409 在 SDK 里算可重试（lock timeout），但这两家 API 的 409 不是这个意思。
      return undefined;
  }
}

function classifyResponseEvent(
  event: ResponseErrorEvent | ResponseFailedEvent,
): ProviderTransientError | undefined {
  const code = event.type === "response.failed"
    ? event.response.error?.code
    : event.code;
  const message = event.type === "response.failed"
    ? event.response.error?.message ?? "OpenAI response failed."
    : event.message;
  if (code === "server_error") {
    return new ProviderTransientError("server_error", message);
  }
  if (code === "rate_limit_exceeded") {
    return new ProviderTransientError("rate_limited", message);
  }
  return undefined;
}

// 流迭代中途断开时，undici 抛 `TypeError: terminated`，底层原因在 cause 里。
const DISCONNECT_PATTERN = /^terminated$|ECONNRESET|UND_ERR_SOCKET|other side closed/;

function classifyStreamDisconnect(
  error: Error,
): ProviderTransientError | undefined {
  const cause = error.cause instanceof Error ? error.cause.message : "";
  if (DISCONNECT_PATTERN.test(error.message) || DISCONNECT_PATTERN.test(cause)) {
    return transient("connection", error);
  }
  return undefined;
}

function transient(
  reason: ProviderTransientReason,
  error: Error,
): ProviderTransientError {
  const retryAfterMs = error instanceof APIError
    ? parseRetryAfter(error.headers)
    : undefined;
  return new ProviderTransientError(reason, error.message, {
    cause: error,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/**
 * 解析服务端建议的等待时间，与 SDK 一致：先看 `retry-after-ms`，再看
 * `retry-after`（秒数或 HTTP 日期）。非正数、NaN 一律丢弃。
 */
export function parseRetryAfter(
  headers: Headers | undefined,
  now: () => number = Date.now,
): number | undefined {
  const millis = Number.parseFloat(headers?.get("retry-after-ms") ?? "");
  if (Number.isFinite(millis) && millis > 0) return millis;

  const header = headers?.get("retry-after");
  if (header === null || header === undefined || header.trim() === "") {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1_000 : undefined;
  const untilDate = Date.parse(header) - now();
  return Number.isFinite(untilDate) && untilDate > 0 ? untilDate : undefined;
}
