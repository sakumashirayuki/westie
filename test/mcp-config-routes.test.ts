import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { McpConfigRoutes } from "../src/http/mcp-config-routes.js";
import { readUserMcpConfig } from "../src/infrastructure/workspace-mcp-config.js";
import type { WorkspaceMcpServerConfig } from "../src/infrastructure/workspace-mcp-config.js";
import type { McpProbeResult } from "../src/mcp/probe.js";

interface TestServer extends AsyncDisposable {
  readonly origin: string;
}

/** 进程内 HTTP 假 Server；`await using` 离开作用域即关闭监听。 */
async function startServer(routes: McpConfigRoutes): Promise<TestServer> {
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const route =
      pathname === "/v1/agent/mcp-config:probe"
        ? () => routes.probeServer(req, res)
        : req.method === "PUT"
        ? () => routes.saveConfig(req, res)
        : () => routes.getConfig(req, res);
    route().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    [Symbol.asyncDispose]: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function home(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-routes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeRoutes(
  homeDir: string,
  overrides: Partial<{
    allowedOrigin: string;
    fullAccessAvailable: boolean;
    probe: (config: WorkspaceMcpServerConfig) => Promise<McpProbeResult>;
  }> = {},
): McpConfigRoutes {
  return new McpConfigRoutes({
    homeDir,
    allowedOrigin: overrides.allowedOrigin,
    fullAccessAvailable: overrides.fullAccessAvailable ?? true,
    ...(overrides.probe === undefined ? {} : { probe: overrides.probe }),
  });
}

test("GET and PUT round-trip the user config", async (t) => {
  const homeDir = await home(t);
  await mkdir(join(homeDir, ".agents"), { recursive: true });
  await writeFile(
    join(homeDir, ".agents", "mcp.json"),
    JSON.stringify({ servers: { github: { type: "stdio", command: "npx" } } }),
  );
  await using server = await startServer(makeRoutes(homeDir));
  const origin = server.origin;
  const getRes = await fetch(`${origin}/v1/agent/mcp-config`);
  assert.equal(getRes.status, 200);
  const getBody = await getRes.json() as { servers: Array<{ name: string }> };
  assert.deepEqual(getBody.servers.map((s) => s.name), ["github"]);

  const putRes = await fetch(`${origin}/v1/agent/mcp-config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      servers: {
        github: { type: "stdio", command: "npx" },
        docs: { type: "http", url: "https://docs.example/mcp" },
      },
    }),
  });
  assert.equal(putRes.status, 200);
  const putBody = await putRes.json() as { servers: Array<{ name: string }> };
  assert.deepEqual(
    putBody.servers.map((s) => s.name),
    ["docs", "github"],
  );

  const config = await readUserMcpConfig(homeDir, {});
  assert.deepEqual(config.servers.map((s) => s.name), ["docs", "github"]);
});

test("PUT rejects invalid config with 422 and missing ${VAR} with 422", async (t) => {
  const homeDir = await home(t);
  await using server = await startServer(makeRoutes(homeDir));
  const origin = server.origin;
  const badName = await fetch(`${origin}/v1/agent/mcp-config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ servers: { "Bad Name": { type: "http", url: "https://x" } } }),
  });
  assert.equal(badName.status, 422);
  const badNameBody = await badName.json() as { error: { code: string } };
  assert.equal(badNameBody.error.code, "INVALID_MCP_CONFIG");

  const missingVar = await fetch(`${origin}/v1/agent/mcp-config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ servers: { x: { type: "stdio", command: "npx", env: { K: "${MISSING}" } } } }),
  });
  assert.equal(missingVar.status, 422);
});

test("untrusted origin is rejected with 403", async (t) => {
  const homeDir = await home(t);
  await using server = await startServer(
    makeRoutes(homeDir, { allowedOrigin: "http://127.0.0.1:9999" }),
  );
  const origin = server.origin;
  const res = await fetch(`${origin}/v1/agent/mcp-config`, {
    headers: { origin: "http://evil.example" },
  });
  assert.equal(res.status, 403);

  const putRes = await fetch(`${origin}/v1/agent/mcp-config`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: "http://evil.example" },
    body: JSON.stringify({ servers: {} }),
  });
  assert.equal(putRes.status, 403);
});

test("probe endpoint returns the probe result", async (t) => {
  const homeDir = await home(t);
  await using server = await startServer(
    makeRoutes(homeDir, {
      probe: async () => ({ ok: true, tools: [] }),
    }),
  );
  const origin = server.origin;
  const res = await fetch(`${origin}/v1/agent/mcp-config:probe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "x", config: { type: "http", url: "https://x" } }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, tools: [] });
});

test("GET returns ${VAR} references verbatim instead of the expanded secret", async (t) => {
  const homeDir = await home(t);
  await mkdir(join(homeDir, ".agents"), { recursive: true });
  await writeFile(
    join(homeDir, ".agents", "mcp.json"),
    JSON.stringify({
      servers: {
        github: { type: "stdio", command: "npx", env: { TOKEN: "${GITHUB_TOKEN}" } },
      },
    }),
  );
  await using server = await startServer(
    new McpConfigRoutes({
      homeDir,
      env: { GITHUB_TOKEN: "super-secret-token" },
      fullAccessAvailable: true,
    }),
  );
  const res = await fetch(`${server.origin}/v1/agent/mcp-config`);
  const text = await res.text();
  assert.ok(text.includes("${GITHUB_TOKEN}"));
  assert.ok(!text.includes("super-secret-token"));
});

test("probe receives expanded env while the saved config keeps ${VAR}", async (t) => {
  const homeDir = await home(t);
  let probed: WorkspaceMcpServerConfig | undefined;
  await using server = await startServer(
    new McpConfigRoutes({
      homeDir,
      env: { GITHUB_TOKEN: "super-secret-token" },
      fullAccessAvailable: true,
      probe: async (config) => {
        probed = config;
        return { ok: true, tools: [] };
      },
    }),
  );
  const res = await fetch(`${server.origin}/v1/agent/mcp-config:probe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "github",
      config: { type: "stdio", command: "npx", env: { TOKEN: "${GITHUB_TOKEN}" } },
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(probed?.env?.TOKEN, "super-secret-token");
});
