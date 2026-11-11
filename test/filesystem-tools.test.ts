import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryWorkspaceGrantStore } from "../src/application/workspace-grant-store.js";
import { createEditTool } from "../src/tools/edit.js";
import { createReadTool } from "../src/tools/read.js";
import { createWriteTool } from "../src/tools/write.js";
import { ToolRegistry } from "../src/tools.js";

async function createWorkspace(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test(
  "read returns a 1-based line window for relative and absolute paths",
  async (t) => {
    const workspace = await createWorkspace(t);
    const file = join(workspace, "notes.txt");
    await writeFile(file, "one\ntwo\nthree\nfour", "utf8");
    const registry = new ToolRegistry([await createReadTool(workspace)]);

    const relativeResult = await registry.execute("read", {
      path: "notes.txt",
      offset: 2,
      limit: 2,
    });
    assert.deepEqual(relativeResult, {
      type: "tool_result",
      tool: "read",
      status: "success",
      output: {
        content: "two\nthree",
        startLine: 2,
        endLine: 3,
        totalLines: 4,
      },
    });

    const absoluteResult = await registry.execute("read", {
      path: file,
      limit: 1,
    });
    assert.deepEqual(absoluteResult, {
      type: "tool_result",
      tool: "read",
      status: "success",
      output: { content: "one", startLine: 1, endLine: 1, totalLines: 4 },
    });
  },
);

test("read returns up to 1000 lines in one call by default", async (t) => {
  const workspace = await createWorkspace(t);
  const lines = Array.from({ length: 1_200 }, (_, index) => `line ${index + 1}`);
  await writeFile(join(workspace, "long.txt"), lines.join("\n"), "utf8");
  const registry = new ToolRegistry([await createReadTool(workspace)]);

  const result = await registry.execute("read", { path: "long.txt" });

  assert.equal(result.status, "success");
  if (result.status !== "success") return;
  const output = result.output as {
    readonly content: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly totalLines: number;
  };
  assert.equal(output.startLine, 1);
  assert.equal(output.endLine, 1_000);
  assert.equal(output.totalLines, 1_200);
  assert.equal(output.content.split("\n").length, 1_000);
});

test("read serializes a full-size file without tripping the output cap", async (t) => {
  const workspace = await createWorkspace(t);
  // Every quote and newline doubles in size once the output is JSON encoded.
  const line = `"${"a".repeat(62)}"`;
  const lines = Array.from({ length: 1_000 }, () => line);
  await writeFile(join(workspace, "quoted.ts"), lines.join("\n"), "utf8");
  const registry = new ToolRegistry([await createReadTool(workspace)]);

  const result = await registry.execute("read", { path: "quoted.ts" });

  assert.equal(result.status, "success");
});

test("invalid tool input names the missing required fields", async (t) => {
  const workspace = await createWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "one\ntwo", "utf8");
  const registry = new ToolRegistry([await createEditTool(workspace)]);

  const result = await registry.execute("edit", {
    oldText: "one",
    newText: "1",
  });

  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.equal(result.error.code, "INVALID_TOOL_INPUT");
  assert.match(result.error.message, /edit is missing required field\(s\): path/);
  assert.match(result.error.message, /single call/);
});

test("read rejects binary files containing NUL", async (t) => {
  const workspace = await createWorkspace(t);
  await writeFile(join(workspace, "binary.dat"), Buffer.from([65, 0, 66]));
  const registry = new ToolRegistry([await createReadTool(workspace)]);

  const result = await registry.execute("read", { path: "binary.dat" });
  assert.equal(result.status, "error");
  assert.equal(
    result.status === "error" ? result.error.code : undefined,
    "FILE_NOT_TEXT",
  );
});

