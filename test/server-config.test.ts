import assert from "node:assert/strict";
import test from "node:test";

import {
  isLoopbackBindHost,
  loadAgentServerConfig,
  loadAgentModelCapacity,
} from "../src/server-config.js";

const requiredEnvironment = {
  AGENT_MODEL_CONTEXT_TOKENS: "1000000",
  AGENT_MODEL_MAX_OUTPUT_TOKENS: "8192",
};

test("loads defaults and resolves the database path from the workspace", () => {
  const config = loadAgentServerConfig(requiredEnvironment, "/workspace");

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3000);
  assert.equal(
    config.databasePath,
    "/workspace/.data/agent-harness.sqlite",
  );
  assert.equal(config.modelContextTokens, 1_000_000);
  assert.equal(config.modelMaxOutputTokens, 8_192);
});

test("preserves absolute database paths and parses optional settings", () => {
  const config = loadAgentServerConfig({
    ...requiredEnvironment,
    AGENT_DATABASE_PATH: "/tmp/agent.sqlite",
    HOST: "0.0.0.0",
    PORT: "8080",
    CORS_ALLOW_ORIGIN: " http://localhost:5173 ",
  }, "/workspace");

  assert.equal(config.databasePath, "/tmp/agent.sqlite");
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 8_080);
  assert.equal(config.allowedOrigin, "http://localhost:5173");
});

test("rejects missing or invalid token capacities", () => {
  assert.throws(
    () => loadAgentServerConfig({}, "/workspace"),
    /AGENT_MODEL_CONTEXT_TOKENS/,
  );
  // AGENT_BYTES_PER_TOKEN 是比值，小数合法（默认 2.5），只拒非正数与非有限值。
  for (const value of ["0", "-1", "NaN", "abc", "Infinity"]) {
    assert.throws(
      () => loadAgentServerConfig({
        ...requiredEnvironment,
        AGENT_BYTES_PER_TOKEN: value,
      }, "/workspace"),
      /AGENT_BYTES_PER_TOKEN/,
    );
  }
});

test("classifies loopback bind hosts for Full Access", () => {
  for (const host of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
    assert.equal(isLoopbackBindHost(host), true);
  }
  for (const host of ["0.0.0.0", "::", "192.168.1.10"]) {
    assert.equal(isLoopbackBindHost(host), false);
  }
});

test("reads the compaction tuning knobs and leaves them undefined when absent", () => {
  const defaults = loadAgentServerConfig(requiredEnvironment, "/workspace");
  assert.equal(defaults.summaryBudgetRatio, undefined);
  assert.equal(defaults.compactionRecentPairs, undefined);

  const tuned = loadAgentServerConfig({
    ...requiredEnvironment,
    AGENT_SUMMARY_BUDGET_RATIO: "0.02",
    AGENT_COMPACTION_RECENT_PAIRS: "3",
  }, "/workspace");
  assert.equal(tuned.summaryBudgetRatio, 0.02);
  assert.equal(tuned.compactionRecentPairs, 3);
});

test("rejects a summary ratio outside (0, 1] and a non-positive recent window", () => {
  for (const value of ["0", "-0.5", "1.5", "abc"]) {
    assert.throws(
      () =>
        loadAgentServerConfig({
          ...requiredEnvironment,
          AGENT_SUMMARY_BUDGET_RATIO: value,
        }, "/workspace"),
      /AGENT_SUMMARY_BUDGET_RATIO must be a number in \(0, 1\]/,
    );
  }
  assert.throws(
    () =>
      loadAgentServerConfig({
        ...requiredEnvironment,
        AGENT_COMPACTION_RECENT_PAIRS: "0",
      }, "/workspace"),
    /AGENT_COMPACTION_RECENT_PAIRS must be a positive safe integer/,
  );
});


test("CLI model capacity uses the same values without parsing server settings", () => {
  const environment = { ...requiredEnvironment, PORT: "not-a-port" };
  assert.deepEqual(loadAgentModelCapacity(environment), {
    contextWindowTokens: 1_000_000, maxOutputTokens: 8_192,
  });
  assert.throws(() => loadAgentModelCapacity({ ...requiredEnvironment, AGENT_MODEL_CONTEXT_TOKENS: "0" }), /AGENT_MODEL_CONTEXT_TOKENS/);
});

test("resolves the project memory root from an absolute AGENT_MEMORY_ROOT", () => {
  const configured = loadAgentServerConfig({
    AGENT_MODEL_CONTEXT_TOKENS: "1000",
    AGENT_MODEL_MAX_OUTPUT_TOKENS: "100",
    AGENT_MEMORY_ROOT: "/tmp/harness-memory",
  }, "/workspace");
  assert.equal(configured.memoryRoot, "/tmp/harness-memory");

  const defaults = loadAgentServerConfig({
    AGENT_MODEL_CONTEXT_TOKENS: "1000",
    AGENT_MODEL_MAX_OUTPUT_TOKENS: "100",
  }, "/workspace");
  assert.match(defaults.memoryRoot, /[\\/]\.my-agent-harness[\\/]memory$/);

  assert.throws(
    () => loadAgentServerConfig({
      AGENT_MODEL_CONTEXT_TOKENS: "1000",
      AGENT_MODEL_MAX_OUTPUT_TOKENS: "100",
      AGENT_MEMORY_ROOT: "relative/memory",
    }, "/workspace"),
    /AGENT_MEMORY_ROOT must be an absolute path/,
  );
});
