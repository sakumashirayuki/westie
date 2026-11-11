import type { IncomingMessage, ServerResponse } from "node:http";

import type { ExecutionMode } from "../domain/conversation.js";

export type FullAccessRequestDecision =
  | "allowed"
  | "requires_loopback"
  | "untrusted_origin";

export function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigin: string | undefined,
): void {
  if (
    allowedOrigin !== undefined &&
    request.headers.origin === allowedOrigin
  ) {
    response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    response.setHeader("Vary", "Origin");
  }
}

export function isTrustedHostActionOrigin(
  request: IncomingMessage,
  allowedOrigin: string | undefined,
): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (allowedOrigin !== undefined && origin === allowedOrigin) return true;

  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" &&
      isLoopbackHostname(parsed.hostname) &&
      parsed.host === request.headers.host;
  } catch {
    return false;
  }
}

export function evaluateFullAccessRequest(
  executionMode: ExecutionMode,
  fullAccessAvailable: boolean | undefined,
  request: IncomingMessage,
  allowedOrigin: string | undefined,
): FullAccessRequestDecision {
  if (executionMode !== "full_access") return "allowed";
  if (fullAccessAvailable !== true) return "requires_loopback";
  return isTrustedFullAccessOrigin(request, allowedOrigin)
    ? "allowed"
    : "untrusted_origin";
}

function isTrustedFullAccessOrigin(
  request: IncomingMessage,
  allowedOrigin: string | undefined,
): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;

  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" || !isLoopbackHostname(parsed.hostname)) {
      return false;
    }
    if (parsed.host === request.headers.host) return true;
    if (allowedOrigin !== origin) return false;
    const allowed = new URL(allowedOrigin);
    return allowed.protocol === "http:" &&
      isLoopbackHostname(allowed.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]";
}