test("read rejects malformed UTF-8 and oversized files before returning content", async (t) => {
  const workspace = await createWorkspace(t);
  await writeFile(join(workspace, "malformed.txt"), Buffer.from([0xc3, 0x28]));
  await writeFile(join(workspace, "large.txt"), Buffer.alloc(64 * 1024 + 1, 65));
  const registry = new ToolRegistry([await createReadTool(workspace)]);

  const malformed = await registry.execute("read", { path: "malformed.txt" });
  assert.equal(malformed.status, "error");
  assert.equal(
    malformed.status === "error" ? malformed.error.code : undefined,
    "FILE_NOT_TEXT",
  );

  const oversized = await registry.execute("read", { path: "large.txt" });
  assert.equal(oversized.status, "error");
  assert.equal(
    oversized.status === "error" ? oversized.error.code : undefined,
    "TOOL_OUTPUT_TOO_LARGE",
  );
});

test("write creates and completely overwrites files without creating parents", async (t) => {
  const workspace = await createWorkspace(t);
  const registry = new ToolRegistry([await createWriteTool(workspace)]);

  assert.equal(
    (await registry.execute("write", {
      path: "file.txt",
      content: "first",
    })).status,
    "success",
  );
  await registry.execute("write", { path: "file.txt", content: "second" });
  assert.equal(await readFile(join(workspace, "file.txt"), "utf8"), "second");

  const missingParent = await registry.execute("write", {
    path: "missing/file.txt",
    content: "content",
  });
  assert.equal(missingParent.status, "error");
  assert.equal(
    missingParent.status === "error" ? missingParent.error.code : undefined,
    "FILE_NOT_FOUND",
  );
});

test("edit replaces one match and replaceAll must be explicit", async (t) => {
  const workspace = await createWorkspace(t);
  const file = join(workspace, "file.txt");
  const registry = new ToolRegistry([await createEditTool(workspace)]);

  await writeFile(file, "one two", "utf8");
  const single = await registry.execute("edit", {
    path: "file.txt",
    oldText: "two",
    newText: "three",
  });
  assert.equal(single.status, "success");
  assert.equal(await readFile(file, "utf8"), "one three");

  await writeFile(file, "x x", "utf8");
  const conflict = await registry.execute("edit", {
    path: "file.txt",
    oldText: "x",
    newText: "y",
  });
  assert.equal(conflict.status, "error");
  assert.equal(
    conflict.status === "error" ? conflict.error.code : undefined,
    "EDIT_CONFLICT",
  );
  assert.equal(await readFile(file, "utf8"), "x x");

  const replaceAll = await registry.execute("edit", {
    path: "file.txt",
    oldText: "x",
    newText: "y",
    replaceAll: true,
  });
  assert.equal(replaceAll.status, "success");
  assert.equal(await readFile(file, "utf8"), "y y");
});

test("edit reports missing matches without changing the file", async (t) => {
  const workspace = await createWorkspace(t);
  const file = join(workspace, "file.txt");
  await writeFile(file, "unchanged", "utf8");
  const registry = new ToolRegistry([await createEditTool(workspace)]);

  const result = await registry.execute("edit", {
    path: "file.txt",
    oldText: "missing",
    newText: "replacement",
  });
  assert.equal(result.status, "error");
  assert.equal(
    result.status === "error" ? result.error.code : undefined,
    "EDIT_CONFLICT",
  );
  assert.equal(await readFile(file, "utf8"), "unchanged");
});

test("all file tools reject lexical and symlink workspace escapes", async (t) => {
  const parent = await createWorkspace(t);
  const workspace = join(parent, "workspace");
  const outside = join(parent, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "secret", "utf8");
  await symlink(outside, join(workspace, "escape"));
  const registry = new ToolRegistry([
    await createReadTool(workspace),
    await createWriteTool(workspace),
    await createEditTool(workspace),
  ]);

  for (const [name, input] of [
    ["read", { path: "../outside/secret.txt" }],
    ["read", { path: join(outside, "secret.txt") }],
    ["read", { path: "escape/secret.txt" }],
    ["write", { path: "escape/new.txt", content: "bad" }],
    ["edit", { path: "escape/secret.txt", oldText: "secret", newText: "bad" }],
  ] as const) {
    const result = await registry.execute(name, input);
    assert.equal(result.status, "error", name);
    assert.equal(
      result.status === "error" ? result.error.code : undefined,
      "PATH_OUTSIDE_WORKSPACE",
      name,
    );
  }
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "secret");
});

