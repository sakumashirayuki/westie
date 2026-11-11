import { promises as fs } from "node:fs";
import { join, relative, sep, isAbsolute } from "node:path";

import {
  MAX_MCP_CONFIG_BYTES,
  readUserMcpConfig,
  serializeMcpConfig,
  type McpServerDraft,
  type WorkspaceMcpServerConfig,
} from "./workspace-mcp-config.js";

/**
 * 用户级 `~/.agents/mcp.json` 的读写门面。读复用 workspace-mcp-config 的规则
 * （严格 UTF-8、64 KiB、拒绝符号链接），写用「临时文件 + rename」原子替换，
 * 避免进程读到半截 JSON。职责单一：只负责文件定位、边界与原子写，不做校验
 * （校验由调用方的 schema 与 expandVariables 完成）。
 */
export interface UserMcpConfigStore {
  /**
   * 读用户级配置（`<homeDir>/.agents/mcp.json`）供管理界面使用：`${VAR}` 保持原串，
   * 不展开、不因变量缺失而跳过 Server。文件缺失等同无 Server。
   */
  read(homeDir: string): ReturnType<typeof readUserMcpConfig>;
  /** 原子写回用户级配置，覆盖整份 servers。 */
  write(homeDir: string, servers: readonly McpServerDraft[]): Promise<void>;
}

export const userMcpConfigStore: UserMcpConfigStore = {
  read: (homeDir) => readUserMcpConfig(homeDir, {}, { expand: false }),
  write: (homeDir, servers) => writeUserMcpConfig(homeDir, servers),
};

export const userMcpConfigPath = (homeDir: string): string =>
  join(homeDir, ".agents", "mcp.json");

/**
 * 原子写回。写入前拒绝 `.agents/mcp.json` 是符号链接；`.agents` 缺失则创建；
 * 内容写入临时文件后 rename 到目标，随后读回一次做 UTF-8 校验闭环。
 */
export async function writeUserMcpConfig(
  homeDir: string,
  servers: readonly McpServerDraft[],
): Promise<void> {
  const agentsDir = join(homeDir, ".agents");
  const configPath = join(agentsDir, "mcp.json");
  const content = serializeMcpConfig(servers);

  if (Buffer.byteLength(content, "utf8") > MAX_MCP_CONFIG_BYTES) {
    throw new Error(`mcp.json would exceed ${MAX_MCP_CONFIG_BYTES} bytes.`);
  }

  // 拒绝符号链接目标；不存在的文件进入正常写入路径。
  try {
    const lstatResult = await fs.lstat(configPath);
    if (lstatResult.isSymbolicLink()) {
      throw new Error(`mcp.json must not be a symbolic link: ${configPath}`);
    }
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }

  await fs.mkdir(agentsDir, { recursive: true });

  // 边界：`.agents` 必须仍留在 home 内（realpath 后确认）。
  const resolvedHome = await fs.realpath(homeDir);
  const resolvedAgents = await fs.realpath(agentsDir);
  if (!isWithin(resolvedHome, resolvedAgents)) {
    throw new Error(`.agents must remain inside the home directory: ${agentsDir}`);
  }

  const tempPath = join(agentsDir, `.mcp.json.tmp-${process.pid}-${Date.now()}`);
  try {
    // "wx"：临时文件名撞车时失败而不是覆写；0o600：配置里可能引用凭据变量。
    await fs.writeFile(tempPath, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(tempPath, configPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }

  // 读回校验闭环：能被正常读回才算写成功。
  await readUserMcpConfig(homeDir, {}, { expand: false });
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot));
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "ENOENT"
  );
}
