import { describe, expect, it } from "vitest";

import { parseSseStream } from "./sse";

function chunked(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("parseSseStream", () => {
  it("parses frames split across arbitrary chunks", async () => {
    const stream = chunked(
      "id: run:1\nevent: run.star",
      "ted\ndata: {\"type\":\"run.started\"}\n",
      "\ndata: first\ndata: second\n\n",
    );

    const messages = [];
    for await (const message of parseSseStream(stream)) messages.push(message);

    expect(messages).toEqual([
      { id: "run:1", event: "run.started", data: '{"type":"run.started"}' },
      { data: "first\nsecond" },
    ]);
  });

  it("handles CRLF separators split between chunks", async () => {
    const messages = [];
    for await (const message of parseSseStream(chunked("data: one\r\n\r", "\ndata: two\r\n\r\n"))) {
      messages.push(message.data);
    }
    expect(messages).toEqual(["one", "two"]);
  });
});
