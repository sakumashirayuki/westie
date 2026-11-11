import { constants, promises as fs, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep, isAbsolute } from "node:path";

import { z } from "zod";

import {
  DEFAULT_MCP_CALL_TIMEOUT_MS,
  MAX_MCP_CALL_TIMEOUT_MS,
} from "../mcp/constants.js";
import { readFilePrefix } from "./read-file-prefix.js";

export const MAX_MCP_CONFIG_BYTES = 64 * 1024;

const SERVER_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 一个校验通过、但尚未展开 ${VAR} 的 Server 配置。 */
export interface WorkspaceMcpServerConfig {
  readonly type: "stdio" | "http";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly timeoutMs: number;
}

/** 管理界面 / 写入端点提交的一条 Server，落盘前的原始形态。 */
export interface McpServerDraft {
  readonly name: string;
  readonly config: WorkspaceMcpServerConfig;
}

/**
 * 把一组 draft 序列化成 `mcp.json` 的稳定文本（JSON key 顺序稳定、无空字段），
 * 用于写回用户级配置。这里的 config 已经是校验 + 展开后的形态，`${VAR}` 原串
 * 保存在 `env` / `headers` 里，展开只在读取阶段发生，不写明文。
 */
export function serializeMcpConfig(
  servers: readonly McpServerDraft[],
): string {
  const body: Record<string, unknown> = {};
  for (const server of [...servers].sort((l, r) =>
    l.name < r.name ? -1 : l.name > r.name ? 1 : 0
  )) {
    body[server.name] = serializeServerConfig(server.config);
  }
  return `${JSON.stringify({ servers: body }, null, 2)}\n`;
}

function serializeServerConfig(
  config: WorkspaceMcpServerConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = { type: config.type };
  if (config.type === "stdio") {
    out.command = config.command ?? "";
    if (config.args !== undefined && config.args.length > 0) {
      out.args = config.args;
    }
    if (config.cwd !== undefined && config.cwd !== "") out.cwd = config.cwd;
  } else {
    out.url = config.url ?? "";
  }
  if (config.env !== undefined && Object.keys(config.env).length > 0) {
    out.env = config.env;
  }
  if (config.headers !== undefined && Object.keys(config.headers).length > 0) {
    out.headers = config.headers;
  }
  out.timeoutMs = config.timeoutMs;
  return out;
}

/** 诊断，与 WorkspaceSkillDiagnostic 同形，走同一种 stderr JSON 行。 */
export interface WorkspaceMcpDiagnostic {
  readonly code:
    | "INVALID_MCP_CONFIG"
    | "MCP_SERVER_UNAVAILABLE"
    | "MCP_TOOLS_TRUNCATED"
    | "MCP_TOOL_SKIPPED";
  readonly server?: string;
  readonly path: string;
  readonly message: string;
}

/** 配置来源：用户级 `~/.agents/mcp.json` 或 workspace 级 `.agents/mcp.json`。 */
export type McpConfigSource = "user" | "workspace";

export interface WorkspaceMcpConfig {
  readonly servers: readonly {
    readonly name: string;
    readonly config: WorkspaceMcpServerConfig;
    /** 决定 stdio `cwd` 的基准：用户级相对主目录，workspace 级相对 workspace。 */
    readonly source: McpConfigSource;
  }[];
  readonly diagnostics: readonly WorkspaceMcpDiagnostic[];
}

export function reportWorkspaceMcpDiagnostics(
  diagnostics: readonly WorkspaceMcpDiagnostic[],
): void {
  for (const diagnostic of diagnostics) {
    process.stderr.write(`${JSON.stringify({
      event: "workspace_mcp_diagnostic",
      ...diagnostic,
    })}\n`);
  }
}

const serverConfigSchema = z.strictObject({
  type: z.enum(["stdio", "http"]),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().max(MAX_MCP_CALL_TIMEOUT_MS).optional(),
});

const configFileSchema = z.strictObject({
  servers: z.record(z.string(), serverConfigSchema),
});

export interface LoadMcpConfigOptions {
  readonly workspaceRoot: string;
  /** 用户级配置所在的主目录；缺省 os.homedir()，测试可指向临时目录。 */
  readonly homeDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * 读取用户级 `~/.agents/mcp.json` 与 workspace 级 `<workspace>/.agents/mcp.json`，
 * 按 Server 名合并，同名以 workspace 为准。两份各自独立校验，一份非法不影响另一份；
 * 诊断合并输出，`path` 字段区分来源。
 */
export async function loadMcpConfig(
  options: LoadMcpConfigOptions,
): Promise<WorkspaceMcpConfig> {
  const env = options.env ?? process.env;
  const [user, workspace] = await Promise.all([
    readUserMcpConfig(options.homeDir ?? homedir(), env),
    readWorkspaceMcpConfig(options.workspaceRoot, env),
  ]);
  return mergeMcpConfigs(user, workspace);
}

/** 后者同名覆盖前者；结果仍按名字排序。 */
export function mergeMcpConfigs(
  base: WorkspaceMcpConfig,
  override: WorkspaceMcpConfig,
): WorkspaceMcpConfig {
  const byName = new Map(base.servers.map((server) => [server.name, server]));
  for (const server of override.servers) byName.set(server.name, server);
  const servers = [...byName.values()].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  );
  return {
    servers,
    diagnostics: [...base.diagnostics, ...override.diagnostics],
  };
}

