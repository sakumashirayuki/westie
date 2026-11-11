import {
  execFile,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { ProcessContainment } from "./process-runner.js";
import {
  SandboxRunnerError,
  type SandboxResourceLimits,
} from "./sandbox-runner.js";

const HELPER_PATH = fileURLToPath(
  new URL("../../native/process-containment-helper", import.meta.url),
);
const MONITOR_STOP_TIMEOUT_MS = 1_000;

export async function assertDarwinProcessContainmentAvailable(): Promise<void> {
  try {
    await access(HELPER_PATH, constants.X_OK);
  } catch {
    throw new SandboxRunnerError(
      "SANDBOX_UNAVAILABLE",
      "The macOS process containment helper is unavailable.",
    );
  }
}

export function createResourceLimitedCommand(
  executable: string,
  args: readonly string[],
  limits: SandboxResourceLimits,
): { readonly executable: string; readonly args: readonly string[] } {
  validateResourceLimits(limits);
  return {
    executable: HELPER_PATH,
    args: [
      "exec",
      String(Math.max(1, Math.ceil(limits.cpuTimeMs / 1_000))),
      String(limits.diskWriteBytes),
      executable,
      ...args,
    ],
  };
}

export class DarwinProcessContainment implements ProcessContainment {
  readonly canaryDirectory: string;
  readonly allowedCanaryPath: string;
  readonly deniedCanaryPath: string;
  readonly #monitor: ChildProcess;
  readonly #monitorClosed: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly #ready: Promise<void>;
  readonly #violationListeners = new Set<(error: unknown) => void>();
  #violation: unknown | undefined;
  #stopping = false;
  #termination: Promise<void> | undefined;

  private constructor(
    canaryDirectory: string,
    limits: SandboxResourceLimits,
  ) {
    validateResourceLimits(limits);
    this.canaryDirectory = canaryDirectory;
    this.allowedCanaryPath = path.join(canaryDirectory, "allowed.canary");
    this.deniedCanaryPath = path.join(canaryDirectory, "denied.canary");
    createCanary(this.allowedCanaryPath);
    createCanary(this.deniedCanaryPath);

    this.#monitor = spawn(
      HELPER_PATH,
      [
        "monitor",
        this.allowedCanaryPath,
        this.deniedCanaryPath,
        String(limits.cpuTimeMs * 1_000_000),
        String(limits.memoryBytes),
        String(limits.maxProcesses),
        String(limits.diskWriteBytes),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let ready = false;
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: unknown) => void) | undefined;
    this.#ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    let stdoutBuffer = "";
    let stderr = "";

    this.#monitor.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "READY" && !ready) {
          ready = true;
          resolveReady?.();
          continue;
        }
        const violation = resourceViolationFromLine(line);
        if (violation !== undefined) {
          this.#publishViolation(violation);
          continue;
        }
        if (line !== "") {
          this.#publishViolation(
            resourceEnforcementError("Invalid resource monitor response."),
          );
        }
      }
    });
    this.#monitor.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    this.#monitorClosed = new Promise((resolve) => {
      this.#monitor.once("close", (code, signal) => {
        const exit = { code, signal };
        if (!ready) {
          rejectReady?.(
            resourceEnforcementError(
              stderr.trim() || "The resource monitor failed to start.",
            ),
          );
        }
        if (
          this.#violation === undefined &&
          (code !== 0 || !this.#stopping)
        ) {
          this.#publishViolation(
            resourceEnforcementError(
              stderr.trim() || "The resource monitor stopped unexpectedly.",
            ),
          );
        }
        resolve(exit);
      });
      this.#monitor.once("error", (error) => {
        rejectReady?.(resourceEnforcementError(error.message));
        this.#publishViolation(resourceEnforcementError(error.message));
      });
    });
  }

  static async create(
    canaryDirectory: string,
    limits: SandboxResourceLimits,
  ): Promise<DarwinProcessContainment> {
    const containment = new DarwinProcessContainment(
      canaryDirectory,
      limits,
    );
    await containment.#ready;
    return containment;
  }

  getViolation(): unknown | undefined {
    return this.#violation;
  }

  onViolation(listener: (error: unknown) => void): () => void {
    if (this.#violation !== undefined) {
      queueMicrotask(() => listener(this.#violation));
      return () => {};
    }
    this.#violationListeners.add(listener);
    return () => this.#violationListeners.delete(listener);
  }

  terminate(): Promise<void> {
    this.#termination ??= this.#terminate();
    return this.#termination;
  }

  async #terminate(): Promise<void> {
    this.#stopping = true;
    if (
      this.#monitor.exitCode === null &&
      this.#monitor.signalCode === null
    ) {
      this.#monitor.kill("SIGTERM");
    }

    const stopped = await Promise.race([
      this.#monitorClosed.then(() => true),
      delay(MONITOR_STOP_TIMEOUT_MS).then(() => false),
    ]);
    if (!stopped) {
      this.#monitor.kill("SIGKILL");
      this.#publishViolation(
        resourceEnforcementError("The resource monitor did not stop."),
      );
      await this.#monitorClosed;
    }

    await runContainmentHelper(
      this.allowedCanaryPath,
      this.deniedCanaryPath,
    );
    if (
      this.#violation instanceof SandboxRunnerError &&
      this.#violation.code === "RESOURCE_LIMIT_ENFORCEMENT_FAILED"
    ) {
      throw this.#violation;
    }
  }

  #publishViolation(error: unknown): void {
    if (this.#violation !== undefined) return;
    this.#violation = error;
    for (const listener of this.#violationListeners) listener(error);
    this.#violationListeners.clear();
  }
}

