import assert from "node:assert/strict";
import test from "node:test";

import {
  createSafeDotenvWorkspacePathRegex,
  createSensitiveWorkspacePathRegexes,
  isSensitiveWorkspacePath,
} from "../src/security/sensitive-path-policy.js";

const WORKSPACE = "/Users/example/project";

test("host path checks and Seatbelt patterns classify the same security vectors", () => {
  const sensitivePatterns =
    createSensitiveWorkspacePathRegexes().map((source) => new RegExp(source));
  const safeDotenvPattern =
    new RegExp(createSafeDotenvWorkspacePathRegex());

  for (const [relativePath, expected] of [
    [".env", true],
    ["nested/.ENV.production", true],
    [".npmrc", true],
    ["keys/id_ed25519", true],
    ["keys/server.key", true],
    ["keys/private-key.pem", true],
    ["config/client_secret_prod.json", true],
    [".aws/credentials", true],
    [".env.example", false],
    ["nested/.ENV.SAMPLE", false],
    ["certificates/server.pem", false],
    ["src/credentials.ts", false],
    ["src/secret-manager.ts", false],
  ] as const) {
    const candidate = `${WORKSPACE}/${relativePath}`;
    const seatbeltSensitive =
      sensitivePatterns.some((pattern) => pattern.test(candidate)) &&
      !safeDotenvPattern.test(candidate);
    assert.equal(
      isSensitiveWorkspacePath(WORKSPACE, candidate),
      expected,
      `host policy: ${relativePath}`,
    );
    assert.equal(
      seatbeltSensitive,
      expected,
      `Seatbelt policy: ${relativePath}`,
    );
  }
});
