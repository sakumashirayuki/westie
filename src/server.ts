import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export {
  formatSseEvent,
  writeWithBackpressure,
} from "./http/sse.js";

export interface AgentRequestHandler {
  handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void>;
}

export function createAgentServer(handler: AgentRequestHandler): Server {
  return createServer((request, response) => {
    handler.handle(request, response).catch(() => {
      if (response.headersSent) {
        response.end();
        return;
      }
      response.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error.",
        },
      }));
    });
  });
}
