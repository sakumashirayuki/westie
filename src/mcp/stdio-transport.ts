import { spawn, type ChildProcess } from "node:child_process";

import { MAX_MCP_MESSAGE_BYTES, MAX_MCP_STDERR_BYTES } from "./constants.js";
import {
  JsonRpcProtocolError,
  parseJsonRpcMessage,
  type JsonRpcInboundMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponseMessage,
} from "./json-rpc.js";
import type { JsonRpcInbound, McpTransport } from "./types.js";

/**
 * stdio 传输：Harness 直接起一个子进程（不进 Seatbelt），一行一条 JSON 走
 * stdin/stdout。stderr 只保留尾部供诊断。环境变量用白名单，只传 PATH、HOME、
 * LANG、TMPDIR 加配置里的 env，Harness 自己的 API Key 不泄漏。
 */
export interface StdioTransportOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
}

export class StdioTransport implements McpTransport {
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #env: Record<string, string> | undefined;
  readonly #cwd: string | undefined;

  #child: ChildProcess | undefined;
  #stderrBuffer = "";
  #stderrBytes = 0;
  #inboundQueue: JsonRpcInbound[] = [];
  #waiters: Array<(message: JsonRpcInbound | null) => void> = [];
  #stdoutBuffer = "";
  #closed = false;
  #lastError: string | undefined;

  constructor(options: StdioTransportOptions) {
    this.#command = options.command;
    this.#args = options.args ?? [];
    this.#env = options.env;
    this.#cwd = options.cwd;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get lastError(): string | undefined {
    return this.#lastError;
  }

  async start(): Promise<void> {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      LANG: process.env.LANG ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      ...this.#env,
    };
    this.#child = spawn(this.#command, [...this.#args], {
      cwd: this.#cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.#child.stdout?.on("data", (chunk: Buffer) => {
      this.#stdoutBuffer += chunk.toString("utf8");
      this.#drainStdout();
    });
    this.#child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.#stderrBuffer += text;
      this.#stderrBytes += Buffer.byteLength(text, "utf8");
      if (this.#stderrBytes > MAX_MCP_STDERR_BYTES) {
        this.#stderrBuffer =
          this.#stderrBuffer.slice(-MAX_MCP_STDERR_BYTES);
      }
    });
    this.#child.once("error", (error) => {
      this.#lastError = `Failed to spawn ${this.#command}: ${error.message}`;
      this.#exit();
    });
    this.#child.once("exit", (code, signal) => {
      this.#lastError =
        `MCP server process exited (code ${code ?? "null"}, signal ${signal ?? "null"}).`;
      this.#exit();
    });
  }

  get stderr(): string {
    return this.#stderrBuffer;
  }

  async send(request: JsonRpcRequest): Promise<void> {
    this.#assertOpen();
    this.#child!.stdin!.write(`${JSON.stringify(request)}\n`);
  }

  async notify(notification: JsonRpcNotification): Promise<void> {
    this.#assertOpen();
    this.#child!.stdin!.write(`${JSON.stringify(notification)}\n`);
  }

  async respond(response: JsonRpcResponseMessage): Promise<void> {
    this.#assertOpen();
    this.#child!.stdin!.write(`${JSON.stringify(response)}\n`);
  }

  async receive(): Promise<JsonRpcInbound | null> {
    this.#assertOpen();
    const queued = this.#inboundQueue.shift();
    if (queued !== undefined) return queued;
    if (this.#closed) return null;
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /** 子进程 pid；测试用来确认进程确实被回收。 */
  get pid(): number | undefined {
    return this.#child?.pid;
  }

  async close(): Promise<void> {
    // `#closed` 只表示不再收发；即使 #exit() 已经置位（解析错误、消息超限），
    // 子进程仍可能活着，回收不能被它短路。
    if (!this.#closed) {
      this.#closed = true;
      this.#drainWaiters(null);
    }
    const child = this.#child;
    if (child === undefined) return;
    this.#child = undefined;

    // 分级关闭：先关 stdin，2s 后 SIGTERM，再 2s 后 SIGKILL。
    try {
      child.stdin?.end();
    } catch {
      // 忽略：进程可能已经退出。
    }
    const terminated = await terminateGracefully(child);
    if (!terminated) {
      try {
        child.kill("SIGKILL");
      } catch {
        // 忽略。
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new JsonRpcProtocolError("MCP stdio transport is closed.");
    }
  }

  #drainStdout(): void {
    for (;;) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline === -1) {
        if (Buffer.byteLength(this.#stdoutBuffer, "utf8") > MAX_MCP_MESSAGE_BYTES) {
          this.#stdoutBuffer = "";
          this.#fail("MCP server exceeded the maximum message size.");
        }
        return;
      }
      const line = this.#stdoutBuffer.slice(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (line.trim() === "") continue;
      if (Buffer.byteLength(line, "utf8") > MAX_MCP_MESSAGE_BYTES) {
        this.#fail("MCP server exceeded the maximum message size.");
        return;
      }
      let inbound: JsonRpcInbound;
      try {
        inbound = toInbound(parseJsonRpcMessage(line));
      } catch (error) {
        this.#fail(errorMessage(error));
        return;
      }
      this.#drainWaiters(inbound);
    }
  }

  #drainWaiters(message: JsonRpcInbound | null): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter(message);
      return;
    }
    if (message !== null) this.#inboundQueue.push(message);
  }

  /** 子进程自己退出了：只标记关闭，没有东西需要回收。 */
  #exit(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#drainWaiters(null);
  }

  /** 协议层面判定连接损坏：标记关闭，并终止仍然活着的子进程。 */
  #fail(reason: string): void {
    this.#lastError = reason;
    void this.close();
  }
}

function toInbound(
  message: JsonRpcInboundMessage,
): JsonRpcInbound {
  if ("error" in message) {
    return {
      kind: "error",
      id: message.id,
      code: message.error.code,
      message: message.error.message,
      ...(message.error.data === undefined ? {} : { data: message.error.data }),
    };
  }
  if ("result" in message) {
    return { kind: "response", id: message.id, result: message.result };
  }
  if ("method" in message) {
    if ("id" in message) {
      return {
        kind: "request",
        id: message.id,
        method: message.method,
        ...(message.params === undefined ? {} : { params: message.params }),
      };
    }
    return {
      kind: "notification",
      method: message.method,
      ...(message.params === undefined ? {} : { params: message.params }),
    };
  }
  throw new JsonRpcProtocolError("Unrecognized JSON-RPC inbound message.");
}

async function terminateGracefully(child: ChildProcess): Promise<boolean> {
  if (hasExited(child)) return true;
  const exited = new Promise<boolean>((resolve) => {
    child.once("exit", () => resolve(true));
  });
  // 关 stdin 后给 2s 自行退出；没退就 SIGTERM 整个进程组，再给 2s。
  if (await Promise.race([exited, delay(2_000).then(() => false)])) return true;
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
  } catch {
    // 忽略。
  }
  return Promise.race([exited, delay(2_000).then(() => false)]);
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
