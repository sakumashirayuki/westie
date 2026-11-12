import assert from "node:assert/strict";
import test from "node:test";

import {
  isLarkConfigEnabled,
  loadLarkConfig,
  normalizeLarkDomain,
} from "../src/lark/lark-config.js";

test("default domain is a complete https origin accepted by the Lark SDK", () => {
  const config = loadLarkConfig({});
  assert.equal(config.domain, "https://open.feishu.cn");
});

test("bare LARK_DOMAIN host is prefixed with https so URL parsing cannot fail", () => {
  assert.equal(normalizeLarkDomain("open.feishu.cn"), "https://open.feishu.cn");
  assert.equal(
    normalizeLarkDomain("  open.larksuite.com  "),
    "https://open.larksuite.com",
  );
});

test("LARK_DOMAIN that already carries a scheme is kept unchanged", () => {
  assert.equal(
    normalizeLarkDomain("https://open.larksuite.com"),
    "https://open.larksuite.com",
  );
  assert.equal(normalizeLarkDomain("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
});

test("blank or missing LARK_DOMAIN falls back to the default origin", () => {
  assert.equal(normalizeLarkDomain(undefined), "https://open.feishu.cn");
  assert.equal(normalizeLarkDomain(""), "https://open.feishu.cn");
  assert.equal(normalizeLarkDomain("   "), "https://open.feishu.cn");
});

test("bridge stays disabled when either credential is absent", () => {
  assert.equal(isLarkConfigEnabled(loadLarkConfig({})), false);
  assert.equal(
    isLarkConfigEnabled(loadLarkConfig({ LARK_APP_ID: "cli_x" })),
    false,
  );
  assert.equal(
    isLarkConfigEnabled(loadLarkConfig({ LARK_APP_SECRET: "secret" })),
    false,
  );
});

test("bridge enables only when both App ID and secret are provided", () => {
  const config = loadLarkConfig({
    LARK_APP_ID: "cli_x",
    LARK_APP_SECRET: "secret",
  });
  assert.equal(isLarkConfigEnabled(config), true);
  if (!isLarkConfigEnabled(config)) throw new Error("expected enabled config");
  assert.equal(config.appId, "cli_x");
  assert.equal(config.appSecret, "secret");
});

test("whitespace-only credentials are treated as absent", () => {
  const config = loadLarkConfig({ LARK_APP_ID: "  ", LARK_APP_SECRET: "" });
  assert.equal(isLarkConfigEnabled(config), false);
});

test("allowed open ids are split, trimmed and empty entries dropped", () => {
  const config = loadLarkConfig({
    LARK_ALLOWED_OPEN_IDS: "ou_a, ou_b ,,ou_c",
  });
  assert.deepEqual([...config.allowedOpenIds], ["ou_a", "ou_b", "ou_c"]);
});

test("absent whitelist yields an empty set instead of restricting access", () => {
  const config = loadLarkConfig({});
  assert.equal(config.allowedOpenIds.size, 0);
});
