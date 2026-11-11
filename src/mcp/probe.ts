import { homedir } from "node:os";

import { McpClient } from "./client.js";
import { HttpTransport } from "./http-transport.js";
import { StdioTransport } from "./stdio-transport.js";
import type { McpRemoteTool, McpTransport } from "./types.js";
import { resolveUserMcpCwd } from "../infrastructure/workspace-mcp-config.js";
import type { WorkspaceMcpServerConfig } from "../infrastructure/workspace-mcp-config.js";

export type McpProbeResult =
  | { readonly ok: true; readonly tools: readonly McpRemoteTool[] }
  | { readonly ok: false; readonly message: string };

/**
 * 「测试连接」用的一次性探测：对单个用户级 Server 配置起传输 → initialize →
 * tools/list → 关闭，不复用 McpServerPool。stdio 的 cwd 相对 `~` 解析（用户级
 * Server 不属于任何 workspace）。
 */
export async function probeMcpServer(
  config: WorkspaceMcpServerConfig,
  options: {
    readonly homeDir?: string;
    readonly createTransport?: (
      config: WorkspaceMcpServerConfig,
    ) => McpTransport;
  } = {},
): Promise<McpProbeResult> {
  const home = options.homeDir ?? homedir();
  const transport = options.createTransport === undefined
    ? createProbeTransport(home, config)
    : options.createTransport(config);
  const client = new McpClient(transport);
  try {
    await client.connect();
    const tools = await client.listTools();
    return { ok: true, tools };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  } finally {
    await client.close().catch(() => {});
  }
}

function createProbeTransport(
  homeDir: string,
  config: WorkspaceMcpServerConfig,
): McpTransport {
  if (config.type === "stdio") {
    return new StdioTransport({
      command: config.command!,
      ...(config.args === undefined ? {} : { args: config.args }),
      ...(config.env === undefined ? {} : { env: config.env }),
      cwd: resolveUserMcpCwd(homeDir, config.cwd),
    });
  }
  return new HttpTransport({
    url: config.url!,
    ...(config.headers === undefined ? {} : { headers: config.headers }),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
