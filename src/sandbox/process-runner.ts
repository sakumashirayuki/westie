import { spawn, type ChildProcess } from "node:child_process";

import {
  SandboxRunnerError,
  type SandboxCommandResult,
} from "./sandbox-runner.js";

interface SpawnedCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** 一次性写入子进程 stdin 的 UTF-8 文本；省略时 stdin 为 ignore。 */
  readonly stdin?: string;
  readonly signal?: AbortSignal;
  readonly containment?: ProcessContainment;
}

export interface ProcessContainment {
  terminate(): Promise<void>;
  getViolation?(): unknown | undefined;
  onViolation?(listener: (error: unknown) => void): () => void;
}

export function runSpawnedCommand(
  command: SpawnedCommand,
): Promise<SandboxCommandResult> {
  command.signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const writesStdin = command.stdin !== undefined;
    let child: ChildProcess;
    try {
      child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        env: command.env,
        detached: true,
        stdio: [writesStdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let terminating = false;
    let terminationError: unknown;
    let cleanupPromise: Promise<unknown | undefined> | undefined;
    let exitCode = 1;
    let closed = false;
    let unsubscribeFromViolation = (): void => {};

    const timeout = setTimeout(() => {
      beginTermination(
        new SandboxRunnerError(
          "COMMAND_TIMEOUT",
          `Command timed out after ${command.timeoutMs}ms.`,
        ),
      );
    }, command.timeoutMs);
    timeout.unref();

    const cleanup = (): void => {
      clearTimeout(timeout);
      command.signal?.removeEventListener("abort", handleAbort);
      unsubscribeFromViolation();
    };

    const finishReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const handleAbort = (): void => {
      beginTermination(
        command.signal?.reason ?? new DOMException("Aborted", "AbortError"),
      );
    };

    const beginTermination = (error: unknown): void => {
      if (settled || terminating) return;
      terminating = true;
      terminationError = error;
      cleanup();
      beginProcessTreeCleanup();
    };

    const collect = (destination: Buffer[], chunk: Buffer): void => {
      if (settled || terminating) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > command.maxOutputBytes) {
        beginTermination(
          new SandboxRunnerError(
            "COMMAND_OUTPUT_TOO_LARGE",
            "Command output exceeded the maximum size.",
          ),
        );
        return;
      }
      destination.push(chunk);
    };

    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
    // 子进程可能不读 stdin 就退出；写入失败按退出码与 stdout 协议判定，
    // EPIPE 不能冒成未处理异常。
    child.stdin?.on("error", () => {});
    child.once("error", (error) => {
      if (!terminating) terminationError = error;
      terminating = true;
      void ensureProcessTreeTerminated().then((cleanupError) => {
        finishReject(cleanupError ?? terminationError);
      });
    });
    child.once("exit", (_code, signal) => {
      const resourceError = resourceErrorForSignal(signal);
      if (resourceError !== undefined) {
        beginTermination(resourceError);
      } else {
        beginProcessTreeCleanup();
      }
    });
    child.once("close", (code) => {
      exitCode = code ?? 1;
      closed = true;
      void finishAfterCleanup();
    });

    const ensureProcessTreeTerminated = (): Promise<unknown | undefined> => {
      cleanupPromise ??= (async () => {
        let containmentError: unknown | undefined;
        try {
          await command.containment?.terminate();
        } catch (error) {
          containmentError = error;
        }
        const violation = command.containment?.getViolation?.();
        if (!terminating && violation !== undefined) {
          terminating = true;
          terminationError = violation;
        }
        const processGroupError =
          command.containment === undefined ||
            containmentError !== undefined
            ? terminateProcessGroup(child)
            : undefined;
        return containmentError ?? processGroupError;
      })();
      return cleanupPromise;
    };

    const beginProcessTreeCleanup = (): void => {
      void ensureProcessTreeTerminated().then((cleanupError) => {
        if (cleanupError !== undefined) {
          finishReject(cleanupError);
          return;
        }
        void finishAfterCleanup();
      });
    };

    const finishAfterCleanup = async (): Promise<void> => {
      if (settled || !closed) return;
      const cleanupError = await ensureProcessTreeTerminated();
      if (settled) return;
      settled = true;
      cleanup();
      if (cleanupError !== undefined) {
        reject(cleanupError);
        return;
      }
      if (terminating) {
        reject(terminationError);
        return;
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    };

    unsubscribeFromViolation =
      command.containment?.onViolation?.((error) => {
        beginTermination(error);
      }) ?? unsubscribeFromViolation;
    command.signal?.addEventListener("abort", handleAbort, { once: true });
    if (command.signal?.aborted) handleAbort();
    // 先注册错误、取消和收容违规监听，再向子进程写入输入（如 Stop Hook 的检查 JSON）。
    // 仅在已创建 stdin 管道、执行尚未完成且未进入终止流程时写入。
    if (
      writesStdin && !settled && !terminating && command.stdin !== undefined
    ) {
      // 写完后关闭输入端，让子进程读到 EOF，避免一直等待后续输入。
      child.stdin?.end(command.stdin);
    }
  });
}

function resourceErrorForSignal(
  signal: NodeJS.Signals | null,
): SandboxRunnerError | undefined {
  if (signal === "SIGXCPU") {
    return new SandboxRunnerError(
      "COMMAND_CPU_LIMIT_EXCEEDED",
      "Command exceeded the CPU time limit.",
    );
  }
  if (signal === "SIGXFSZ") {
    return new SandboxRunnerError(
      "COMMAND_DISK_WRITE_LIMIT_EXCEEDED",
      "Command exceeded the disk write limit.",
    );
  }
  return undefined;
}

function terminateProcessGroup(child: ChildProcess): unknown | undefined {
  if (child.pid === undefined) return undefined;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (!isProcessMissingError(error)) return error;
  }
  return undefined;
}

function isProcessMissingError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ESRCH"
  );
}
