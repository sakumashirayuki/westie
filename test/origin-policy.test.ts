import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import {
  applyCors,
  evaluateFullAccessRequest,
  isTrustedHostActionOrigin,
} from "../src/http/origin-policy.js";

test("CORS exposes only the exact configured origin", () => {
  const matching = response();
  applyCors(
    request("127.0.0.1:3000", "http://localhost:5173"),
    matching.value,
    "http://localhost:5173",
  );
  assert.deepEqual(matching.headers, {
    "Access-Control-Allow-Origin": "http://localhost:5173",
    Vary: "Origin",
  });

  const mismatched = response();
  applyCors(
    request("127.0.0.1:3000", "http://localhost:5174"),
    mismatched.value,
    "http://localhost:5173",
  );
  assert.deepEqual(mismatched.headers, {});
});

test("host actions allow local non-browser calls and the explicit allowed origin", () => {
  assert.equal(
    isTrustedHostActionOrigin(request("127.0.0.1:3000"), undefined),
    true,
  );
  assert.equal(
    isTrustedHostActionOrigin(
      request("127.0.0.1:3000", "https://console.example.com"),
      "https://console.example.com",
    ),
    true,
  );
});

test("host actions accept only same-host HTTP loopback origins otherwise", async (t) => {
  const cases: readonly [string, string, boolean][] = [
    ["localhost:3000", "http://localhost:3000", true],
    ["127.0.0.1:3000", "http://127.0.0.1:3000", true],
    ["[::1]:3000", "http://[::1]:3000", true],
    ["localhost:3000", "https://localhost:3000", false],
    ["localhost:3000", "http://localhost:3001", false],
    ["127.0.0.1:3000", "http://example.com:3000", false],
    ["localhost:3000", "not a URL", false],
  ];
  for (const [host, origin, expected] of cases) {
    await t.test(`${origin} against ${host}`, () => {
      assert.equal(
        isTrustedHostActionOrigin(request(host, origin), undefined),
        expected,
      );
    });
  }
});

test("workspace sandbox bypasses Full Access availability and origin gates", () => {
  assert.equal(
    evaluateFullAccessRequest(
      "workspace_sandbox",
      false,
      request("example.com", "https://untrusted.example"),
      undefined,
    ),
    "allowed",
  );
});

test("Full Access fails closed when the server has not enabled it", () => {
  assert.equal(
    evaluateFullAccessRequest(
      "full_access",
      false,
      request("localhost:3000", "http://localhost:3000"),
      undefined,
    ),
    "requires_loopback",
  );
  assert.equal(
    evaluateFullAccessRequest(
      "full_access",
      undefined,
      request("localhost:3000"),
      undefined,
    ),
    "requires_loopback",
  );
});

test("Full Access allows local non-browser and same-origin loopback requests", async (t) => {
  const cases: readonly [string, string | undefined][] = [
    ["localhost:3000", undefined],
    ["localhost:3000", "http://localhost:3000"],
    ["127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["[::1]:3000", "http://[::1]:3000"],
  ];
  for (const [host, origin] of cases) {
    await t.test(origin ?? "missing origin", () => {
      assert.equal(
        evaluateFullAccessRequest(
          "full_access",
          true,
          request(host, origin),
          undefined,
        ),
        "allowed",
      );
    });
  }
});

test("Full Access permits an exact configured cross-origin only when both origins are loopback", () => {
  const crossOrigin = "http://localhost:5173";
  assert.equal(
    evaluateFullAccessRequest(
      "full_access",
      true,
      request("127.0.0.1:3000", crossOrigin),
      crossOrigin,
    ),
    "allowed",
  );
  assert.equal(
    evaluateFullAccessRequest(
      "full_access",
      true,
      request("127.0.0.1:3000", "https://console.example.com"),
      "https://console.example.com",
    ),
    "untrusted_origin",
  );
});

test("Full Access rejects non-loopback, HTTPS, mismatched and malformed origins", async (t) => {
  const cases = [
    "https://localhost:3000",
    "http://localhost:3001",
    "http://example.com:3000",
    "not a URL",
  ];
  for (const origin of cases) {
    await t.test(origin, () => {
      assert.equal(
        evaluateFullAccessRequest(
          "full_access",
          true,
          request("localhost:3000", origin),
          undefined,
        ),
        "untrusted_origin",
      );
    });
  }
});

function request(host: string, origin?: string): IncomingMessage {
  return {
    headers: {
      host,
      ...(origin === undefined ? {} : { origin }),
    },
  } as IncomingMessage;
}

function response(): {
  readonly value: ServerResponse;
  readonly headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  return {
    headers,
    value: {
      setHeader(name: string, value: number | string | readonly string[]) {
        headers[name] = String(value);
        return this;
      },
    } as ServerResponse,
  };
}
