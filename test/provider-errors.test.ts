import assert from "node:assert/strict";
import test from "node:test";

import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  InternalServerError,
  RateLimitError,
} from "openai";

import {
  ProviderTransientError,
  type ProviderTransientReason,
} from "../src/provider-protocol.js";
import {
  classifyProviderError,
  parseRetryAfter,
} from "../src/providers/provider-errors.js";

function apiError(
  status: number,
  opts: { code?: unknown; headers?: Record<string, string> } = {},
): APIError {
  return APIError.generate(
    status,
    opts.code === undefined
      ? { error: { message: `${status} error` } }
      : { error: { message: `${status} error`, code: opts.code } },
    undefined,
    new Headers(opts.headers),
  );
}

test("classifies connection timeout as timeout", () => {
  const err = new APIConnectionTimeoutError();
  const result = classifyProviderError(err);
  assert.ok(result instanceof ProviderTransientError);
  assert.equal(result?.reason, "timeout");
});

test("classifies connection error as connection", () => {
  const err = new APIConnectionError({ cause: new Error("ECONNREFUSED") });
  const result = classifyProviderError(err);
  assert.ok(result instanceof ProviderTransientError);
  assert.equal(result?.reason, "connection");
});

test("classifies 408 as timeout", () => {
  const result = classifyProviderError(apiError(408));
  assert.equal(result?.reason, "timeout");
});

test("classifies 429 as rate_limited but rejects insufficient_quota", () => {
  const limited = classifyProviderError(apiError(429));
  assert.equal(limited?.reason, "rate_limited");

  const quota = classifyProviderError(apiError(429, { code: "insufficient_quota" }));
  assert.equal(quota, undefined);
});

test("classifies 500/502/504 as server_error", () => {
  for (const status of [500, 502, 504]) {
    assert.equal(
      classifyProviderError(apiError(status))?.reason,
      "server_error",
    );
  }
});

test("classifies 503/529 as overloaded", () => {
  for (const status of [503, 529]) {
    assert.equal(
      classifyProviderError(apiError(status))?.reason,
      "overloaded",
    );
  }
});

test("does not classify other 4xx", () => {
  for (const status of [400, 401, 402, 403, 404, 409, 422]) {
    assert.equal(classifyProviderError(apiError(status)), undefined, `${status}`);
  }
});

test("classifies connection failure by message", () => {
  assert.equal(
    classifyProviderError(new TypeError("terminated"))?.reason,
    "connection",
  );
  assert.equal(
    classifyProviderError(new Error("ECONNRESET"))?.reason,
    "connection",
  );
  assert.equal(
    classifyProviderError(new Error("UND_ERR_SOCKET"))?.reason,
    "connection",
  );
  assert.equal(
    classifyProviderError(
      new Error("fetch failed", { cause: new Error("ECONNRESET") }),
    )?.reason,
    "connection",
  );
});

test("classifies ordinary errors as undefined", () => {
  assert.equal(classifyProviderError(new Error("boom")), undefined);
  assert.equal(classifyProviderError("not an error"), undefined);
  assert.equal(classifyProviderError(undefined), undefined);
});

test("classifies OpenAI response.failed error events", () => {
  const server = classifyProviderError(undefined, {
    type: "response.failed",
    response: {
      status: "failed",
      error: { code: "server_error", message: "boom" },
    },
  } as never);
  assert.equal(server?.reason, "server_error");

  const rate = classifyProviderError(undefined, {
    type: "response.failed",
    response: {
      status: "failed",
      error: { code: "rate_limit_exceeded", message: "slow down" },
    },
  } as never);
  assert.equal(rate?.reason, "rate_limited");

  const other = classifyProviderError(undefined, {
    type: "response.failed",
    response: {
      status: "failed",
      error: { code: "invalid_prompt", message: "bad" },
    },
  } as never);
  assert.equal(other, undefined);
});

test("classifies OpenAI error stream events", () => {
  const server = classifyProviderError(undefined, {
    type: "error",
    code: "server_error",
    message: "boom",
    param: null,
    sequence_number: 1,
  });
  assert.equal(server?.reason, "server_error");

  const rate = classifyProviderError(undefined, {
    type: "error",
    code: "rate_limit_exceeded",
    message: "slow down",
    param: null,
    sequence_number: 1,
  });
  assert.equal(rate?.reason, "rate_limited");

  const other = classifyProviderError(undefined, {
    type: "error",
    code: "invalid_prompt",
    message: "bad",
    param: null,
    sequence_number: 1,
  });
  assert.equal(other, undefined);
});

test("passes through an existing ProviderTransientError", () => {
  const original = new ProviderTransientError("overloaded", "x");
  assert.equal(classifyProviderError(original), original);
});

test("parseRetryAfter honors retry-after-ms first", () => {
  assert.equal(
    parseRetryAfter(new Headers({ "retry-after-ms": "4500", "retry-after": "2" })),
    4500,
  );
});

test("parseRetryAfter parses retry-after seconds", () => {
  assert.equal(parseRetryAfter(new Headers({ "retry-after": "3" })), 3000);
});

test("parseRetryAfter parses retry-after HTTP dates", () => {
  const date = new Date(Date.now() + 5000).toUTCString();
  const millis = parseRetryAfter(new Headers({ "retry-after": date }));
  assert.ok(millis !== undefined && millis > 0, `got ${millis}`);
});

test("parseRetryAfter drops negative and NaN", () => {
  assert.equal(parseRetryAfter(new Headers({ "retry-after-ms": "-1" })), undefined);
  assert.equal(parseRetryAfter(new Headers({ "retry-after-ms": "abc" })), undefined);
  assert.equal(parseRetryAfter(new Headers({ "retry-after": "-2" })), undefined);
  assert.equal(parseRetryAfter(undefined), undefined);
});

test("x-should-retry: false suppresses retry", () => {
  assert.equal(
    classifyProviderError(apiError(503, { headers: { "x-should-retry": "false" } })),
    undefined,
  );
});

test("x-should-retry: true keeps transient classification", () => {
  assert.equal(
    classifyProviderError(apiError(503, { headers: { "x-should-retry": "true" } }))
      ?.reason,
    "overloaded",
  );
});

test("transient errors carry retryAfterMs from headers", () => {
  const result = classifyProviderError(
    apiError(429, { headers: { "retry-after": "5" } }),
  );
  assert.equal(result?.retryAfterMs, 5000);
  assert.equal(result?.reason, "rate_limited");
});

test("transient error reasons are exhaustive", () => {
  const reasons: ProviderTransientReason[] = [
    "rate_limited",
    "server_error",
    "overloaded",
    "timeout",
    "connection",
  ];
  assert.deepEqual(reasons.sort(), [
    "connection",
    "overloaded",
    "rate_limited",
    "server_error",
    "timeout",
  ]);
});

void InternalServerError;
void RateLimitError;
