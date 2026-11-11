import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import type { JsonValue } from "../src/protocol.js";
import { HostSandboxRunner } from "../src/sandbox/host-sandbox-runner.js";
import {
  SandboxRunnerError,
  type SandboxRunner,
} from "../src/sandbox/sandbox-runner.js";
import { ToolExecutionError } from "../src/tools.js";
import { createGlobTool } from "../src/tools/glob.js";

interface GlobOutput {
  paths: string[];
  omitted?: string;
}

function asGlob(value: JsonValue): GlobOutput {
  return value as unknown as GlobOutput;
}

async function createWorkspace(t: test.TestContext): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "glob-tool-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

test("lists files matching a glob, ordered by mtime descending", async (t) => {
  const workspace = await createWorkspace(t);
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "src", "a.ts"), "a");
  await writeFile(join(workspace, "src", "b.ts"), "b");
  // a.ts newer than b.ts
  const old = new Date(2000, 0, 1);
  const newer = new Date(2020, 0, 1);
  await utimes(join(workspace, "src", "a.ts"), newer, newer);
  await utimes(join(workspace, "src", "b.ts"), old, old);

  const tool = await createGlobTool(workspace, new HostSandboxRunner());
  const result = await tool.execute({ pattern: "**/*.ts", path: "src" });

  assert.deepEqual(result, {
    paths: ["src/a.ts", "src/b.ts"],
  });
});

test("returns empty array for no match", async (t) => {
  const workspace = await createWorkspace(t);
  const tool = await createGlobTool(workspace, new HostSandboxRunner());
  assert.deepEqual(await tool.execute({ pattern: "*.nomatch" }), { paths: [] });
});

test("rejects workspace escapes", async (t) => {
  const workspace = await createWorkspace(t);
  await writeFile(join(workspace, "a.txt"), "a");
  const tool = await createGlobTool(workspace, new HostSandboxRunner());
  await assert.rejects(
    tool.execute({ pattern: "**/*", path: "../" }),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.code === "PATH_OUTSIDE_WORKSPACE",
  );
});

test("skips sensitive workspace paths", async (t) => {
  const workspace = await createWorkspace(t);
  await writeFile(join(workspace, "app.ts"), "a");
  await writeFile(join(workspace, "id_rsa"), "secret");
  const tool = await createGlobTool(workspace, new HostSandboxRunner());
  const result = await tool.execute({ pattern: "**/*" });
  assert.deepEqual(result, { paths: ["app.ts"] });
});

test("respects .gitignore and hidden files by default", async (t) => {
  const workspace = await createWorkspace(t);
  await mkdir(join(workspace, ".git"));
  await writeFile(join(workspace, ".gitignore"), "ignored.txt\n");
  await writeFile(join(workspace, "kept.ts"), "a");
  await writeFile(join(workspace, "ignored.txt"), "b");
  await writeFile(join(workspace, ".hidden"), "c");
  const tool = await createGlobTool(workspace, new HostSandboxRunner());
  const result = await tool.execute({ pattern: "**/*" });
  assert.deepEqual(result, { paths: ["kept.ts"] });
});

test("over 500 results produces omitted message", async (t) => {
  const workspace = await createWorkspace(t);
  await mkdir(join(workspace, "many"));
  for (let i = 0; i < 600; i += 1) {
    await writeFile(join(workspace, "many", `f${String(i).padStart(4, "0")}.txt`), "x");
  }
  const tool = await createGlobTool(workspace, new HostSandboxRunner());
  const result = asGlob(await tool.execute({ pattern: "many/*.txt" }));
  assert.equal(result.paths.length, 500);
  assert.ok(result.omitted !== undefined);
  assert.match(result.omitted!, /100 paths omitted/);
  assert.match(result.omitted!, /many\/\*\.txt/);
});

test("full_access allows absolute path outside workspace", async (t) => {
  const workspace = await createWorkspace(t);
  const outside = await mkdtemp(join(tmpdir(), "glob-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "z.txt"), "z");

  const tool = await createGlobTool(workspace, new HostSandboxRunner(), "full_access");
  const result = asGlob(await tool.execute({ pattern: "*.txt", path: outside }));
  assert.equal(result.paths.length, 1);
  assert.equal(basename(result.paths[0]!), "z.txt");
});

test("filters by pattern before the result cap so a narrow glob in a large tree still returns", async (t) => {
  const workspace = await createWorkspace(t);
  await mkdir(join(workspace, "many"));
  for (let i = 0; i < 600; i += 1) {
    await writeFile(join(workspace, "many", `f${String(i).padStart(4, "0")}.txt`), "x");
  }
  await writeFile(join(workspace, "many", "only.ts"), "y");
  const tool = await createGlobTool(workspace, new HostSandboxRunner());
  assert.deepEqual(await tool.execute({ pattern: "**/*.ts" }), {
    paths: ["many/only.ts"],
  });
});

test("explains that path must be narrowed when the file listing itself is too large", async (t) => {
  const workspace = await createWorkspace(t);
  const runner: SandboxRunner = {
    async run() {
      throw new SandboxRunnerError(
        "COMMAND_OUTPUT_TOO_LARGE",
        "Command output exceeded the maximum size.",
      );
    },
  };
  const tool = await createGlobTool(workspace, runner);
  await assert.rejects(
    tool.execute({ pattern: "*.ts" }),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.code === "COMMAND_OUTPUT_TOO_LARGE" &&
      /narrow(er)? .*path/i.test(error.message),
  );
});
