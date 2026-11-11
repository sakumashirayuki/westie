import assert from "node:assert/strict";
import test from "node:test";

import {
  JsonRpcProtocolError,
  parseJsonRpcMessage,
  serializeJsonRpcMessage,
} from "../src/mcp/json-rpc.js";

test("serializes a request as a single JSON line", () => {
  assert.equal(
    serializeJsonRpcMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    }),
  );
});

test("parses a success response", () => {
  assert.deepEqual(
    parseJsonRpcMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    ),
    { jsonrpc: "2.0", id: 1, result: { tools: [] } },
  );
});

test("parses an error response", () => {
  const parsed = parseJsonRpcMessage(
    JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "nope" } }),
  );
  assert.deepEqual(parsed, {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32601, message: "nope" },
  });
});

test("parses a notification", () => {
  assert.deepEqual(
    parseJsonRpcMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ),
    { jsonrpc: "2.0", method: "notifications/initialized" },
  );
});

test("parses an inbound request (id + method)", () => {
  assert.deepEqual(
    parseJsonRpcMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "abc",
        method: "sampling/createMessage",
      }),
    ),
    { jsonrpc: "2.0", id: "abc", method: "sampling/createMessage" },
  );
});

test("rejects invalid JSON and non-2.0 objects", () => {
  assert.throws(
    () => parseJsonRpcMessage("not json"),
    JsonRpcProtocolError,
  );
  assert.throws(
    () => parseJsonRpcMessage(JSON.stringify({ jsonrpc: "1.0", id: 1, result: {} })),
    JsonRpcProtocolError,
  );
  assert.throws(
    () => parseJsonRpcMessage(JSON.stringify({ jsonrpc: "2.0", id: 1 })),
    JsonRpcProtocolError,
  );
});
