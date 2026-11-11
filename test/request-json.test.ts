import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { z } from "zod";

import { parseJsonRequest } from "../src/http/request-json.js";

const schema = z.strictObject({
  value: z.string().min(1),
});
const invalidRequest = {
  code: "INVALID_TEST_REQUEST",
  message: "The test request is invalid.",
};

test("parses a valid JSON request with a charset content type", async () => {
  const result = await parseJsonRequest(
    request([Buffer.from('{"value":"ok"}')], "Application/JSON; Charset=UTF-8"),
    schema,
    invalidRequest,
  );

  assert.deepEqual(result, { ok: true, data: { value: "ok" } });
});

test("rejects missing and unsupported content types without reading the body", async (t) => {
  for (const contentType of [undefined, "text/plain"] as const) {
    await t.test(contentType ?? "missing", async () => {
      const result = await parseJsonRequest(
        request(['{"value":"ok"}'], contentType),
        schema,
        invalidRequest,
      );
      assert.deepEqual(result, {
        ok: false,
        error: {
          status: 415,
          code: "UNSUPPORTED_MEDIA_TYPE",
          message: "Content-Type must be application/json.",
        },
      });
    });
  }
});

test("maps empty and malformed bodies to the stable invalid JSON error", async (t) => {
  for (const body of ["", "{"] as const) {
    await t.test(body === "" ? "empty" : "malformed", async () => {
      const result = await parseJsonRequest(
        request([body], "application/json"),
        schema,
        invalidRequest,
      );
      assert.deepEqual(result, {
        ok: false,
        error: {
          status: 400,
          code: "INVALID_JSON",
          message: "Request body is not valid JSON.",
        },
      });
    });
  }
});

test("returns the route-provided 422 error when strict schema validation fails", async (t) => {
  for (const body of [
    '{"value":""}',
    '{"value":"ok","extra":true}',
  ]) {
    await t.test(body, async () => {
      const result = await parseJsonRequest(
        request([body], "application/json"),
        schema,
        invalidRequest,
      );
      assert.deepEqual(result, {
        ok: false,
        error: {
          status: 422,
          code: invalidRequest.code,
          message: invalidRequest.message,
        },
      });
    });
  }
});

test("accepts exactly 64 KiB and rejects one byte more across chunks", async () => {
  const emptyBody = JSON.stringify({ value: "" });
  const exactBody = JSON.stringify({
    value: "x".repeat(64 * 1024 - Buffer.byteLength(emptyBody)),
  });
  assert.equal(Buffer.byteLength(exactBody), 64 * 1024);

  const exact = await parseJsonRequest(
    request([
      exactBody.slice(0, 10_000),
      Buffer.from(exactBody.slice(10_000)),
    ], "application/json"),
    schema,
    invalidRequest,
  );
  assert.equal(exact.ok, true);

  const oversizedBody = JSON.stringify({
    value: "x".repeat(64 * 1024 - Buffer.byteLength(emptyBody) + 1),
  });
  assert.equal(Buffer.byteLength(oversizedBody), 64 * 1024 + 1);
  const oversized = await parseJsonRequest(
    request([
      oversizedBody.slice(0, 32 * 1024),
      oversizedBody.slice(32 * 1024),
    ], "application/json"),
    schema,
    invalidRequest,
  );
  assert.deepEqual(oversized, {
    ok: false,
    error: {
      status: 413,
      code: "REQUEST_TOO_LARGE",
      message: "Request body exceeds 65536 bytes.",
    },
  });
});

function request(
  chunks: readonly (string | Buffer)[],
  contentType: string | undefined,
): IncomingMessage {
  const stream = Readable.from(chunks) as IncomingMessage;
  Object.defineProperty(stream, "headers", {
    value: contentType === undefined ? {} : { "content-type": contentType },
  });
  return stream;
}
