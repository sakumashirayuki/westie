export interface SandboxCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** 一次性写入子进程 stdin 的 UTF-8 文本；省略时 stdin 为 ignore。 */
  readonly stdin?: string;
  readonly signal?: AbortSignal;
}

export interface SandboxCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly sandboxStatus?: "possibly_blocked";
}

export interface SandboxResourceLimits {
  readonly cpuTimeMs: number;
  readonly memoryBytes: number;
  readonly maxProcesses: number;
  readonly diskWriteBytes: number;
}

export interface SandboxRunner {
  run(command: SandboxCommand): Promise<SandboxCommandResult>;
}

export type SandboxRunnerErrorCode =
  | "COMMAND_TIMEOUT"
  | "COMMAND_OUTPUT_TOO_LARGE"
  | "COMMAND_CPU_LIMIT_EXCEEDED"
  | "COMMAND_MEMORY_LIMIT_EXCEEDED"
  | "COMMAND_PROCESS_LIMIT_EXCEEDED"
  | "COMMAND_DISK_WRITE_LIMIT_EXCEEDED"
  | "RESOURCE_LIMIT_ENFORCEMENT_FAILED"
  | "PROCESS_CONTAINMENT_FAILED"
  | "SANDBOX_UNAVAILABLE";

export class SandboxRunnerError extends Error {
  readonly code: SandboxRunnerErrorCode;

  constructor(code: SandboxRunnerErrorCode, message: string) {
    super(message);
    this.name = "SandboxRunnerError";
    this.code = code;
  }
}
