import type { ServerResponse } from "node:http";

export interface HttpError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
}

export function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

export function writeHttpError(
  response: ServerResponse,
  error: HttpError,
): void {
  writeJson(response, error.status, {
    error: {
      code: error.code,
      message: error.message,
      ...(error.retryable === undefined
        ? {}
        : { retryable: error.retryable }),
    },
  });
}

export function writeRetryableSelectionError(
  response: ServerResponse,
  code: string,
  message: string,
): void {
  writeHttpError(response, { status: 409, code, message, retryable: true });
}

export function writeFullAccessRequiresLoopback(
  response: ServerResponse,
): void {
  writeHttpError(response, {
    status: 403,
    code: "FULL_ACCESS_REQUIRES_LOOPBACK",
    message: "Full Access is available only on a loopback-bound server.",
  });
}

export function writeUntrustedFullAccessOrigin(
  response: ServerResponse,
): void {
  writeHttpError(response, {
    status: 403,
    code: "UNTRUSTED_ORIGIN",
    message: "This origin cannot use Full Access.",
  });
}

export function writeMethodNotAllowed(
  response: ServerResponse,
  allow: string,
): void {
  response.setHeader("Allow", allow);
  writeHttpError(response, {
    status: 405,
    code: "METHOD_NOT_ALLOWED",
    message: "Method not allowed.",
  });
}

export function writeConversationNotFound(response: ServerResponse): void {
  writeHttpError(response, {
    status: 404,
    code: "CONVERSATION_NOT_FOUND",
    message: "Conversation not found.",
  });
}

export function writeNotFound(response: ServerResponse): void {
  writeHttpError(response, {
    status: 404,
    code: "NOT_FOUND",
    message: "Route not found.",
  });
}