function createCanary(canaryPath: string): void {
  const descriptor = openSync(
    canaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDONLY,
    0o600,
  );
  closeSync(descriptor);
}

function runContainmentHelper(
  allowedCanaryPath: string,
  deniedCanaryPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      HELPER_PATH,
      ["cleanup", allowedCanaryPath, deniedCanaryPath],
      {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 16 * 1024,
      },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve();
          return;
        }
        reject(
          new SandboxRunnerError(
            "PROCESS_CONTAINMENT_FAILED",
            stderr.trim() || "Failed to clean up the sandbox process tree.",
          ),
        );
      },
    );
  });
}

function resourceViolationFromLine(
  line: string,
): SandboxRunnerError | undefined {
  switch (line) {
    case "LIMIT CPU":
      return new SandboxRunnerError(
        "COMMAND_CPU_LIMIT_EXCEEDED",
        "Command exceeded the CPU time limit.",
      );
    case "LIMIT MEMORY":
      return new SandboxRunnerError(
        "COMMAND_MEMORY_LIMIT_EXCEEDED",
        "Command exceeded the memory limit.",
      );
    case "LIMIT PROCESSES":
      return new SandboxRunnerError(
        "COMMAND_PROCESS_LIMIT_EXCEEDED",
        "Command exceeded the process limit.",
      );
    case "LIMIT DISK_WRITE":
      return new SandboxRunnerError(
        "COMMAND_DISK_WRITE_LIMIT_EXCEEDED",
        "Command exceeded the disk write limit.",
      );
    default:
      return undefined;
  }
}

function resourceEnforcementError(message: string): SandboxRunnerError {
  return new SandboxRunnerError(
    "RESOURCE_LIMIT_ENFORCEMENT_FAILED",
    message,
  );
}

function validateResourceLimits(limits: SandboxResourceLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new SandboxRunnerError(
        "SANDBOX_UNAVAILABLE",
        `Invalid sandbox resource limit: ${name}.`,
      );
    }
  }
  if (!Number.isSafeInteger(limits.cpuTimeMs * 1_000_000)) {
    throw new SandboxRunnerError(
      "SANDBOX_UNAVAILABLE",
      "The CPU time limit is too large.",
    );
  }
}
