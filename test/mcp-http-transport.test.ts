import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { HttpTransport } from "../src/mcp/http-transport.js";

interface TestServer extends AsyncDisposable {
  readonly url: string;
}

/** 进程内 HTTP 假 Server；`await using` 离开作用域即关闭监听。 */
async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<TestServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    [Symbol.asyncDispose]: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function readBody(req: IncomingMessage, then: () => void): void {
  req.on("data", () => {});
  req.on("end", then);
}

test("POSTs JSON and parses a JSON response", async () => {
  const seen: string[] = [];
  await using server = await startServer((req, res) => {
    readBody(req, () => {
      seen.push(req.headers["accept"] as string);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
    });
  });
  await using transport = new HttpTransport({ url: server.url });
  await transport.start();
  const received = transport.receive();
  await transport.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
  const inbound = await received;
  assert.equal(inbound?.kind, "response");
  assert.deepEqual(inbound?.kind === "response" ? inbound.result : null, { ok: true });
  assert.ok(seen[0]?.includes("text/event-stream"));
});

test("reads an SSE response", async () => {
  await using server = await startServer((req, res) => {
    readBody(req, () => {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        "data: " +
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }) +
          "\n\n",
      );
      res.end();
    });
  });
  await using transport = new HttpTransport({ url: server.url });
  await transport.start();
  const received = transport.receive();
  await transport.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  const inbound = await received;
  assert.equal(inbound?.kind, "response");
});

test("stores and replays Mcp-Session-Id", async () => {
  const seenSessionIds: Array<string | undefined> = [];
  await using server = await startServer((req, res) => {
    readBody(req, () => {
      seenSessionIds.push(req.headers["mcp-session-id"] as string | undefined);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Mcp-Session-Id", "session-123");
      res.end(
        JSON.stringify({ jsonrpc: "2.0", id: req.headers["x"] ? 2 : 1, result: {} }),
      );
    });
  });
  await using transport = new HttpTransport({ url: server.url });
  await transport.start();
  for (let i = 0; i < 2; i += 1) {
    const received = transport.receive();
    await transport.send({ jsonrpc: "2.0", id: i + 1, method: "ping", params: {} });
    await received;
  }
  assert.equal(seenSessionIds[0], undefined);
  assert.equal(seenSessionIds[1], "session-123");
});

test("sends MCP-Protocol-Version header", async () => {
  const seenVersions: Array<string | undefined> = [];
  await using server = await startServer((req, res) => {
    readBody(req, () => {
      seenVersions.push(req.headers["mcp-protocol-version"] as string | undefined);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
    });
  });
  await using transport = new HttpTransport({ url: server.url });
  await transport.start();
  const received = transport.receive();
  await transport.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
  await received;
  assert.equal(seenVersions[0], "2025-06-18");
});

test("DELETEs on close", async () => {
  let method = "";
  await using server = await startServer((req, res) => {
    method = req.method ?? "";
    res.end();
  });
  const transport = new HttpTransport({ url: server.url });
  await transport.start();
  await transport.close();
  assert.equal(method, "DELETE");
});

test("delivers a server-initiated request carried in the SSE stream", async () => {
  await using server = await startServer((req, res) => {
    readBody(req, () => {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        "data: " +
          JSON.stringify({ jsonrpc: "2.0", id: "srv-1", method: "roots/list" }) +
          "\n\n",
      );
      res.write(
        "data: " + JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\n\n",
      );
      res.end();
    });
  });
  await using transport = new HttpTransport({ url: server.url });
  await transport.start();
  const first = transport.receive();
  await transport.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
  const request = await first;
  assert.deepEqual(request, { kind: "request", id: "srv-1", method: "roots/list" });
  const response = await transport.receive();
  assert.equal(response?.kind, "response");
});
