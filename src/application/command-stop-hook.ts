import { z } from "zod";

import type { AgentEvent, AgentEventFactory } from "../agent-events.js";
import {
  executeAgentToolCall,
} from "../agent-tool-call.js";
import { ToolExecutionError, ToolRegistry, defineTool } from "../tools.js";
import type { Tool } from "../tools.js";
import type { AuthorizedToolExecutor } from "../tool-permissions.js";
import {
  SandboxRunnerError,
  type SandboxCommandResult,
  type SandboxRunner,
} from "../sandbox/sandbox-runner.js";
import type { TranscriptMessage } from "../transcript.js";
import {
  StopHookFailedError,
  type StopHook,
  type StopHookDecision,
  type StopHookRequest,
} from "../stop-hook.js";

export const STOP_HOOK_TOOL_NAME = "stop_hook";

/** 脚本输出不符合协议时使用的稳定诊断码；脚本自身错误沿用工具错误码。 */
export const STOP_HOOK_OUTPUT_INVALID = "STOP_HOOK_OUTPUT_INVALID";

const MAX_HOOK_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_STOP_HOOK_REASON_BYTES = 4 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 48 * 1024;
const MAX_DIAGNOSTIC_BYTES = 2 * 1024;

const stopHookInputSchema = z.strictObject({
  command: z.string().min(1),
  timeoutMs: z.number().int().min(100).max(120_000),
});

export interface CommandStopHookOptions {
  /** 本轮 Run 的配置快照：命令、超时与补做次数上限。 */
  readonly command: string;
  readonly timeoutMs: number;
  readonly maxContinuations: number;
  readonly workspaceRoot: string;
  readonly executionMode: string;
  readonly conversationId: string;
  readonly runId: string;
  /** 启动本轮 Run 时的原始用户请求，检查期间保持不变。 */
  readonly input: string;
  readonly sandboxRunner: SandboxRunner;
  readonly eventFactory: AgentEventFactory;
  readonly authorizedToolExecutor: AuthorizedToolExecutor;
  /** 不含 runId；执行单次调用时补上。 */
  readonly toolPermissionContext: {
    readonly workspaceRoot: string;
    readonly executionMode?: import("../domain/conversation.js").ExecutionMode;
    readonly conversationId?: string;
  };
}

interface StopHookScriptInput {
  readonly event: "stop";
  readonly conversationId: string;
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly executionMode: string;
  readonly input: string;
  readonly step: number;
  readonly continuations: number;
  readonly candidateAnswer: string;
  readonly transcript: readonly TranscriptMessage[];
}

/** 脚本返回的决策；输出协议错误作为 ToolExecutionError 抛给工具执行器。 */
class StopHookProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StopHookProtocolError";
  }
}

/**
 * 用配置的 shell 命令执行项目提供的完成检查脚本。
 *
 * 检查通过一个仅供 Harness 内部调用的 `stop_hook` 工具执行：不加入模型可见的
 * 工具列表，也不写 assistant tool-call / tool 结果消息，只复用参数校验、权限、
 * 审批、`tool.started` / `tool.completed` 事件和审计。
 */
export function createCommandStopHook(options: CommandStopHookOptions): StopHook {
  const tool = createStopHookTool(options);
  const registry = new ToolRegistry([tool]);
  let callSeq = 0;

  return {
    command: options.command,
    maxContinuations: options.maxContinuations,
    async *check(
      request: StopHookRequest,
    ): AsyncGenerator<AgentEvent, StopHookDecision, void> {
      const scriptInput = serializeScriptInput(options, request);
      tool.setInput(scriptInput);
      callSeq += 1;
      const call = {
        callId: `${options.runId}:stop_hook:${request.step}:${callSeq}`,
        name: STOP_HOOK_TOOL_NAME,
        // 审批摘要只携带固定的命令、cwd 与超时；完整输入留在闭包里。
        arguments: JSON.stringify({
          command: options.command,
          timeoutMs: options.timeoutMs,
        }),
      };

      const result = yield* executeAgentToolCall({
        call,
        stepNumber: request.step,
        registry,
        eventFactory: options.eventFactory,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        authorizedToolExecutor: options.authorizedToolExecutor,
        toolPermissionContext: {
          ...options.toolPermissionContext,
          runId: options.runId,
        },
      });

      if (result.status === "error") {
        // 保留工具错误码与诊断，前端据此区分超时、未获批准、输出不合规和脚本自身报错。
        throw new StopHookFailedError(result.error.code, result.error.message);
      }
      return parseDecision(result.output);
    },
  };
}

