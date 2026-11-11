import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type ModelMockResponse =
  | {
      readonly type: "text";
      readonly chunks: readonly string[];
      readonly pauseAfterFirst?: boolean;
    }
  | {
      readonly type: "tool_call";
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    };

export interface DeepSeekModelMock extends AsyncDisposable {
  readonly baseURL: string;
  setResponses(responses: readonly ModelMockResponse[]): void;
  resume(): void;
}

/** Starts the local Chat Completions endpoint used by the E2E worker. */
export async function startDeepSeekModelMock(): Promise<DeepSeekModelMock> {
  let responses: readonly ModelMockResponse[] = [];
  let responseIndex = 0;
  let releasePause: (() => void) | undefined;
  let closed = false;

  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    request.on("end", () => {
      const next = responses[responseIndex];
      responseIndex += 1;
      if (!next || (next.type === "tool_call" && next.name !== "write")) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "no fake model response" } }));
        return;
      }
      void writeResponse(request, response, next);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  const mock: DeepSeekModelMock = {
    baseURL: `http://127.0.0.1:${port}`,
    setResponses(next) {
      responses = next;
      responseIndex = 0;
      releasePause?.();
      releasePause = undefined;
    },
    resume() {
      releasePause?.();
      releasePause = undefined;
    },
    async [Symbol.asyncDispose]() {
      closed = true;
      releasePause?.();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  async function writeResponse(
    request: IncomingMessage,
    response: ServerResponse,
    next: ModelMockResponse,
  ): Promise<void> {
    if (closed || response.destroyed) return;
    const releaseOnClose = () => releasePause?.();
    request.once("aborted", releaseOnClose);
    response.once("close", releaseOnClose);
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
      connection: "keep-alive",
    });

    if (next.type === "text") {
      for (const [index, content] of next.chunks.entries()) {
        response.write(chunk({ content }, null));
        if (index === 0) {
          if (next.pauseAfterFirst) {
            await new Promise<void>((resolve) => {
              releasePause = resolve;
            });
          }
        }
      }
      response.write(chunk({}, "stop"));
    } else {
      response.write(chunk({
        tool_calls: [{
          index: 0,
          id: "call-e2e-write",
          type: "function",
          function: { name: next.name, arguments: JSON.stringify(next.arguments) },
        }],
      }, "tool_calls"));
    }
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-e2e",
      object: "chat.completion.chunk",
      created: 0,
      model: "deepseek-e2e",
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`);
    response.end("data: [DONE]\n\n");
  }

  return mock;
}

/** Redirects only DeepSeek Chat Completions calls and blocks external access. */
export function installDeepSeekFetchInterceptor(baseURL: string): () => void {
  const originalFetch = globalThis.fetch;
  const target = new URL(baseURL);
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.protocol === "https:" && url.hostname === "api.deepseek.com" && url.pathname === "/chat/completions") {
      url.protocol = target.protocol;
      url.hostname = target.hostname;
      url.port = target.port;
      url.pathname = "/chat/completions";
      return originalFetch(url, init);
    }
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return originalFetch(input, init);
    throw new Error(`unexpected external fetch in E2E: ${url.href}`);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function chunk(delta: Record<string, unknown>, finish_reason: string | null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 0,
    model: "deepseek-e2e",
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`;
}
