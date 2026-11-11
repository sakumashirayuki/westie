// 「读配置 → 连接 → 包成 Tool」这一整段在 CLI 与 HTTP 服务里各要一次，收在这里。
// MCP 是附加能力：任何一步意外抛错都只打一条诊断并返回空列表，不让主流程失败。

import type { Tool } from "../tools.js";
import { createMcpTools } from "../tools/mcp-tool.js";
import {
  loadMcpConfig,
  reportWorkspaceMcpDiagnostics,
} from "../infrastructure/workspace-mcp-config.js";
import type { McpServerPool } from "./server-pool.js";

export interface AcquireMcpToolSetOptions {
  /** 用户级配置所在的主目录；缺省 os.homedir()，测试可指向临时目录。 */
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** 诊断出口；缺省打 stderr JSON 行。 */
  readonly report?: typeof reportWorkspaceMcpDiagnostics;
}

/** 本 workspace 当前可用的 MCP 工具，名字互不重复。没有配置或全部失败时为空数组。 */
export async function acquireMcpToolSet(
  pool: McpServerPool,
  workspaceRoot: string,
  options: AcquireMcpToolSetOptions = {},
): Promise<readonly Tool[]> {
  const report = options.report ?? reportWorkspaceMcpDiagnostics;
  try {
    const config = await loadMcpConfig({
      workspaceRoot,
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    report(config.diagnostics);
    const acquired = await pool.acquire(workspaceRoot, config);
    report(acquired.diagnostics);
    const toolSet = createMcpTools(acquired.sources);
    report(toolSet.diagnostics);
    return toolSet.tools;
  } catch (error) {
    report([{
      code: "MCP_SERVER_UNAVAILABLE",
      path: ".agents/mcp.json",
      message: `MCP tools are unavailable for this run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }]);
    return [];
  }
}
