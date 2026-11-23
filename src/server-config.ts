import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { loadLarkConfig, type LarkConfig } from "./lark/lark-config.js";

const DEFAULT_DATABASE_PATH = ".data/agent-harness.sqlite";
const DEFAULT_MEMORY_ROOT = join(homedir(), ".my-agent-harness", "memory");

export interface AgentServerConfig {
  readonly host: string;
  readonly port: number;
  readonly allowedOrigin?: string;
  readonly databasePath: string;
  readonly modelContextTokens: number;
  readonly modelMaxOutputTokens: number;
  readonly bytesPerToken?: number;
  readonly summaryBudgetRatio?: number;
  readonly compactionRecentPairs?: number;
  /** 项目记忆根目录；绝对路径，未配置时为服务账号 home 下的默认目录。 */
  readonly memoryRoot: string;
  /** 飞书桥接配置；未填凭证时为「桥接关闭」。 */
  readonly lark: LarkConfig;
}

export interface AgentModelCapacity {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
}

export function loadAgentModelCapacity(
  environment: NodeJS.ProcessEnv = process.env,
): AgentModelCapacity {
  return {
    contextWindowTokens: requiredPositiveInteger(
      environment.AGENT_MODEL_CONTEXT_TOKENS,
      "AGENT_MODEL_CONTEXT_TOKENS",
    ),
    maxOutputTokens: requiredPositiveInteger(
      environment.AGENT_MODEL_MAX_OUTPUT_TOKENS,
      "AGENT_MODEL_MAX_OUTPUT_TOKENS",
    ),
  };
}

export function loadAgentServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workspaceRoot: string = process.cwd(),
): AgentServerConfig {
  const capacity = loadAgentModelCapacity(environment);
  const configuredDatabasePath =
    environment.AGENT_DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH;
  return {
    host: environment.HOST?.trim() || "127.0.0.1",
    port: parsePort(environment.PORT),
    allowedOrigin: optionalString(environment.CORS_ALLOW_ORIGIN),
    databasePath: isAbsolute(configuredDatabasePath)
      ? configuredDatabasePath
      : resolve(workspaceRoot, configuredDatabasePath),
    modelContextTokens: capacity.contextWindowTokens,
    modelMaxOutputTokens: capacity.maxOutputTokens,
    bytesPerToken: optionalPositiveNumber(
      environment.AGENT_BYTES_PER_TOKEN,
      "AGENT_BYTES_PER_TOKEN",
    ),
    summaryBudgetRatio: optionalRatio(
      environment.AGENT_SUMMARY_BUDGET_RATIO,
      "AGENT_SUMMARY_BUDGET_RATIO",
    ),
    compactionRecentPairs: optionalPositiveInteger(
      environment.AGENT_COMPACTION_RECENT_PAIRS,
      "AGENT_COMPACTION_RECENT_PAIRS",
    ),
    memoryRoot: absolutePathOr(
      environment.AGENT_MEMORY_ROOT,
      "AGENT_MEMORY_ROOT",
      DEFAULT_MEMORY_ROOT,
    ),
    lark: loadLarkConfig(environment),
  };
}

/** 目录型配置：留空用默认值；给值必须是绝对路径。 */
function absolutePathOr(
  value: string | undefined,
  name: string,
  fallback: string,
): string {
  const configured = value?.trim();
  if (configured === undefined || configured === "") return fallback;
  if (!isAbsolute(configured)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return configured;
}

export function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]";
}

function parsePort(value: string | undefined): number {
  const port = value === undefined ? 3000 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

/** 比例型配置：留空表示不覆盖默认值，给值则必须落在 (0, 1]。 */
function optionalRatio(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`${name} must be a number in (0, 1].`);
  }
  return parsed;
}

function requiredPositiveInteger(
  value: string | undefined,
  name: string,
): number {
  const parsed = optionalPositiveInteger(value, name);
  if (parsed === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return parsed;
}

function optionalPositiveInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return parsed;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function optionalPositiveNumber(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}