/** 用户级配置：`<homeDir>/.agents/mcp.json`，边界检查以主目录为根。 */
export interface ReadMcpConfigOptions {
  /**
   * 是否把 `env` / `headers` 里的 `${VAR}` 展开成真实值。运行时读取要展开；
   * 管理界面读取必须传 false，否则明文会经接口回到前端、再被保存回文件。
   */
  readonly expand?: boolean;
}

export function readUserMcpConfig(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
  options: ReadMcpConfigOptions = {},
): Promise<WorkspaceMcpConfig> {
  return readMcpConfigAt(
    join(homeDir, ".agents", "mcp.json"),
    homeDir,
    env,
    "user",
    options,
  );
}

/**
 * 读取并校验 workspace 的 `.agents/mcp.json`。文件规则同 AGENTS.md：普通文件、
 * 拒绝符号链接、上限 64 KiB、严格 UTF-8；缺失等同没有 Server。整个文件非法时
 * 返回空配置并报 `INVALID_MCP_CONFIG`；单个 Server 非法只跳过它。
 *
 * `env` / `headers` 里的 `${VAR}` 从这里展开（从 process.env），因此调用方需要
 * 传展开函数以便测试。展开结果不回文件、不进 transcript、不进诊断。
 */
export function readWorkspaceMcpConfig(
  canonicalWorkspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkspaceMcpConfig> {
  return readMcpConfigAt(
    join(canonicalWorkspaceRoot, ".agents", "mcp.json"),
    canonicalWorkspaceRoot,
    env,
    "workspace",
  );
}

async function readMcpConfigAt(
  configPath: string,
  boundaryRoot: string,
  env: NodeJS.ProcessEnv,
  source: McpConfigSource,
  options: ReadMcpConfigOptions = {},
): Promise<WorkspaceMcpConfig> {
  const expand = options.expand ?? true;
  const diagnostics: WorkspaceMcpDiagnostic[] = [];

  let content: string;
  try {
    content = await readConfigFile(configPath, boundaryRoot);
  } catch (error) {
    if (isMissingError(error)) {
      return { servers: [], diagnostics };
    }
    diagnostics.push({
      code: "INVALID_MCP_CONFIG",
      path: configPath,
      message: errorMessage(error),
    });
    return { servers: [], diagnostics };
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(content);
  } catch (error) {
    diagnostics.push({
      code: "INVALID_MCP_CONFIG",
      path: configPath,
      message: `mcp.json is not valid JSON: ${errorMessage(error)}`,
    });
    return { servers: [], diagnostics };
  }

  const parsed = configFileSchema.safeParse(parsedRaw);
  if (!parsed.success) {
    diagnostics.push({
      code: "INVALID_MCP_CONFIG",
      path: configPath,
      message: `mcp.json has an invalid shape: ${z.prettifyError(parsed.error)}`,
    });
    return { servers: [], diagnostics };
  }

  const servers: WorkspaceMcpConfig["servers"][number][] = [];
  for (const [name, raw] of Object.entries(parsed.data.servers)) {
    if (!SERVER_NAME_PATTERN.test(name) || name.length > 32) {
      diagnostics.push({
        code: "INVALID_MCP_CONFIG",
        server: name,
        path: configPath,
        message:
          `MCP server name ${JSON.stringify(name)} must be 1-32 lowercase letters, digits, or single hyphens.`,
      });
      continue;
    }
    const config = buildServerConfig(name, raw, configPath, diagnostics, env, expand);
    if (config !== undefined) servers.push({ name, config, source });
  }

  servers.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  );
  return { servers, diagnostics };
}

