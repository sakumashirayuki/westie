import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** 每个请求按顺序取一种响应方式；取完后重复最后一种。 */
export type FakeChatResponse =
  | { readonly kind: "stream"; readonly deltas: readonly string[] }
  | {
      readonly kind: "error";
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly code?: string;
    }
  /** 先发这些 delta，然后直接销毁 socket，模拟流中途断开。 */
  | { readonly kind: "disconnect"; readonly deltas: readonly string[] };

export interface FakeChatCompletionsServer extends AsyncDisposable {
  readonly baseURL: string;
  /** 已收到的请求数。 */
  readonly requestCount: number;
}

/** 本地 OpenAI 兼容 Chat Completions 服务，供真实 SDK 客户端做端到端测试。 */
export async function startFakeChatCompletionsServer(
  responses: readonly FakeChatResponse[],
): Promise<FakeChatCompletionsServer> {
  let requestCount = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const next = responses[Math.min(requestCount, responses.length - 1)]!;
      requestCount += 1;
      respond(response, next);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}`,
    get requestCount() {
      return requestCount;
    },
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function respond(response: ServerResponse, next: FakeChatResponse): void {
  if (next.kind === "error") {
    response.writeHead(next.status, {
      "content-type": "application/json",
      ...next.headers,
    });
    response.end(JSON.stringify({
      error: { message: `fake ${next.status}`, code: next.code ?? null },
    }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const delta of next.deltas) {
    response.write(sseChunk({ content: delta }, null));
  }
  if (next.kind === "disconnect") {
    response.socket?.destroy();
    return;
  }
  response.write(sseChunk({}, "stop"));
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake-model",
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function sseChunk(
  delta: Readonly<Record<string, string>>,
  finishReason: string | null,
): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}
