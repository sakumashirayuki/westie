import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  runSpawnedCommand,
  type ProcessContainment,
} from "../src/sandbox/process-runner.js";
import { SandboxRunnerError } from "../src/sandbox/sandbox-runner.js";

test("reports a resource violation found during final containment cleanup", async () => {
  const violation = new SandboxRunnerError(
    "COMMAND_CPU_LIMIT_EXCEEDED",
    "Command exceeded the CPU time limit.",
  );
  let detectedViolation: unknown;
  const containment: ProcessContainment = {
    async terminate() {
      detectedViolation = violation;
    },
    getViolation() {
      return detectedViolation;
    },
  };

  await assert.rejects(
    runSpawnedCommand({
      executable: "/usr/bin/true",
      args: [],
      cwd: tmpdir(),
      env: process.env,
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      containment,
    }),
    (error: unknown) => error === violation,
  );
});

test("writes stdin to the command and closes the pipe", async () => {
  const result = await runSpawnedCommand({
    executable: "/bin/cat",
    args: [],
    cwd: tmpdir(),
    env: process.env,
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
    stdin: '{"event":"stop"}',
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '{"event":"stop"}');
});

test("leaves stdin closed when the command does not request input", async () => {
  const result = await runSpawnedCommand({
    executable: "/bin/cat",
    args: [],
    cwd: tmpdir(),
    env: process.env,
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "");
});

test("ignores a command that exits without reading stdin", async () => {
  const result = await runSpawnedCommand({
    executable: "/usr/bin/true",
    args: [],
    cwd: tmpdir(),
    env: process.env,
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
    stdin: "x".repeat(1024 * 1024),
  });
  assert.equal(result.exitCode, 0);
});
