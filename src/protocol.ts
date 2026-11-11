// Facts asserted by more than one module: schema validation, provider mapping,
// batch execution and the system prompt must all agree on these.

// 一批里真正同时执行的只读工具数量上限。模型一次要多少不设限，本机同时做多少
// 才设限；更宽的批次分波执行。
export const MAX_CONCURRENT_TOOL_EXECUTIONS = 5;

// 运行中转向（steering）的一条消息上限与单个 Run 未送达消息上限。
export const MAX_STEERING_MESSAGE_BYTES = 16 * 1024;
export const MAX_PENDING_STEERING_MESSAGES = 4;

// 命令前缀授权永不命中的元字符集：这些字符能让一条命令引入另一个被执行的
// 程序，因此只能在「允许一次」路径里出现。
export const SHELL_METACHARACTERS = [
  ";",
  "&",
  "|",
  "`",
  "$",
  ">",
  "<",
  "(",
  ")",
  "\n",
  "\r",
] as const;

// Tools the loop executes concurrently inside one batch. agent 在这里意味着同一批
// 里的多个子 Run 并行跑；同时在飞的数量按 Run 各自受 MAX_CONCURRENT_TOOL_EXECUTIONS
// 约束，没有进程级上限。
export const PARALLEL_TOOL_NAMES = [
  "read",
  "grep",
  "agent",
  "web_fetch",
  "glob",
] as const;

// 交给子 Run 的任务说明上限，与一条转向消息同口径。
export const MAX_SUB_AGENT_TASK_BYTES = 16 * 1024;

// 同一父 Run 内同时活跃的子任务上限；执行中、等待确认和正在停止的都占名额。
export const MAX_ACTIVE_SUB_AGENTS = 5;

// stop_agent 的停止原因上限。
export const MAX_SUB_AGENT_STOP_REASON_BYTES = 1024;

// Provider-boundary wrappers for tool results.
export const UNTRUSTED_TOOL_RESULT_TYPE = "untrusted_tool_result";
export const WORKSPACE_SKILL_INSTRUCTIONS_TYPE =
  "workspace_skill_instructions";
export const SUB_AGENT_RESULT_TYPE = "sub_agent_result";
export const STOP_HOOK_RESULT_TYPE = "stop_hook_result";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ToolResult =
  | {
      type: "tool_result";
      tool: string;
      status: "success";
      output: JsonValue;
    }
  | {
      type: "tool_result";
      tool: string;
      status: "error";
      error: {
        code: ToolErrorCode;
        message: string;
      };
    };

export type ToolErrorCode =
  | "UNKNOWN_TOOL"
  | "INVALID_TOOL_INPUT"
  | "TOOL_OUTPUT_TOO_LARGE"
  | "TOOL_EXECUTION_FAILED"
  | "PATH_OUTSIDE_WORKSPACE"
  | "SENSITIVE_FILE_ACCESS_DENIED"
  | "FILE_NOT_FOUND"
  | "FILE_NOT_TEXT"
  | "EDIT_CONFLICT"
  | "COMMAND_TIMEOUT"
  | "COMMAND_OUTPUT_TOO_LARGE"
  | "COMMAND_CPU_LIMIT_EXCEEDED"
  | "COMMAND_MEMORY_LIMIT_EXCEEDED"
  | "COMMAND_PROCESS_LIMIT_EXCEEDED"
  | "COMMAND_DISK_WRITE_LIMIT_EXCEEDED"
  | "RESOURCE_LIMIT_ENFORCEMENT_FAILED"
  | "PROCESS_CONTAINMENT_FAILED"
  | "SANDBOX_UNAVAILABLE"
  | "TOOL_PERMISSION_DENIED"
  | "TOOL_APPROVAL_DENIED"
  | "TOOL_APPROVAL_EXPIRED"
  | "WORKSPACE_GRANT_DENIED"
  | "WORKSPACE_GRANT_EXPIRED"
  | "SUB_AGENT_FAILED"
  | "SUB_AGENT_LIMIT_REACHED"
  | "SUB_AGENT_PARENT_ENDING"
  | "SUB_AGENT_NOT_FOUND"
  | "FETCH_FAILED"
  | "FETCH_BLOCKED_ADDRESS"
  | "FETCH_UNSUPPORTED_CONTENT"
  | "MCP_SERVER_UNAVAILABLE"
  | "MCP_TOOL_ERROR"
  | "STOP_HOOK_OUTPUT_INVALID"
  | "TOOL_INTERRUPTED";

export class ProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProtocolError";
  }
}
