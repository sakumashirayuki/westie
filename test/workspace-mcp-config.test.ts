import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  expandVariables,
  loadMcpConfig,
  mergeMcpConfigs,
  readUserMcpConfig,
  readWorkspaceMcpConfig,
  resolveMcpCwd,
} from "../src/infrastructure/workspace-mcp-config.js";

async function workspace(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mcp-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".agents"), { recursive: true });
  return root;
}

async function writeConfig(root: string, content: string): Promise<void> {
  await writeFile(join(root, ".agents", "mcp.json"), content);
}

test("reads a valid stdio and http config and expands ${VAR}", async (t) => {
  const root = await workspace(t);
  await writeConfig(
    root,
    JSON.stringify({
      servers: {
        github: {
          type: "stdio",
          command: "npx",
          args: ["-y", "server-github"],
          env: { TOKEN: "${GH_TOKEN}" },
        },
        docs: {
          type: "http",
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer ${DOCS_TOKEN}" },
          timeoutMs: 123,
        },
      },
    }),
  );

  const config = await readWorkspaceMcpConfig(root, {
    GH_TOKEN: "secret-gh",
    DOCS_TOKEN: "secret-docs",
  });
  assert.equal(config.diagnostics.length, 0);
  assert.deepEqual(
    config.servers.map((s) => s.name),
    ["docs", "github"],
  );
  const github = config.servers.find((s) => s.name === "github")!;
  assert.equal(github.config.type, "stdio");
  assert.equal(github.config.env?.TOKEN, "secret-gh");
  const docs = config.servers.find((s) => s.name === "docs")!;
  assert.equal(docs.config.timeoutMs, 123);
  assert.equal(docs.config.headers?.Authorization, "Bearer secret-docs");
});

test("missing ${VAR} skips the server with a diagnostic", async (t) => {
  const root = await workspace(t);
  await writeConfig(
    root,
    JSON.stringify({
      servers: {
        broken: { type: "stdio", command: "npx", env: { X: "${MISSING_VAR}" } },
        ok: { type: "http", url: "https://example.com/mcp" },
      },
    }),
  );
  const config = await readWorkspaceMcpConfig(root, {});
  assert.deepEqual(config.servers.map((s) => s.name), ["ok"]);
  assert.equal(config.diagnostics.length, 1);
  assert.equal(config.diagnostics[0]?.code, "INVALID_MCP_CONFIG");
  assert.equal(config.diagnostics[0]?.server, "broken");
  // 明文 token 不应出现在诊断里。
  assert.ok(!JSON.stringify(config.diagnostics).includes("MISSING_VAR"));
});

test("invalid server name is skipped with a diagnostic", async (t) => {
  const root = await workspace(t);
  await writeConfig(
    root,
    JSON.stringify({
      servers: { "Bad Name": { type: "http", url: "https://x/mcp" } },
    }),
  );
  const config = await readWorkspaceMcpConfig(root, {});
  assert.equal(config.servers.length, 0);
  assert.equal(config.diagnostics[0]?.code, "INVALID_MCP_CONFIG");
});

test("a wholly invalid file produces INVALID_MCP_CONFIG and empty servers", async (t) => {
  const root = await workspace(t);
  await writeConfig(root, "not json {");
  const config = await readWorkspaceMcpConfig(root, {});
  assert.equal(config.servers.length, 0);
  assert.equal(config.diagnostics[0]?.code, "INVALID_MCP_CONFIG");
});

test("missing file means no servers and no diagnostics", async (t) => {
  const root = await workspace(t);
  const config = await readWorkspaceMcpConfig(root, {});
  assert.deepEqual(config, { servers: [], diagnostics: [] });
});

test("rejects a config over 64 KiB", async (t) => {
  const root = await workspace(t);
  const big = JSON.stringify({
    servers: { big: { type: "http", url: `https://x/${"a".repeat(70_000)}` } },
  });
  await writeConfig(root, big);
  const config = await readWorkspaceMcpConfig(root, {});
  assert.equal(config.servers.length, 0);
  assert.equal(config.diagnostics[0]?.code, "INVALID_MCP_CONFIG");
});

test("cwd escapes are rejected by resolveMcpCwd, including symlinks", async (t) => {
  const root = await realpath(await workspace(t));
  await mkdir(join(root, "sub"));
  const outside = await realpath(await mkdtemp(join(tmpdir(), "mcp-outside-")));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, "escape"));

  assert.equal(resolveMcpCwd(root, undefined), root);
  assert.equal(resolveMcpCwd(root, "sub"), join(root, "sub"));
  assert.throws(() => resolveMcpCwd(root, "../outside"), /remain inside/);
  // 字面路径在 workspace 内，realpath 却指向外面。
  assert.throws(() => resolveMcpCwd(root, "escape"), /remain inside/);
  assert.throws(() => resolveMcpCwd(root, "missing"), /does not exist/);
});

