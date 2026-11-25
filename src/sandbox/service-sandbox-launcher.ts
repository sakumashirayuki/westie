import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  assertDarwinProcessContainmentAvailable,
  createCanaryPair,
  runContainmentHelper,
} from "./darwin-process-containment.js";
import {
  createCommandEnvironment,
  createFullAccessSeatbeltProfile,
  createSeatbeltProfile,
} from "./macos-seatbelt-sandbox-runner.js";
import { SandboxRunnerError } from "./sandbox-runner.js";

const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";

export type ServiceExecutionMode = "workspace_sandbox" | "full_access";

export interface SpawnedServiceProcess {
  readonly pid: number;
  readonly exit: Promise<ServiceExit>;
}

export interface ServiceExit {
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
}

export interface ServiceLauncher {
  spawn(command: SpawnServiceCommand): Promise<SpawnedServiceProcess>;
  terminate(pid: number, signal: NodeJS.Signals): Promise<void>;
  cleanupCanary(
    allowedCanaryPath: string,
    deniedCanaryPath: string,
  ): Promise<void>;
}

export interface SpawnServiceCommand {
  readonly command: string;
  readonly cwd: string;
  /** 已验证的 canonical workspace 根，用于生成 Seatbelt 边界（cwd 只决定启动目录）。 */
  readonly workspaceRoot: string;
  readonly executionMode: ServiceExecutionMode;
  readonly artifacts: {
    readonly allowedCanaryPath: string;
    readonly deniedCanaryPath: string;
    readonly homeDirectory: string;
    readonly tmpDirectory: string;
  };
  readonly onStdout: (chunk: Buffer) => void;
  readonly onStderr: (chunk: Buffer) => void;
}

/**
 * service 链路直接 spawn `sandbox-exec`（与 helper `exec` 内部 `execv` 的目标
 * 一致，pid/pgid 保持不变），不经过 helper `exec`，因此不设置 RLIMIT_CPU /
 * RLIMIT_FSIZE，也不启动资源监督进程。停止时发进程组信号，再用 helper
 * `cleanup` 按 canary 指纹兜底清理逃逸后代。
 */
export class MacOsServiceSandboxLauncher implements ServiceLauncher {
  static async create(
    rootForPreflight: string,
  ): Promise<MacOsServiceSandboxLauncher> {
    if (process.platform !== "darwin") {
      throw new SandboxRunnerError(
        "SANDBOX_UNAVAILABLE",
        "The macOS Seatbelt sandbox is only available on macOS.",
      );
    }
    await assertMacOsServiceSandboxAvailable();
    const launcher = new MacOsServiceSandboxLauncher();
    await launcher.#preflight(rootForPreflight);
    return launcher;
  }

  async spawn(
    command: SpawnServiceCommand,
  ): Promise<SpawnedServiceProcess> {
    const profile = command.executionMode === "full_access"
      ? createFullAccessSeatbeltProfile({
          deniedCanaryPath: command.artifacts.deniedCanaryPath,
          canaryDirectory: path.dirname(command.artifacts.allowedCanaryPath),
        })
      : createSeatbeltProfile(
          command.workspaceRoot,
          command.artifacts.homeDirectory,
          [],
          [],
          command.artifacts.tmpDirectory,
          command.artifacts.allowedCanaryPath,
          true,
        );

    const homeDirectory = command.executionMode === "full_access"
      ? command.artifacts.tmpDirectory
      : command.artifacts.homeDirectory;
    const child = spawn(
      SANDBOX_EXECUTABLE,
      ["-p", profile, "/bin/zsh", "-f", "-c", command.command],
      {
        cwd: command.cwd,
        env: createCommandEnvironment(
          command.executionMode === "full_access"
            ? "full-access"
            : "workspace-sandbox",
          homeDirectory,
        ),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stdout?.on("data", command.onStdout);
    child.stderr?.on("data", command.onStderr);
    child.once("error", () => {});

    if (child.pid === undefined) {
      throw new Error("SERVICE_START_FAILED");
    }

    const exit = new Promise<ServiceExit>((resolve) => {
      child.once("exit", (exitCode, exitSignal) => {
        resolve({ exitCode, exitSignal });
      });
    });

    return { pid: child.pid, exit };
  }

  async terminate(pid: number, signal: NodeJS.Signals): Promise<void> {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (!isProcessMissingError(error)) throw error;
    }
  }

  cleanupCanary(
    allowedCanaryPath: string,
    deniedCanaryPath: string,
  ): Promise<void> {
    return runContainmentHelper(allowedCanaryPath, deniedCanaryPath);
  }

  async #preflight(rootForPreflight: string): Promise<void> {
    // 用临时 canary 生成一份真实 profile 并执行 `/usr/bin/true`，验证 service
    // profile 能被 sandbox-exec 接受。失败按 SANDBOX_UNAVAILABLE fail closed。
    const probeDirectory = await mkdtemp(
      path.join(tmpdir(), "my-agent-harness-service-preflight-"),
    );
    try {
      const canaryDirectory = path.join(probeDirectory, "canary");
      await mkdir(canaryDirectory, { recursive: true });
      const canaries = createCanaryPair(canaryDirectory);
      const homeDirectory = path.join(probeDirectory, "home");
      const tmpDirectory = path.join(probeDirectory, "tmp");
      await mkdir(homeDirectory, { recursive: true });
      await mkdir(tmpDirectory, { recursive: true });
      const profile = createSeatbeltProfile(
        await realpath(rootForPreflight),
        homeDirectory,
        [],
        [],
        tmpDirectory,
        canaries.allowedCanaryPath,
        true,
      );
      await runSandboxExecProbe(
        profile,
        await realpath(rootForPreflight),
        homeDirectory,
      );
    } finally {
      // 探针目录在临时目录里，删除失败不影响启动。
      await rm(probeDirectory, { recursive: true, force: true });
    }
  }
}

function runSandboxExecProbe(
  profile: string,
  cwd: string,
  homeDirectory: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      SANDBOX_EXECUTABLE,
      ["-p", profile, "/usr/bin/true"],
      {
        cwd,
        env: createCommandEnvironment("workspace-sandbox", homeDirectory),
        detached: true,
        stdio: "ignore",
      },
    );
    child.once("error", (error) => reject(error));
    child.once("exit", (exitCode, exitSignal) => {
      if (exitCode === 0 && exitSignal === null) {
        resolve();
        return;
      }
      reject(
        new SandboxRunnerError(
          "SANDBOX_UNAVAILABLE",
          "The macOS Seatbelt service profile could not be initialized.",
        ),
      );
    });
  });
}

async function assertMacOsServiceSandboxAvailable(): Promise<void> {
  try {
    await access(SANDBOX_EXECUTABLE, constants.X_OK);
  } catch {
    throw new SandboxRunnerError(
      "SANDBOX_UNAVAILABLE",
      "The macOS Seatbelt sandbox launcher is unavailable.",
    );
  }
  await assertDarwinProcessContainmentAvailable();
}

export function serviceSandboxErrorCode(
  error: unknown,
): "SANDBOX_UNAVAILABLE" | undefined {
  return error instanceof SandboxRunnerError &&
      error.code === "SANDBOX_UNAVAILABLE"
    ? "SANDBOX_UNAVAILABLE"
    : undefined;
}

function isProcessMissingError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ESRCH"
  );
}
