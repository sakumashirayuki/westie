import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { z } from "zod";

import { readFilePrefix } from "./read-file-prefix.js";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_COMMAND_BYTES = 8 * 1024;

export const STOP_HOOK_CONFIG_RELATIVE_PATH = join(".agents", "stop-hook.json");
export const DEFAULT_STOP_HOOK_TIMEOUT_MS = 30_000;
export const MIN_STOP_HOOK_TIMEOUT_MS = 100;
export const MAX_STOP_HOOK_TIMEOUT_MS = 120_000;
export const DEFAULT_STOP_HOOK_MAX_CONTINUATIONS = 2;
export const MAX_STOP_HOOK_CONTINUATIONS = 5;

/** 项目级 Stop Hook 配置的读取快照；每个主 Run 开始时读取一次。 */
export interface StopHookConfig {
  readonly command: string;
  readonly timeoutMs: number;
  readonly maxContinuations: number;
}

const stopHookConfigSchema = z.strictObject({
  command: z.string().refine(
    (value) => value.trim() !== "" && Buffer.byteLength(value, "utf8") <= MAX_COMMAND_BYTES,
    `command must be a non-empty string of at most ${MAX_COMMAND_BYTES} bytes`,
  ),
  timeoutMs: z.number().int().min(MIN_STOP_HOOK_TIMEOUT_MS).max(MAX_STOP_HOOK_TIMEOUT_MS)
    .optional(),
  maxContinuations: z.number().int().min(0).max(MAX_STOP_HOOK_CONTINUATIONS)
    .optional(),
});

/**
 * 读取 `<canonical workspace>/.agents/stop-hook.json`。
 *
 * 返回 undefined 表示项目没有配置 Hook，保持原有结束流程。文件存在但格式、
 * 路径或取值非法时抛出错误；调用方据此让本轮以 STOP_HOOK_CONFIG_INVALID 失败，
 * 静默关闭检查会掩盖作者原本要求的完成检查。
 */
export async function loadStopHookConfig(
  canonicalWorkspaceRoot: string,
): Promise<StopHookConfig | undefined> {
  const agentsDirectory = join(canonicalWorkspaceRoot, ".agents");
  const configPath = join(canonicalWorkspaceRoot, STOP_HOOK_CONFIG_RELATIVE_PATH);

  if (!(await pathExists(configPath))) return undefined;

  try {
    const resolvedWorkspaceRoot = await realpath(canonicalWorkspaceRoot);
    await assertRegularEntry(agentsDirectory, "Stop hook config directory");
    await assertRegularEntry(configPath, "Stop hook config");
    const resolvedConfigPath = await realpath(configPath);
    if (!isWithin(resolvedWorkspaceRoot, resolvedConfigPath)) {
      throw new Error(
        `Stop hook config must remain inside the workspace: ${configPath}`,
      );
    }

    const content = await readBoundedFile(resolvedConfigPath);
    return parseStopHookConfig(content, configPath);
  } catch (error) {
    if (error instanceof StopHookConfigError) throw error;
    throw new StopHookConfigError(
      `Stop hook config is invalid: ${configPath}: ${messageOf(error)}`,
      { cause: error },
    );
  }
}

export class StopHookConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StopHookConfigError";
  }
}

function parseStopHookConfig(
  content: string,
  configPath: string,
): StopHookConfig {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new StopHookConfigError(
      `Stop hook config must be strict JSON: ${configPath}`,
      { cause: error },
    );
  }
  const parsed = stopHookConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new StopHookConfigError(
      `Stop hook config has an invalid shape: ${configPath}: ${z.prettifyError(parsed.error)}`,
    );
  }
  return {
    command: parsed.data.command,
    timeoutMs: parsed.data.timeoutMs ?? DEFAULT_STOP_HOOK_TIMEOUT_MS,
    maxContinuations:
      parsed.data.maxContinuations ?? DEFAULT_STOP_HOOK_MAX_CONTINUATIONS,
  };
}

async function assertRegularEntry(
  path: string,
  label: string,
): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile() && !stats.isDirectory()) {
    throw new StopHookConfigError(
      `${label} must be a regular file or directory inside the workspace: ${path}`,
    );
  }
}

async function readBoundedFile(path: string): Promise<string> {
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new StopHookConfigError(
      `Stop hook config must be a regular file: ${path}`,
      { cause: error },
    );
  }
  try {
    const stats = await file.stat();
    if (!stats.isFile()) {
      throw new StopHookConfigError(
        `Stop hook config must be a regular file: ${path}`,
      );
    }
    if (stats.size > MAX_CONFIG_BYTES) {
      throw new StopHookConfigError(
        `Stop hook config exceeds ${MAX_CONFIG_BYTES} bytes: ${path}`,
      );
    }
    const content = await readFilePrefix(file, MAX_CONFIG_BYTES + 1);
    if (content.byteLength > MAX_CONFIG_BYTES) {
      throw new StopHookConfigError(
        `Stop hook config exceeds ${MAX_CONFIG_BYTES} bytes: ${path}`,
      );
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new StopHookConfigError(
        `Stop hook config must be valid UTF-8: ${path}`,
      );
    }
  } finally {
    await file.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot));
}
