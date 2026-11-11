import assert from "node:assert/strict";
import test from "node:test";

import { McpClient } from "../src/mcp/client.js";
import { McpServerRpcError } from "../src/mcp/json-rpc.js";
import { MemoryTransport } from "./support/mcp-transport.js";

function makePair(): { transport: MemoryTransport; client: McpClient } {
  const transport = new MemoryTransport();
  return { transport, client: new McpClient(transport) };
}

async function connect(
  client: McpClient,
  transport: MemoryTransport,
): Promise<void> {
  const connecting = client.connect();
  const init = await transport.nextRequest();
  transport.push({
    kind: "response",
    id: init.id,
    result: { protocolVersion: "2025-06-18" },
  });
  await connecting;
}

test("perform initialize and list tools with paging", async () => {
  const { transport, client } = makePair();
  await using _client = client;
  await connect(client, transport);
  assert.ok(transport.outbound.some((m) =>
    !("id" in m) && m.method === "notifications/initialized"
  ));

  const listing = client.listTools();
  const page1 = await transport.nextRequest();
  transport.push({
    kind: "response",
    id: page1.id,
    result: {
      tools: [{ name: "a", inputSchema: { type: "object" } }],
      nextCursor: "c1",
    },
  });
  const page2 = await transport.nextRequest();
  transport.push({
    kind: "response",
    id: page2.id,
    result: { tools: [{ name: "b", inputSchema: { type: "object" } }] },
  });
  const tools = await listing;
  assert.deepEqual(tools.map((t) => t.name), ["a", "b"]);
});

test("rejects an unsupported protocol version", async () => {
  const { transport, client } = makePair();
  await using _client = client;
  const connecting = client.connect();
  const init = await transport.nextRequest();
  transport.push({
    kind: "response",
    id: init.id,
    result: { protocolVersion: "1900-01-01" },
  });
  await assert.rejects(connecting, /protocol version/);
});

test("maps a server error to McpServerRpcError", async () => {
  const { transport, client } = makePair();
  await using _client = client;
  await connect(client, transport);
  const listing = client.listTools();
  const list = await transport.nextRequest();
  transport.push({ kind: "error", id: list.id, code: -32602, message: "bad" });
  await assert.rejects(listing, McpServerRpcError);
});

test("replies -32601 to inbound server requests", async () => {
  const { transport, client } = makePair();
  await using _client = client;
  await connect(client, transport);
  transport.push({
    kind: "request",
    id: "req-1",
    method: "sampling/createMessage",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  // 必须是带原 id 的 JSON-RPC 错误响应，而不是一条自造的通知。
  assert.deepEqual(transport.responses, [{
    jsonrpc: "2.0",
    id: "req-1",
    error: { code: -32601, message: "Method not found" },
  }]);
  assert.ok(!transport.outbound.some((m) =>
    !("id" in m) && m.method.startsWith("notifications/request")
  ));
});

test("sends notifications/cancelled on timeout", async () => {
  const { transport, client } = makePair();
  await using _client = client;
  await connect(client, transport);
  const call = client.callTool("slow", {}, 50);
  await transport.nextRequest();
  await assert.rejects(call, /timed out/);
  assert.ok(transport.outbound.some((m) =>
    !("id" in m) && m.method === "notifications/cancelled"
  ));
});

test("a transport that throws while receiving settles pending calls", async () => {
  const { transport, client } = makePair();
  await using _client = client;
  await connect(client, transport);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const call = client.callTool("echo", {}, 1_000);
    await transport.nextRequest();
    transport.failNextReceive(new Error("socket reset"));
    await assert.rejects(call, /socket reset/);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