test("full access file tools operate outside the workspace without grants", async (t) => {
  const parent = await createWorkspace(t);
  const workspace = join(parent, "workspace");
  const outside = join(parent, "outside.txt");
  await mkdir(workspace);
  await writeFile(outside, "before", "utf8");
  const registry = new ToolRegistry([
    await createReadTool(workspace, undefined, "full_access"),
    await createWriteTool(workspace, "full_access"),
    await createEditTool(workspace, "full_access"),
  ]);

  assert.equal((await registry.execute("read", { path: outside })).status, "success");
  assert.equal((await registry.execute("edit", {
    path: outside,
    oldText: "before",
    newText: "after",
  })).status, "success");
  assert.equal(await readFile(outside, "utf8"), "after");
  assert.equal((await registry.execute("write", {
    path: join(parent, "created.txt"),
    content: "created",
  })).status, "success");
});

test("read consumes one exact external-file grant bound to conversation and tool call", async (t) => {
  const parent = await createWorkspace(t);
  const workspace = join(parent, "workspace");
  const outside = join(parent, "outside.txt");
  await mkdir(workspace);
  await writeFile(outside, "external", "utf8");
  const canonicalOutside = await realpath(outside);
  const grants = new InMemoryWorkspaceGrantStore();
  const registry = new ToolRegistry([
    await createReadTool(workspace, grants),
  ]);
  const prepared = registry.prepare("read", { path: outside });
  assert.equal("type" in prepared, false);
  if ("type" in prepared) assert.fail("Expected a prepared read call.");
  const context = {
    conversationId: "conversation-1",
    toolCallId: "tool-call-1",
  };

  const requirement = await prepared.preflight(context);
  assert.deepEqual(requirement, {
    kind: "workspace_grant",
    reason: "outside_workspace",
    requestedPath: canonicalOutside,
    canonicalPath: canonicalOutside,
    access: "read",
    scope: "once",
  });
  grants.grantRead({
    conversationId: context.conversationId,
    toolCallId: context.toolCallId,
    canonicalPath: canonicalOutside,
  });
  assert.equal(await prepared.preflight(context), undefined);
  assert.equal((await prepared.execute(context)).status, "success");

  const secondAttempt = await prepared.execute(context);
  assert.equal(secondAttempt.status, "error");
  assert.equal(
    secondAttempt.status === "error" ? secondAttempt.error.code : undefined,
    "PATH_OUTSIDE_WORKSPACE",
  );
});

test("sensitive workspace files require one exact read grant and reject mutations", async (t) => {
  const workspace = await createWorkspace(t);
  const sensitivePath = join(workspace, ".env");
  await writeFile(sensitivePath, "API_KEY=do-not-leak\n", "utf8");
  await writeFile(join(workspace, ".env.example"), "API_KEY=\n", "utf8");
  const canonicalSensitivePath = await realpath(sensitivePath);
  const grants = new InMemoryWorkspaceGrantStore();
  const registry = new ToolRegistry([
    await createReadTool(workspace, grants),
    await createWriteTool(workspace),
    await createEditTool(workspace),
  ]);
  const context = {
    conversationId: "conversation-1",
    toolCallId: "tool-call-1",
  };
  const prepared = registry.prepare("read", { path: ".env" });
  if ("type" in prepared) assert.fail("Expected a prepared read call.");

  assert.deepEqual(await prepared.preflight(context), {
    kind: "workspace_grant",
    reason: "sensitive_workspace_file",
    requestedPath: canonicalSensitivePath,
    canonicalPath: canonicalSensitivePath,
    access: "read",
    scope: "once",
  });
  const denied = await prepared.execute(context);
  assert.equal(denied.status, "error");
  assert.deepEqual(
    denied.status === "error" ? denied.error : undefined,
    {
      code: "SENSITIVE_FILE_ACCESS_DENIED",
      message: "Sensitive workspace file access was not authorized.",
    },
  );
  assert.equal(JSON.stringify(denied).includes("do-not-leak"), false);

  grants.grantRead({
    conversationId: context.conversationId,
    toolCallId: context.toolCallId,
    canonicalPath: canonicalSensitivePath,
  });
  assert.equal((await prepared.execute(context)).status, "success");
  assert.equal((await prepared.execute(context)).status, "error");

  assert.equal(
    (await registry.execute("read", { path: ".env.example" })).status,
    "success",
  );
  for (const [name, input] of [
    ["write", { path: ".env", content: "changed" }],
    ["edit", { path: ".env", oldText: "API_KEY", newText: "TOKEN" }],
  ] as const) {
    const result = await registry.execute(name, input);
    assert.equal(result.status, "error");
    assert.equal(
      result.status === "error" ? result.error.code : undefined,
      "SENSITIVE_FILE_ACCESS_DENIED",
    );
  }
  assert.equal(await readFile(sensitivePath, "utf8"), "API_KEY=do-not-leak\n");
});

