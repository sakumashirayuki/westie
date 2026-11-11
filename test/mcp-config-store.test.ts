import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  userMcpConfigPath,
  writeUserMcpConfig,
  userMcpConfigStore,
} from "../src/infrastructure/mcp-config-store.js";
import { readUserMcpConfig } from "../src/infrastructure/workspace-mcp-config.js";
import type { McpServerDraft } from "../src/infrastructure/workspace-mcp-config.js";

const draft: McpServerDraft = {
  name: "github",
  config: {
    type: "stdio",
    command: "npx",
    args: ["-y", "server-github"],
    env: { TOKEN: "${GITHUB_TOKEN}" },
    timeoutMs: 60_000,
  },
};

async function home(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("writes a config atomically and reads it back", async (t) => {
  const homeDir = await home(t);
  await writeUserMcpConfig(homeDir, [draft]);

  const config = await readUserMcpConfig(homeDir, { GITHUB_TOKEN: "tok" });
  assert.equal(config.servers.length, 1);
  assert.equal(config.servers[0]!.name, "github");
  assert.equal(config.servers[0]!.config.env?.TOKEN, "tok");
});

test("creates the .agents directory when missing", async (t) => {
  const homeDir = await home(t);
  await writeUserMcpConfig(homeDir, []);
  const content = await readFile(join(homeDir, ".agents", "mcp.json"), "utf8");
  assert.deepEqual(JSON.parse(content), { servers: {} });
});

test("stable serialization: no empty fields, sorted names, trailing newline", async (t) => {
  const homeDir = await home(t);
  await writeUserMcpConfig(homeDir, [
    { name: "b", config: { type: "http", url: "https://b", timeoutMs: 1000 } },
    { name: "a", config: { type: "stdio", command: "x", timeoutMs: 1000 } },
  ]);
  const content = await readFile(userMcpConfigPath(homeDir), "utf8");
  assert.ok(content.endsWith("\n"));
  const parsed = JSON.parse(content);
  // 名字按字典序。
  assert.deepEqual(Object.keys(parsed.servers), ["a", "b"]);
  // http 无 command、stdio 无 url。
  assert.equal("url" in parsed.servers.a, false);
  assert.equal("command" in parsed.servers.b, false);
});

test("rejects writing when the target is a symlink", async (t) => {
  const homeDir = await home(t);
  await mkdir(join(homeDir, ".agents"), { recursive: true });
  const outside = await mkdtemp(join(tmpdir(), "mcp-store-out-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "target.json"), "{}");
  await symlink(join(outside, "target.json"), userMcpConfigPath(homeDir));

  await assert.rejects(writeUserMcpConfig(homeDir, [draft]), /symbolic link/);
});

test("rejects a config that would exceed 64 KiB", async (t) => {
  const homeDir = await home(t);
  const bigDraft: McpServerDraft = {
    name: "big",
    config: {
      type: "http",
      url: `https://x/${"a".repeat(70_000)}`,
      timeoutMs: 1000,
    },
  };
  await assert.rejects(writeUserMcpConfig(homeDir, [bigDraft]), /exceed/);
});

test("the default store writes to the home directory", async (t) => {
  const homeDir = await home(t);
  await userMcpConfigStore.write(homeDir, [draft]);
  const config = await userMcpConfigStore.read(homeDir);
  assert.equal(config.servers.length, 1);
  assert.equal(config.servers[0]!.name, "github");
  // 管理界面读取不展开 ${VAR}，否则明文会回到前端再被保存回文件。
  assert.equal(
    JSON.stringify(config.servers[0]!.config),
    JSON.stringify(draft.config),
  );
});
