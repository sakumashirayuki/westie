import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadWorkspaceInstructions } from "../src/infrastructure/workspace-instructions.js";

const MAX_WORKSPACE_INSTRUCTIONS_BYTES = 64 * 1024;

async function createWorkspace(t: test.TestContext): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "workspace-instructions-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

test("returns undefined when AGENTS.md is missing", async (t) => {
  const workspace = await createWorkspace(t);

  assert.equal(await loadWorkspaceInstructions(workspace), undefined);
});

test("returns undefined when AGENTS.md is empty", async (t) => {
  const workspace = await createWorkspace(t);
  await writeFile(join(workspace, "AGENTS.md"), "");

  assert.equal(await loadWorkspaceInstructions(workspace), undefined);
});

test("loads AGENTS.md as UTF-8 text", async (t) => {
  const workspace = await createWorkspace(t);
  const instructions = "# 项目指令\n\n保持改动简单。\n";
  await writeFile(join(workspace, "AGENTS.md"), instructions, "utf8");

  assert.equal(await loadWorkspaceInstructions(workspace), instructions);
});

test("accepts AGENTS.md at the exact byte limit", async (t) => {
  const workspace = await createWorkspace(t);
  const instructions = "a".repeat(MAX_WORKSPACE_INSTRUCTIONS_BYTES);
  await writeFile(join(workspace, "AGENTS.md"), instructions, "utf8");

  assert.equal(await loadWorkspaceInstructions(workspace), instructions);
});

test("rejects AGENTS.md over the byte limit", async (t) => {
  const workspace = await createWorkspace(t);
  await writeFile(
    join(workspace, "AGENTS.md"),
    "a".repeat(MAX_WORKSPACE_INSTRUCTIONS_BYTES + 1),
    "utf8",
  );

  await assert.rejects(
    loadWorkspaceInstructions(workspace),
    /Workspace instructions exceed 65536 bytes/,
  );
});

test("rejects AGENTS.md with invalid UTF-8", async (t) => {
  const workspace = await createWorkspace(t);
  await writeFile(join(workspace, "AGENTS.md"), Buffer.from([0xc3, 0x28]));

  await assert.rejects(
    loadWorkspaceInstructions(workspace),
    /Workspace instructions must be valid UTF-8/,
  );
});

test("rejects a directory named AGENTS.md", async (t) => {
  const workspace = await createWorkspace(t);
  await mkdir(join(workspace, "AGENTS.md"));

  await assert.rejects(
    loadWorkspaceInstructions(workspace),
    /Workspace instructions must be a regular file/,
  );
});

test("loads an AGENTS.md symbolic link that stays inside the workspace", async (t) => {
  const workspace = await createWorkspace(t);
  await writeFile(join(workspace, "instructions.md"), "linked instructions");
  await symlink("instructions.md", join(workspace, "AGENTS.md"));

  assert.equal(
    await loadWorkspaceInstructions(workspace),
    "linked instructions",
  );
});

test("rejects an AGENTS.md symbolic link that escapes the workspace", async (t) => {
  const workspace = await createWorkspace(t);
  const external = await mkdtemp(join(tmpdir(), "workspace-instructions-external-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(join(external, "instructions.md"), "external instructions");
  await symlink(
    join(external, "instructions.md"),
    join(workspace, "AGENTS.md"),
  );

  await assert.rejects(
    loadWorkspaceInstructions(workspace),
    /Workspace instructions must remain inside the workspace/,
  );
});
