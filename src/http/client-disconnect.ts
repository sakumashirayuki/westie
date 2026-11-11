import type { IncomingMessage, ServerResponse } from "node:http";

export interface ClientDisconnectWatcher {
  readonly signal: AbortSignal;
  release(): void;
}

export function watchClientDisconnect(
  request: IncomingMessage,
  response: ServerResponse,
): ClientDisconnectWatcher {
  const controller = new AbortController();
  const disconnect = (): void => {
    if (!response.writableEnded && !controller.signal.aborted) {
      controller.abort(new Error("Client disconnected."));
    }
  };
  request.once("aborted", disconnect);
  response.once("close", disconnect);
  return {
    signal: controller.signal,
    release(): void {
      request.off("aborted", disconnect);
      response.off("close", disconnect);
    },
  };
}
