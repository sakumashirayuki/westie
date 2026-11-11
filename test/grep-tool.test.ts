import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HostSandboxRunner } from "../src/sandbox/host-sandbox-runner.js";
import { ToolExecutionError } from "../src/tools.js";
import { createGrepTool } from "../src/tools/grep.js";

async function createWorkspace(t: test.TestContext): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "grep-tool-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

test("grep returns structured matches in ripgrep order", async (t) => {
  const workspace = await createWorkspace(t);
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "src", "first.ts"), "alpha\nbeta alpha\n");
  await writeFile(join(workspace, "src", "ignored.txt"), "alpha\n");
  const tool = await createGrepTool(workspace, new HostSandboxRunner());

  const result = await tool.execute(
    { pattern: "alpha", path: "src", glob: "*.ts" },
    {},
  );

  assert.deepEqual(result, {
    matches: [
      { path: "src/first.ts", line: 1, text: "alpha" },
      { path: "src/first.ts", line: 2, text: "beta alpha" },
    ],
  });
});

test("grep returns an empty match list and rejects workspace escapes", async (t) => {
  const workspace = await createWorkspace(t);
  await writeFile(join(workspace, "example.txt"), "content\n");
  const tool = await createGrepTool(workspace, new HostSandboxRunner());

  assert.deepEqual(await tool.execute({ pattern: "missing" }, {}), {
    matches: [],
  });
  await assert.rejects(
    tool.execute({ pattern: "content", path: "../" }, {}),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.code === "PATH_OUTSIDE_WORKSPACE",
  );
});