function createStopHookTool(options: CommandStopHookOptions): Tool & {
  setInput(input: string): void;
} {
  let scriptInput = "";
  const tool = defineTool({
    name: STOP_HOOK_TOOL_NAME,
    description: "Runs the project completion check script configured for this run.",
    impact: options.executionMode === "full_access"
      ? "Runs the configured completion check script with Full Access."
      : "Runs the configured completion check script inside the macOS workspace sandbox.",
    inputSchema: stopHookInputSchema,
    summarizeInput({ command, timeoutMs }) {
      return { command, cwd: options.workspaceRoot, timeoutMs };
    },
    async execute(_input, context) {
      let result: SandboxCommandResult;
      try {
        result = await options.sandboxRunner.run({
          executable: "/bin/zsh",
          args: ["-f", "-c", options.command],
          cwd: options.workspaceRoot,
          timeoutMs: options.timeoutMs,
          maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
          stdin: scriptInput,
          signal: context.signal,
        });
      } catch (error) {
        // runner 的故障码（超时、输出超限、资源上限、收容失败）原样上抛；
        // 不转换会被 ToolRegistry 归成“Tool execution failed.”，丢掉原因。
        if (error instanceof SandboxRunnerError) {
          throw new ToolExecutionError(error.code, error.message);
        }
        throw error;
      }
      try {
        return parseScriptOutput(result.exitCode, result.stdout, result.stderr);
      } catch (error) {
        // 脚本故障与决策形状不合法的诊断都在这里转成工具错误；否则会被
        // ToolRegistry 归成“Tool execution failed.”，丢掉错误码和具体原因。
        if (
          error instanceof StopHookProtocolError ||
          error instanceof StopHookFailedError
        ) {
          throw new ToolExecutionError(
            STOP_HOOK_OUTPUT_INVALID,
            diagnostic(error.message),
          );
        }
        throw error;
      }
    },
  });
  return Object.assign(tool, {
    setInput(input: string) {
      scriptInput = input;
    },
  });
}

function serializeScriptInput(
  options: CommandStopHookOptions,
  request: StopHookRequest,
): string {
  const scriptInput: StopHookScriptInput = {
    event: "stop",
    conversationId: options.conversationId,
    runId: options.runId,
    workspaceRoot: options.workspaceRoot,
    executionMode: options.executionMode,
    input: options.input,
    step: request.step,
    continuations: request.continuations,
    candidateAnswer: request.candidateAnswer,
    transcript: request.transcript,
  };
  const serialized = JSON.stringify(scriptInput);
  if (Buffer.byteLength(serialized, "utf8") > MAX_HOOK_INPUT_BYTES) {
    throw new StopHookFailedError(
      "STOP_HOOK_INPUT_TOO_LARGE",
      `Stop hook input exceeds ${MAX_HOOK_INPUT_BYTES} bytes.`,
    );
  }
  return serialized;
}

function parseScriptOutput(
  exitCode: number,
  stdout: string,
  stderr: string,
): StopHookDecision {
  if (exitCode !== 0) {
    throw new StopHookProtocolError(
      `The completion check exited with status ${exitCode}.${stderrSuffix(stderr)}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new StopHookProtocolError(
      `The completion check did not print a single JSON object on stdout.${stderrSuffix(stderr)}`,
    );
  }
  return parseDecision(value);
}

/** 决策的严格形状：只允许 `{decision:"allow"}` 或 `{decision:"block", reason}`。 */
const stopHookDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("allow") }),
  z.strictObject({
    decision: z.literal("block"),
    reason: z
      .string()
      .refine((value) => value.trim() !== "", "reason must not be empty")
      .refine(
        (value) =>
          Buffer.byteLength(value, "utf8") <= MAX_STOP_HOOK_REASON_BYTES,
        `reason must be at most ${MAX_STOP_HOOK_REASON_BYTES} bytes`,
      ),
  }),
]);

/** 解析脚本的决策；形状不合法时转成带诊断码的 `StopHookFailedError`。 */
export function parseDecision(value: unknown): StopHookDecision {
  // zod 4.4.3 的 strictObject 在未知键检查里跳过 `__proto__`，会放过 JSON.parse
  // 产生的顶层 `__proto__` 自有键；这里补齐检查，严格输出契约不依赖 zod 版本。
  if (hasOwnProtoKey(value)) {
    // 文案与 zod 对普通未知键的输出保持一致，前端看到的诊断形态不变。
    throw new StopHookFailedError(
      STOP_HOOK_OUTPUT_INVALID,
      '✖ Unrecognized key: "__proto__"',
    );
  }
  const parsed = stopHookDecisionSchema.safeParse(value);
  if (!parsed.success) {
    throw new StopHookFailedError(
      STOP_HOOK_OUTPUT_INVALID,
      z.prettifyError(parsed.error),
    );
  }
  return parsed.data;
}

function hasOwnProtoKey(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    Object.hasOwn(value, "__proto__");
}

function stderrSuffix(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed === "" ? "" : ` stderr: ${diagnostic(trimmed)}`;
}

function diagnostic(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_DIAGNOSTIC_BYTES) return text;
  return `${Buffer.from(text, "utf8").subarray(0, MAX_DIAGNOSTIC_BYTES).toString("utf8")}…`;
}