function buildServerConfig(
  name: string,
  raw: z.infer<typeof serverConfigSchema>,
  configPath: string,
  diagnostics: WorkspaceMcpDiagnostic[],
  env: NodeJS.ProcessEnv,
  expand: boolean,
): WorkspaceMcpServerConfig | undefined {
  if (raw.type === "stdio") {
    if (raw.command === undefined || raw.command === "") {
      diagnostics.push({
        code: "INVALID_MCP_CONFIG",
        server: name,
        path: configPath,
        message: "stdio server requires a command.",
      });
      return undefined;
    }
    let expandedEnv: Record<string, string> | undefined;
    if (raw.env !== undefined && !expand) {
      expandedEnv = raw.env;
    } else if (raw.env !== undefined) {
      const result = expandVariables(raw.env, env);
      if (result === undefined) {
        diagnostics.push({
          code: "INVALID_MCP_CONFIG",
          server: name,
          path: configPath,
          message: "env references an undefined variable.",
        });
        return undefined;
      }
      expandedEnv = result;
    }
    const cwd = raw.cwd;
    return {
      type: "stdio",
      command: raw.command,
      ...(raw.args === undefined ? {} : { args: raw.args }),
      ...(expandedEnv === undefined ? {} : { env: expandedEnv }),
      ...(cwd === undefined ? {} : { cwd }),
      timeoutMs: raw.timeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS,
    };
  }

  // http
  if (raw.url === undefined || raw.url === "") {
    diagnostics.push({
      code: "INVALID_MCP_CONFIG",
      server: name,
      path: configPath,
      message: "http server requires a url.",
    });
    return undefined;
  }
  let expandedHeaders: Record<string, string> | undefined;
  if (raw.headers !== undefined && !expand) {
    expandedHeaders = raw.headers;
  } else if (raw.headers !== undefined) {
    const result = expandVariables(raw.headers, env);
    if (result === undefined) {
      diagnostics.push({
        code: "INVALID_MCP_CONFIG",
        server: name,
        path: configPath,
        message: "headers reference an undefined variable.",
      });
      return undefined;
    }
    expandedHeaders = result;
  }
  return {
    type: "http",
    url: raw.url,
    ...(expandedHeaders === undefined ? {} : { headers: expandedHeaders }),
    timeoutMs: raw.timeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS,
  };
}

/** 把 `${VAR}` 展开为 process.env 里的值；任一变量缺失时返回 undefined。 */
export function expandVariables(
  values: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    let expanded: string;
    try {
      expanded = expandString(value, env);
    } catch (error) {
      if (error instanceof MissingVariableError) return undefined;
      throw error;
    }
    result[key] = expanded;
  }
  return result;
}

function expandString(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_whole, name: string) => {
      const resolved = env[name];
      if (resolved === undefined) {
        // 用抛错区分「缺失变量」和「成功替换」。
        throw new MissingVariableError(name);
      }
      return resolved;
    },
  );
}

class MissingVariableError extends Error {
  readonly variable: string;
  constructor(variable: string) {
    super(`Undefined variable: ${variable}`);
    this.variable = variable;
  }
}

/** 把 cwd（workspace 相对）realpath 并确认在 workspace 内。 */
export function resolveMcpCwd(
  workspaceRoot: string,
  cwd: string | undefined,
): string {
  return resolveBoundedCwd(
    workspaceRoot,
    cwd,
    "MCP server cwd must remain inside the workspace",
  );
}

/**
 * 把用户级 Server 的 cwd（相对 `~`）realpath 并确认在 home 目录内。用户级配置
 * 不属于任何 workspace，stdio 子进程的工作目录只能落在 `~` 下。
 */
export function resolveUserMcpCwd(
  homeDir: string,
  cwd: string | undefined,
): string {
  return resolveBoundedCwd(
    homeDir,
    cwd,
    "MCP server cwd must remain inside the home directory",
  );
}

function resolveBoundedCwd(
  boundaryRoot: string,
  cwd: string | undefined,
  errorPrefix: string,
): string {
  // 字面路径和 realpath 都要落在根内：workspace 里指向外面的符号链接过不了这一关。
  const realRoot = realpathSync(boundaryRoot);
  if (cwd === undefined) return realRoot;
  const candidate = isAbsolute(cwd) ? resolve(cwd) : resolve(realRoot, cwd);
  if (!isWithin(realRoot, candidate)) {
    throw new Error(`${errorPrefix}: ${cwd}`);
  }
  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    throw new Error(`MCP server cwd does not exist: ${cwd}`);
  }
  if (!isWithin(realRoot, realCandidate)) {
    throw new Error(`${errorPrefix}: ${cwd}`);
  }
  return realCandidate;
}

async function readConfigFile(
  configPath: string,
  boundaryRoot: string,
): Promise<string> {
  // 先 lstat 拒绝符号链接，再 realpath 做 boundary 检查。
  try {
    const lstatResult = await fs.lstat(configPath);
    if (lstatResult.isSymbolicLink()) {
      throw new Error(`mcp.json must not be a symbolic link: ${configPath}`);
    }
  } catch (error) {
    if (isMissingError(error)) throw error;
    throw error;
  }

  const resolvedRoot = await fs.realpath(boundaryRoot);
  let resolvedPath: string;
  try {
    resolvedPath = await fs.realpath(configPath);
  } catch (error) {
    if (isMissingError(error)) throw error;
    throw new Error(`mcp.json must resolve to a regular file: ${configPath}`);
  }
  if (!isWithin(resolvedRoot, resolvedPath)) {
    throw new Error(`mcp.json must remain inside ${boundaryRoot}: ${configPath}`);
  }

  const file = await fs.open(
    resolvedPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stats = await file.stat();
    if (!stats.isFile()) {
      throw new Error(`mcp.json must be a regular file: ${configPath}`);
    }
    if (stats.size > MAX_MCP_CONFIG_BYTES) {
      throw new Error(
        `mcp.json exceeds ${MAX_MCP_CONFIG_BYTES} bytes.`,
      );
    }
    const content = await readFilePrefix(file, stats.size);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new Error(`mcp.json must be valid UTF-8: ${configPath}`);
    }
  } finally {
    await file.close();
  }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
