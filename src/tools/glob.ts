import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import type { ExecutionMode } from "../domain/conversation.js";
import { isSensitiveWorkspacePath } from "../security/sensitive-path-policy.js";
import {
  SandboxRunnerError,
  type SandboxRunner,
} from "../sandbox/sandbox-runner.js";
import { defineTool, ToolExecutionError, type Tool } from "../tools.js";
import { createWorkspacePathResolver } from "./path.js";

const DEFAULT_TIMEOUT_MS = 30_000;
// pattern 在主进程过滤，这个上限落在 path 下的全部未忽略文件列表上，而不是
// 匹配结果上。8 MiB 约十万条路径；超过时提示收窄 path。
const MAX_GLOB_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_GLOB_RESULTS = 500;

export async function createGlobTool(
  workspaceRoot: string,
  sandboxRunner: SandboxRunner,
  executionMode: ExecutionMode = "workspace_sandbox",
): Promise<Tool> {
  const paths = await createWorkspacePathResolver(
    workspaceRoot,
    undefined,
    executionMode,
  );

  return defineTool({
    name: "glob",
    description:
      "Find files by gitignore-style glob pattern, returning workspace-relative paths ordered by modification time (newest first).",
    impact: "Lists file names matching a glob without modifying files.",
    inputSchema: z.strictObject({
      pattern: z.string().min(1),
      path: z.string().min(1).optional(),
    }),
    summarizeInput({ pattern, path }) {
      return { pattern, ...(path === undefined ? {} : { path }) };
    },
    async execute({ pattern, path = "." }, context) {
      context.signal?.throwIfAborted();
      const resolvedPath = await paths.resolveExisting(path);
      const searchPath = toSearchPath(paths.root, resolvedPath);
      // 不用 -g：ripgrep 的 include glob 优先于 .gitignore 与隐藏文件过滤，
      // 像 "**/*" 这类宽模式会把被忽略的文件列出来。这里先按 ignore 规则取
      // 全部文件，再在主进程里按 pattern 过滤。
      const args = ["--no-config", "--files", "--", searchPath];

      try {
        const result = await sandboxRunner.run({
          executable: "rg",
          args,
          cwd: paths.root,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          maxOutputBytes: MAX_GLOB_OUTPUT_BYTES,
          signal: context.signal,
        });
        if (result.exitCode === 1) return { paths: [] };
        if (result.exitCode !== 0) {
          throw new ToolExecutionError(
            "TOOL_EXECUTION_FAILED",
            "File glob failed.",
          );
        }
        return await buildResult(result.stdout, paths.root, pattern, path);
      } catch (error) {
        if (error instanceof SandboxRunnerError) {
          throw new ToolExecutionError(
            error.code,
            error.code === "COMMAND_OUTPUT_TOO_LARGE"
              ? `Too many files under ${JSON.stringify(path)} to list. Use a narrower path.`
              : error.message,
          );
        }
        throw error;
      }
    },
  });
}

interface PathWithMtime {
  readonly path: string;
  readonly mtimeMs: number;
}

async function buildResult(
  stdout: string,
  workspaceRoot: string,
  pattern: string,
  path: string,
): Promise<{ paths: string[]; omitted?: string }> {
  const matcher = globToRegExp(pattern);
  const entries: PathWithMtime[] = [];
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const absolutePath = isAbsolute(line)
      ? resolve(line)
      : resolve(workspaceRoot, line);
    const outputPath = toOutputPath(workspaceRoot, absolutePath);
    if (!matcher.test(outputPath)) continue;
    if (isSensitiveWorkspacePath(workspaceRoot, absolutePath)) continue;
    let mtimeMs = 0;
    try {
      const fileStats = await stat(absolutePath);
      mtimeMs = fileStats.mtimeMs;
    } catch {
      // 文件在列目录到 stat 之间消失，跳过。
      continue;
    }
    entries.push({ path: outputPath, mtimeMs });
  }

  entries.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const paths = entries.slice(0, MAX_GLOB_RESULTS).map((entry) => entry.path);
  if (entries.length <= MAX_GLOB_RESULTS) {
    return { paths };
  }
  const omitted = entries.length - MAX_GLOB_RESULTS;
  return {
    paths,
    omitted:
      `${omitted} paths omitted. Narrow the glob or path. ` +
      `glob ${JSON.stringify({ pattern, path })}`,
  };
}

function toSearchPath(workspaceRoot: string, resolvedPath: string): string {
  const relativePath = relative(workspaceRoot, resolvedPath);
  return relativePath === "" ? "." : relativePath;
}

function toOutputPath(workspaceRoot: string, absolutePath: string): string {
  const relativePath = relative(workspaceRoot, absolutePath);
  return relativePath === "" || relativePath === ".." ||
      relativePath.startsWith("../") || isAbsolute(relativePath)
    ? absolutePath
    : relativePath;
}

/**
 * 把 gitignore 风格的 glob 转成正则，用于在主进程过滤 ripgrep --files 的结果。
 * 语义贴近 gitignore：`**` 跨目录、`*`/`?` 不跨 `/`，`[]` 是字符类；无 `/` 的
 * 模式匹配任意层级的 base name。
 */
function globToRegExp(pattern: string): RegExp {
  const hasSlash = pattern.includes("/");
  const normalized = pattern.replace(/^\.\//, "").replace(/^\/+/, "");
  const source = globToRegExpSource(normalized);
  return hasSlash ? new RegExp(`^${source}$`) : new RegExp(`(?:^|/)${source}$`);
}

function globToRegExpSource(pattern: string): string {
  let regex = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          regex += "(?:[^/]+/)*";
          i += 2;
        } else {
          regex += ".*";
          i += 1;
        }
      } else {
        regex += "[^/]*";
      }
    } else if (char === "?") {
      regex += "[^/]";
    } else if (char === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        regex += "\\[";
      } else {
        regex += pattern.slice(i, close + 1);
        i = close;
      }
    } else if (".+^$(){}".includes(char)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
  }
  return regex;
}
