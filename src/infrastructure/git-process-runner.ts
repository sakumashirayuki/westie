import { spawn } from "node:child_process";

/** 单次 Git 查询的超时（毫秒）。超时后终止进程并等待退出。 */
export const GIT_QUERY_TIMEOUT_MS = 10_000;
/** 创建 worktree 的超时（毫秒）。超时后终止进程，结果标记为需要检查。 */
export const GIT_WORKTREE_TIMEOUT_MS = 120_000;
/** 新建 worktree 前 `git fetch` 的超时（毫秒）；超时后终止进程并报告。 */
export const GIT_FETCH_TIMEOUT_MS = 60_000;
/** 每个输出流的字节上限；超过上限终止进程并报告。 */
export const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;
/** 同时运行的 Git 子进程上限；超出的请求排队等待。 */
export const GIT_MAX_CONCURRENT_PROCESSES = 4;

export type GitFailureReason = "unavailable" | "timeout" | "output_limit";

/** Git 进程自身的失败（找不到可执行文件、超时、输出超限、被取消）。 */
export class GitProcessError extends Error {
  constructor(
    readonly reason: GitFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "GitProcessError";
  }
}

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitCommand {
  /** 子进程工作目录；查询某个 checkout 时用它限定范围。 */
  readonly cwd: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface GitRunner {
  readonly executable: string;
  /**
   * 运行 Git。调用方关闭 stdin 与交互式提示，因此 Git 不会等待用户输入。
   * 进程启动失败、超时、输出超限或被取消时抛 `GitProcessError`；非零退出码
   * 由调用方按业务语义处理。
   */
  run(command: GitCommand): Promise<GitCommandResult>;
}

export interface GitProcessRunnerOptions {
  /** 默认 `git`，按 PATH 解析；测试可换成固定可执行文件。 */
  readonly executable?: string;
  readonly maxConcurrent?: number;
}

/** 宿主进程内的 Git 调用入口；同一时间最多运行 `maxConcurrent` 个。 */
export class GitProcessRunner implements GitRunner {
  readonly executable: string;
  readonly #maxConcurrent: number;
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(options: GitProcessRunnerOptions = {}) {
    this.executable = options.executable ?? "git";
    this.#maxConcurrent = options.maxConcurrent ?? GIT_MAX_CONCURRENT_PROCESSES;
  }

  async run(command: GitCommand): Promise<GitCommandResult> {
    const release = await this.#acquire(command.signal);
    try {
      command.signal?.throwIfAborted();
      return await spawnGit(this.executable, command);
    } finally {
      release();
    }
  }

  #acquire(signal: AbortSignal | undefined): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("Git command aborted."));
    }
    if (this.#active < this.#maxConcurrent) {
      this.#active += 1;
      return Promise.resolve(this.#releaseHandle());
    }
    return new Promise<() => void>((resolve, reject) => {
      const start = (): void => {
        signal?.removeEventListener("abort", cancel);
        this.#active += 1;
        resolve(this.#releaseHandle());
      };
      const cancel = (): void => {
        const index = this.#waiters.indexOf(start);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(signal?.reason ?? new Error("Git command aborted."));
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.#waiters.push(start);
    });
  }

  #releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      const next = this.#waiters.shift();
      if (next !== undefined) next();
    };
  }
}

/** 关闭凭据提示并固定输出语言，避免依赖用户的语言环境。 */
export function createGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    LANG: "C",
  };
}

function spawnGit(
  executable: string,
  command: GitCommand,
): Promise<GitCommandResult> {
  const timeoutMs = command.timeoutMs ?? GIT_QUERY_TIMEOUT_MS;
  return new Promise<GitCommandResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...command.args], {
        cwd: command.cwd,
        shell: false,
        // GIT_TERMINAL_PROMPT=0：任何凭据提示都直接失败，不挂在终端上。
        env: createGitEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        new GitProcessError(
          "unavailable",
          error instanceof Error ? error.message : "Git could not be started.",
        ),
      );
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let failure: GitProcessError | undefined;

    const finish = (result: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      command.signal?.removeEventListener("abort", handleAbort);
      result();
    };
    const fail = (error: GitProcessError): void => {
      if (settled || failure !== undefined) return;
      failure = error;
      child.kill("SIGKILL");
    };
    const handleAbort = (): void => {
      fail(
        new GitProcessError(
          "unavailable",
          "Git command was cancelled.",
        ),
      );
    };

    const collect = (destination: Buffer[], chunk: Buffer): void => {
      if (settled || failure !== undefined) return;
      destination.push(chunk);
      const bytes = destination.reduce((total, item) => total + item.length, 0);
      if (bytes > GIT_MAX_OUTPUT_BYTES) {
        fail(
          new GitProcessError(
            "output_limit",
            "Git output exceeded the maximum size.",
          ),
        );
      }
    };

    const timer = setTimeout(() => {
      fail(
        new GitProcessError("timeout", `Git timed out after ${timeoutMs}ms.`),
      );
    }, timeoutMs);
    timer.unref();

    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      fail(
        new GitProcessError(
          "unavailable",
          error.code === "ENOENT"
            ? "Git is not installed or not on PATH."
            : error.message,
        ),
      );
      finish(() => {
        reject(failure ?? new GitProcessError("unavailable", error.message));
      });
    });
    child.once("close", (code) => {
      finish(() => {
        if (failure !== undefined) {
          reject(failure);
          return;
        }
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });

    command.signal?.addEventListener("abort", handleAbort, { once: true });
    if (command.signal?.aborted) handleAbort();
  });
}
