import { realpathSync } from "node:fs";

import { z } from "zod";

import {
  SandboxRunnerError,
  type SandboxRunner,
} from "../sandbox/sandbox-runner.js";
import { defineTool, ToolExecutionError, type Tool } from "../tools.js";
import type { ExecutionMode } from "../domain/conversation.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 48 * 1024;
// 留存裁剪：stdout/stderr 各自保留首尾若干行，其余省略并标注取回命令。
const KEEP_HEAD_LINES = 200;
const KEEP_TAIL_LINES = 200;

export function createBashTool(
  workspaceRoot: string,
  sandboxRunner: SandboxRunner,
  executionMode: ExecutionMode = "workspace_sandbox",
): Tool {
  const cwd = realpathSync(workspaceRoot);

  return defineTool({
    name: "bash",
    description: executionMode === "full_access"
      ? "Run a zsh command with the host user's file and network access. Prefer glob and grep for finding files and searching contents."
      : "Run a zsh command in the workspace. Prefer glob and grep for finding files and searching contents.",
    impact: executionMode === "full_access"
      ? "Runs one zsh command with Full Access while retaining resource and process limits."
      : "Runs one zsh command inside the macOS workspace sandbox.",
    inputSchema: z.strictObject({
      command: z.string().min(1),
      timeoutMs: z.number().int().min(100).max(120_000).optional(),
    }),
    summarizeInput({ command, timeoutMs = DEFAULT_TIMEOUT_MS }) {
      return { command, cwd, timeoutMs };
    },
    async execute({ command, timeoutMs = DEFAULT_TIMEOUT_MS }, context) {
      try {
        const result = await sandboxRunner.run({
          executable: "/bin/zsh",
          args: ["-f", "-c", command],
          cwd,
          timeoutMs,
          maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
          signal: context.signal,
        });
        return {
          exitCode: result.exitCode,
          stdout: trimOutput(result.stdout, command),
          stderr: trimOutput(result.stderr, command),
          ...(result.sandboxStatus === undefined
            ? {}
            : { sandboxStatus: result.sandboxStatus }),
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

function trimOutput(output: string, command: string): string {
  if (output === "") return output;
  const lines = output.split("\n");
  if (lines.length <= KEEP_HEAD_LINES + KEEP_TAIL_LINES) return output;
  const head = lines.slice(0, KEEP_HEAD_LINES);
  const tail = lines.slice(-KEEP_TAIL_LINES);
  const omitted = lines.length - KEEP_HEAD_LINES - KEEP_TAIL_LINES;
  const headText = head.length > 0 && head.at(-1) === ""
    ? head.slice(0, -1)
    : head;
  const marker = [
    `… ${omitted} lines omitted. To retrieve the original, re-run the command:`,
    `bash {"command": ${JSON.stringify(command)}}`,
  ];
  return [...headText, ...marker, ...tail].join("\n");
}
