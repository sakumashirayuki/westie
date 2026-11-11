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
const MAX_GREP_OUTPUT_BYTES = 48 * 1024;
// 留存裁剪：匹配结果保留首尾若干条，省略中间并标注原命令取回方式。
const KEEP_HEAD_MATCHES = 200;
const KEEP_TAIL_MATCHES = 200;

export async function createGrepTool(
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
    name: "grep",
    description:
      "Search file contents with a ripgrep regular expression. Returns workspace-relative paths, line numbers, and matching lines.",
    impact: "Searches text file contents without modifying files.",
    inputSchema: z.strictObject({
      pattern: z.string().min(1),
      path: z.string().min(1).optional(),
      glob: z.string().min(1).optional(),
    }),
    async execute({ pattern, path = ".", glob }, context) {
      context.signal?.throwIfAborted();
      const resolvedPath = await paths.resolveExisting(path);
      const searchPath = toSearchPath(paths.root, resolvedPath);
      const args = ["--no-config", "--json"];
      if (glob !== undefined) args.push("--glob", glob);
      args.push("--", pattern, searchPath);

      try {
        const result = await sandboxRunner.run({
          executable: "rg",
          args,
          cwd: paths.root,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          maxOutputBytes: MAX_GREP_OUTPUT_BYTES,
          signal: context.signal,
        });
        if (result.exitCode === 1) return { matches: [] };
        if (result.exitCode !== 0) {
          throw new ToolExecutionError(
            "TOOL_EXECUTION_FAILED",
            "Content search failed.",
          );
        }
        const matches = parseMatches(result.stdout, paths.root);
        return {
          matches: trimMatches(matches, { pattern, path, glob }),
        };
      } catch (error) {
        if (error instanceof SandboxRunnerError) {
          throw new ToolExecutionError(error.code, error.message);
        }
        throw error;
      }
    },
  });
}

interface Match {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly omitted?: string;
}

function trimMatches(
  matches: readonly { path: string; line: number; text: string }[],
  query: { readonly pattern: string; readonly path?: string; readonly glob?: string },
): Array<{ path: string; line: number; text: string; omitted?: string }> {
  if (matches.length <= KEEP_HEAD_MATCHES + KEEP_TAIL_MATCHES) {
    return matches.map((m) => ({ ...m }));
  }
  const head = matches.slice(0, KEEP_HEAD_MATCHES).map((m) => ({ ...m }));
  const tail = matches.slice(-KEEP_TAIL_MATCHES).map((m) => ({ ...m }));
  const omitted = matches.length - KEEP_HEAD_MATCHES - KEEP_TAIL_MATCHES;
  const marker = {
    path: "",
    line: 0,
    text: "",
    omitted:
      `${omitted} matches omitted. To retrieve the original, re-run grep: ` +
      `grep ${JSON.stringify({ pattern: query.pattern, ...(query.path === undefined ? {} : { path: query.path }), ...(query.glob === undefined ? {} : { glob: query.glob }) })}`,
  };
  return [...head, marker, ...tail];
}

function parseMatches(
  stdout: string,
  workspaceRoot: string,
): Array<{ path: string; line: number; text: string }> {
  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw new ToolExecutionError(
        "TOOL_EXECUTION_FAILED",
        "Content search returned an invalid response.",
      );
    }
    if (!isMatchEvent(event)) continue;
    const absolutePath = isAbsolute(event.data.path.text)
      ? resolve(event.data.path.text)
      : resolve(workspaceRoot, event.data.path.text);
    if (isSensitiveWorkspacePath(workspaceRoot, absolutePath)) continue;
    matches.push({
      path: toOutputPath(workspaceRoot, absolutePath),
      line: event.data.line_number,
      text: event.data.lines.text.replace(/\r?\n$/, ""),
    });
  }
  return matches;
}

function isMatchEvent(value: unknown): value is {
  type: "match";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
  };
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== "match") return false;
  const data = record.data;
  if (typeof data !== "object" || data === null) return false;
  const match = data as Record<string, unknown>;
  return (
    hasText(match.path) &&
    hasText(match.lines) &&
    Number.isSafeInteger(match.line_number) &&
    Number(match.line_number) > 0
  );
}

function hasText(value: unknown): value is { text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).text === "string"
  );
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
