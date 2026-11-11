export interface SseMessage {
  id?: string;
  event?: string;
  data: string;
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const split = splitFrames(buffer);
      buffer = split.remainder;
      for (const frame of split.frames) {
        const message = parseFrame(frame);
        if (message !== undefined) yield message;
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      const message = parseFrame(buffer);
      if (message !== undefined) yield message;
    }
  } finally {
    reader.releaseLock();
  }
}

function splitFrames(buffer: string): { frames: string[]; remainder: string } {
  const frames: string[] = [];
  let start = 0;
  const separator = /\r\n\r\n|\n\n|\r\r/g;
  for (let match = separator.exec(buffer); match !== null; match = separator.exec(buffer)) {
    frames.push(buffer.slice(start, match.index));
    start = match.index + match[0].length;
  }
  return { frames, remainder: buffer.slice(start) };
}

function parseFrame(frame: string): SseMessage | undefined {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];

  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }

  if (data.length === 0) return undefined;
  return { ...(id === undefined ? {} : { id }), ...(event === undefined ? {} : { event }), data: data.join("\n") };
}