test("symlinked config is rejected", async (t) => {
  const root = await workspace(t);
  const target = join(root, "real.json");
  await writeFile(target, JSON.stringify({ servers: {} }));
  await symlink(target, join(root, ".agents", "mcp.json"));
  const config = await readWorkspaceMcpConfig(root, {});
  assert.equal(config.servers.length, 0);
  assert.equal(config.diagnostics[0]?.code, "INVALID_MCP_CONFIG");
});

test("expandVariables returns undefined when any variable is missing", () => {
  assert.equal(
    expandVariables({ A: "x", B: "${MISSING}" }, { A: "1" }),
    undefined,
  );
  assert.deepEqual(
    expandVariables({ A: "${A}", B: "plain" }, { A: "1" }),
    { A: "1", B: "plain" },
  );
});

async function home(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-home-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".agents"), { recursive: true });
  return dir;
}

test("loadMcpConfig merges user and workspace configs, workspace wins on a name", async (t) => {
  const root = await workspace(t);
  const homeDir = await home(t);
  await writeFile(
    join(homeDir, ".agents", "mcp.json"),
    JSON.stringify({
      servers: {
        playwright: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp"] },
        shared: { type: "http", url: "https://user.example/mcp" },
      },
    }),
  );
  await writeConfig(
    root,
    JSON.stringify({
      servers: {
        github: { type: "stdio", command: "npx" },
        shared: { type: "http", url: "https://workspace.example/mcp" },
      },
    }),
  );

  const config = await loadMcpConfig({ workspaceRoot: root, homeDir, env: {} });
  assert.equal(config.diagnostics.length, 0);
  assert.deepEqual(
    config.servers.map((s) => s.name),
    ["github", "playwright", "shared"],
  );
  const shared = config.servers.find((s) => s.name === "shared")!;
  assert.equal(shared.config.url, "https://workspace.example/mcp");
  assert.equal(shared.source, "workspace");
  assert.equal(config.servers.find((s) => s.name === "playwright")?.source, "user");
});

test("an invalid user config does not hide a valid workspace config", async (t) => {
  const root = await workspace(t);
  const homeDir = await home(t);
  await writeFile(join(homeDir, ".agents", "mcp.json"), "not json {");
  await writeConfig(
    root,
    JSON.stringify({ servers: { ok: { type: "http", url: "https://x/mcp" } } }),
  );

  const config = await loadMcpConfig({ workspaceRoot: root, homeDir, env: {} });
  assert.deepEqual(config.servers.map((s) => s.name), ["ok"]);
  assert.equal(config.diagnostics.length, 1);
  assert.equal(config.diagnostics[0]?.code, "INVALID_MCP_CONFIG");
  assert.ok(config.diagnostics[0]!.path.startsWith(homeDir));
});

test("a missing user config contributes nothing", async (t) => {
  const root = await workspace(t);
  const homeDir = await mkdtemp(join(tmpdir(), "mcp-home-empty-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const config = await loadMcpConfig({ workspaceRoot: root, homeDir, env: {} });
  assert.deepEqual(config, { servers: [], diagnostics: [] });
  assert.deepEqual(await readUserMcpConfig(homeDir, {}), { servers: [], diagnostics: [] });
});

test("user config must stay inside the home directory", async (t) => {
  const homeDir = await home(t);
  const outside = await mkdtemp(join(tmpdir(), "mcp-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(
    join(outside, "mcp.json"),
    JSON.stringify({ servers: { x: { type: "http", url: "https://x/mcp" } } }),
  );
  await symlink(join(outside, "mcp.json"), join(homeDir, ".agents", "mcp.json"));
  const config = await readUserMcpConfig(homeDir, {});
  assert.equal(config.servers.length, 0);
  assert.equal(config.diagnostics[0]?.code, "INVALID_MCP_CONFIG");
});

test("mergeMcpConfigs keeps diagnostics from both sides in order", () => {
  const merged = mergeMcpConfigs(
    {
      servers: [{ name: "a", source: "user", config: { type: "http", url: "https://a", timeoutMs: 1 } }],
      diagnostics: [{ code: "INVALID_MCP_CONFIG", path: "/home/x", message: "user" }],
    },
    {
      servers: [{ name: "a", source: "workspace", config: { type: "http", url: "https://b", timeoutMs: 2 } }],
      diagnostics: [{ code: "INVALID_MCP_CONFIG", path: "/ws/x", message: "workspace" }],
    },
  );
  assert.equal(merged.servers.length, 1);
  assert.equal(merged.servers[0]!.config.url, "https://b");
  assert.deepEqual(merged.diagnostics.map((d) => d.message), ["user", "workspace"]);
});