test("sensitive workspace reads cannot be bypassed by either symlink name", async (t) => {
  const workspace = await createWorkspace(t);
  await writeFile(join(workspace, ".env"), "secret", "utf8");
  await writeFile(join(workspace, "safe.txt"), "safe", "utf8");
  await symlink(".env", join(workspace, "safe-link"));
  await symlink("safe.txt", join(workspace, ".env.local"));
  const registry = new ToolRegistry([
    await createReadTool(workspace, new InMemoryWorkspaceGrantStore()),
  ]);
  const context = {
    conversationId: "conversation-1",
    toolCallId: "tool-call-1",
  };

  for (const requestedPath of ["safe-link", ".env.local"]) {
    const prepared = registry.prepare("read", { path: requestedPath });
    if ("type" in prepared) assert.fail("Expected a prepared read call.");
    assert.equal(
      (await prepared.preflight(context))?.reason,
      "sensitive_workspace_file",
    );
  }
});

test("external read grants do not cross conversation, tool call, or symlink target", async (t) => {
  const parent = await createWorkspace(t);
  const workspace = join(parent, "workspace");
  const first = join(parent, "first.txt");
  const second = join(parent, "second.txt");
  const link = join(workspace, "external-link.txt");
  await mkdir(workspace);
  await writeFile(first, "first", "utf8");
  await writeFile(second, "second", "utf8");
  await symlink(first, link);
  const canonicalFirst = await realpath(first);
  const canonicalSecond = await realpath(second);
  const grants = new InMemoryWorkspaceGrantStore();
  const registry = new ToolRegistry([
    await createReadTool(workspace, grants),
  ]);
  const prepared = registry.prepare("read", { path: link });
  if ("type" in prepared) assert.fail("Expected a prepared read call.");
  const context = {
    conversationId: "conversation-1",
    toolCallId: "tool-call-1",
  };
  const requirement = await prepared.preflight(context);
  assert.equal(requirement?.canonicalPath, canonicalFirst);
  grants.grantRead({
    conversationId: context.conversationId,
    toolCallId: context.toolCallId,
    canonicalPath: canonicalFirst,
  });

  assert.notEqual(
    await prepared.preflight({
      conversationId: "conversation-2",
      toolCallId: context.toolCallId,
    }),
    undefined,
  );
  assert.notEqual(
    await prepared.preflight({
      conversationId: context.conversationId,
      toolCallId: "tool-call-2",
    }),
    undefined,
  );

  await rm(link);
  await symlink(second, link);
  const retargeted = await prepared.preflight(context);
  assert.equal(retargeted?.canonicalPath, canonicalSecond);
});

test("missing external files remain controlled ToolResults instead of access requests", async (t) => {
  const parent = await createWorkspace(t);
  const workspace = join(parent, "workspace");
  await mkdir(workspace);
  const registry = new ToolRegistry([
    await createReadTool(workspace, new InMemoryWorkspaceGrantStore()),
  ]);
  const prepared = registry.prepare("read", {
    path: join(parent, "missing.txt"),
  });
  if ("type" in prepared) assert.fail("Expected a prepared read call.");
  const context = {
    conversationId: "conversation-1",
    toolCallId: "tool-call-1",
  };

  assert.equal(await prepared.preflight(context), undefined);
  const result = await prepared.execute(context);
  assert.equal(result.status, "error");
  assert.equal(
    result.status === "error" ? result.error.code : undefined,
    "FILE_NOT_FOUND",
  );
});
