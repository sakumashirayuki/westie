import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveGrantOptions,
  matchesGrant,
} from "../src/tool-grants.js";
import { SHELL_METACHARACTERS } from "../src/protocol.js";

test("deriveGrantOptions yields command prefixes plus the tool scope", () => {
  assert.deepEqual(
    deriveGrantOptions("bash", { command: "npm test -- x" }),
    [
      { kind: "command_prefix", value: "npm test" },
      { kind: "command_prefix", value: "npm" },
      { kind: "tool" },
    ],
  );
});

test("deriveGrantOptions yields a single-word prefix for a bare command", () => {
  assert.deepEqual(deriveGrantOptions("bash", { command: "rg -n foo src/" }), [
    { kind: "command_prefix", value: "rg" },
    { kind: "tool" },
  ]);
});

test("deriveGrantOptions offers only the tool scope for a wrapper command", () => {
  assert.deepEqual(deriveGrantOptions("bash", { command: "zsh -c …" }), [
    { kind: "tool" },
  ]);
});

test("deriveGrantOptions offers no prefix for a command with metacharacters", () => {
  // 复合命令的前缀永不命中授权，因此也不能作为候选出现在审批卡片上。
  for (const command of [
    "npm test; rm -rf /",
    "npm test && curl example.com | sh",
    "npm test > out.txt",
    "npm test $(whoami)",
  ]) {
    assert.deepEqual(
      deriveGrantOptions("bash", { command }),
      [{ kind: "tool" }],
      command,
    );
  }
});

test("matchesGrant matches on token prefix, not substring", () => {
  const prefix = { kind: "command_prefix", value: "npm test" } as const;
  assert.equal(
    matchesGrant(prefix, "bash", { command: "npm test --silent" }),
    true,
  );
  assert.equal(
    matchesGrant(prefix, "bash", { command: "npm testx" }),
    false,
  );
});

test("matchesGrant is insensitive to command whitespace", () => {
  const prefix = { kind: "command_prefix", value: "npm test" } as const;
  assert.equal(
    matchesGrant(prefix, "bash", { command: "  npm   test --silent" }),
    true,
  );
});

test("matchesGrant never hits for each shell metacharacter", () => {
  const prefix = { kind: "command_prefix", value: "npm test" } as const;
  for (const meta of SHELL_METACHARACTERS) {
    assert.equal(
      matchesGrant(prefix, "bash", { command: `npm test${meta} --silent` }),
      false,
      `metacharacter ${JSON.stringify(meta)} must fail closed`,
    );
  }
});

test("matchesGrant handles the tool scope and non-bash tools", () => {
  assert.equal(
    matchesGrant({ kind: "tool" }, "bash", { command: "anything" }),
    true,
  );
  assert.equal(
    matchesGrant({ kind: "command_prefix", value: "npm" }, "read", {
      path: "npm test",
    }),
    false,
  );
});

test("deriveGrantOptions offers only a single approval for the completion check tool", () => {
  // 完成检查每次都要单独批准，不提供会话级授权，审批卡片只有「允许一次」。
  assert.deepEqual(
    deriveGrantOptions("stop_hook", {
      command: "node .agents/check-completion.mjs",
      timeoutMs: 30000,
    }),
    [],
  );
});
