import { createHash } from "node:crypto";
import { homedir } from "node:os";

import { MAX_MCP_TOOLS_PER_SERVER } from "./constants.js";
import { McpClient } from "./client.js";
import type { McpTransport } from "./types.js";
import { HttpTransport } from "./http-transport.js";
import { StdioTransport } from "./stdio-transport.js";
import {
  resolveMcpCwd,
  resolveUserMcpCwd,
} from "../infrastructure/workspace-mcp-config.js";
import type {
  McpConfigSource,
  WorkspaceMcpConfig,
  WorkspaceMcpDiagnostic,
  WorkspaceMcpServerConfig,
} from "../infrastructure/workspace-mcp-config.js";
import type { McpRemoteTool } from "./types.js";

export interface McpToolSource {
  readonly server: string;
  readonly tool: McpRemoteTool;
  readonly client: McpClient;
  readonly timeoutMs: number;
}

export interface McpAcquireResult {
  readonly sources: readonly McpToolSource[];
  readonly diagnostics: readonly WorkspaceMcpDiagnostic[];
}

export interface McpTransportTarget {
  readonly workspaceRoot: string;
  /** 用户级 Server 的 cwd 基准。 */
  readonly homeDir: string;
  readonly name: string;
  readonly source: McpConfigSource;
  readonly config: WorkspaceMcpServerConfig;
}

/** 按 Server 配置构造传输；测试注入假传输用。 */
export type McpTransportFactory = (target: McpTransportTarget) => McpTransport;

export interface McpServerPoolOptions {
  readonly createTransport?: McpTransportFactory;
  /** 缺省 os.homedir()；测试可指向临时目录。 */
  readonly homeDir?: string;
}

interface PooledConnection {
  readonly server: string;
  readonly configHash: string;
  readonly client: McpClient;
  readonly tools: readonly McpRemoteTool[];
  readonly diagnostics: readonly WorkspaceMcpDiagnostic[];
}

/**
 * 进程级连接池：按 workspace+server 复用连接。配置哈希相同、连接还活着、没标脏
 * 时直接复用缓存工具列表；否则重连重拉。单个 Server 失败只产生诊断，不影响其他。
 * 同一 Server 的并发 acquire 共享一次连接尝试，不会各起一个进程。
 */
export class McpServerPool {
  readonly #connections = new Map<string, PooledConnection>();
  readonly #connecting = new Map<
    string,
    { readonly configHash: string; readonly promise: Promise<PooledConnection> }
  >();
  readonly #createTransport: McpTransportFactory;
  readonly #homeDir: string;

  constructor(options: McpServerPoolOptions = {}) {
    this.#createTransport = options.createTransport ?? createDefaultTransport;
    this.#homeDir = options.homeDir ?? homedir();
  }

  async acquire(
    workspaceRoot: string,
    config: WorkspaceMcpConfig,
  ): Promise<McpAcquireResult> {
    const sources: McpToolSource[] = [];
    const diagnostics: WorkspaceMcpDiagnostic[] = [
      ...config.diagnostics,
    ];

    await Promise.all(
      config.servers.map(async ({ name, config: serverConfig, source }) => {
        const key = poolKey(workspaceRoot, name);
        const configHash = hashConfig(serverConfig, source);
        try {
          const connection = await this.#obtain(
            key,
            { workspaceRoot, homeDir: this.#homeDir, name, source, config: serverConfig },
            configHash,
          );
          diagnostics.push(...connection.diagnostics);
          for (const tool of connection.tools) {
            sources.push({
              server: name,
              tool,
              client: connection.client,
              timeoutMs: serverConfig.timeoutMs,
            });
          }
        } catch (error) {
          diagnostics.push({
            code: "MCP_SERVER_UNAVAILABLE",
            server: name,
            path: `.agents/mcp.json`,
            message: errorMessage(error),
          });
        }
      }),
    );

    return { sources, diagnostics };
  }

  /** 支持 `await using pool = new McpServerPool()`：离开作用域即 close()。 */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async close(): Promise<void> {
    // 正在连接的先等它落定再一起关，避免 close 之后又冒出一个活连接。
    await Promise.all(
      [...this.#connecting.values()].map((pending) =>
        pending.promise.catch(() => {})
      ),
    );
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    await Promise.all(
      connections.map((connection) => connection.client.close().catch(() => {})),
    );
  }

  /** 复用活连接，或加入正在进行的连接尝试，或发起一次新的连接。 */
  async #obtain(
    key: string,
    target: McpTransportTarget,
    configHash: string,
  ): Promise<PooledConnection> {
    const existing = this.#connections.get(key);
    if (
      existing !== undefined &&
      existing.configHash === configHash &&
      !existing.client.closed &&
      !existing.client.toolsDirty
    ) {
      return existing;
    }

    const inFlight = this.#connecting.get(key);
    if (inFlight !== undefined) {
      if (inFlight.configHash === configHash) return inFlight.promise;
      // 有人正用另一套配置在连。等它落定（成败都无所谓，那是它那套配置的事），
      // 再重新走一遍判断：它成功了就会被当作哈希不同的旧连接换掉，失败了就直接建。
      try {
        await inFlight.promise;
      } catch {
        // 忽略。
      }
      return this.#obtain(key, target, configHash);
    }

    const attempt = (async () => {
      if (existing !== undefined) {
        this.#connections.delete(key);
        await existing.client.close().catch(() => {});
      }
      const connection = await this.#connect(target, configHash);
      this.#connections.set(key, connection);
      return connection;
    })();
    const entry = { configHash, promise: attempt };
    this.#connecting.set(key, entry);
    return attempt.finally(() => {
      if (this.#connecting.get(key) === entry) this.#connecting.delete(key);
    });
  }

  /** 连接并拉工具列表。任何一步失败都关掉传输，不留子进程。 */
  async #connect(
    target: McpTransportTarget,
    configHash: string,
  ): Promise<PooledConnection> {
    const { name } = target;
    const client = new McpClient(this.#createTransport(target));
    try {
      await client.connect();
      const listed = await client.listTools();
      const diagnostics: WorkspaceMcpDiagnostic[] = [];
      let tools = listed;
      if (listed.length > MAX_MCP_TOOLS_PER_SERVER) {
        diagnostics.push({
          code: "MCP_TOOLS_TRUNCATED",
          server: name,
          path: `.agents/mcp.json`,
          message:
            `MCP server ${name} exposed ${listed.length} tools; truncated to ${MAX_MCP_TOOLS_PER_SERVER}.`,
        });
        tools = listed.slice(0, MAX_MCP_TOOLS_PER_SERVER);
      }
      return { server: name, configHash, client, tools, diagnostics };
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }
}

function createDefaultTransport(target: McpTransportTarget): McpTransport {
  const { config } = target;
  return config.type === "stdio"
    ? new StdioTransport({
        command: config.command!,
        ...(config.args === undefined ? {} : { args: config.args }),
        ...(config.env === undefined ? {} : { env: config.env }),
        cwd: target.source === "user"
          ? resolveUserMcpCwd(target.homeDir, config.cwd)
          : resolveMcpCwd(target.workspaceRoot, config.cwd),
      })
    : new HttpTransport({
        url: config.url!,
        ...(config.headers === undefined ? {} : { headers: config.headers }),
      });
}

function poolKey(workspaceRoot: string, name: string): string {
  return `${workspaceRoot}\n${name}`;
}

function hashConfig(
  config: WorkspaceMcpServerConfig,
  source: McpConfigSource,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ source, config }))
    .digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
