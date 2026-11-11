import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  createSafeDotenvWorkspacePathRegex,
  createSensitiveWorkspacePathRegexes,
} from "../security/sensitive-path-policy.js";
import {
  assertDarwinProcessContainmentAvailable,
  createResourceLimitedCommand,
  DarwinProcessContainment,
} from "./darwin-process-containment.js";
import { runSpawnedCommand } from "./process-runner.js";
import {
  SandboxRunnerError,
  type SandboxCommand,
  type SandboxCommandResult,
  type SandboxResourceLimits,
  type SandboxRunner,
} from "./sandbox-runner.js";

const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
const DEFAULT_PATH =
  "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const SYSTEM_READ_ROOTS = [
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/Library/Apple",
  "/Library/Preferences",
  "/private/etc",
  "/etc",
  "/private/var/db/timezone",
  "/private/var/db/xcode_select_link",
  "/var/db/xcode_select_link",
  "/private/var/select",
  "/var/select",
] as const;
const TOOLCHAIN_COMMANDS = [
  "node",
  "npm",
  "npx",
  "python3",
  "pip3",
  "rg",
  "git",
] as const;
const execFileAsync = promisify(execFile);
const GIBIBYTE = 1024 * 1024 * 1024;
type SeatbeltAccessMode = "workspace-sandbox" | "full-access";

export const DEFAULT_SANDBOX_RESOURCE_LIMITS: SandboxResourceLimits = {
  cpuTimeMs: 120_000,
  memoryBytes: 2 * GIBIBYTE,
  maxProcesses: 128,
  diskWriteBytes: 2 * GIBIBYTE,
};

export class MacOsSeatbeltSandboxRunner implements SandboxRunner {
  readonly #accessMode: SeatbeltAccessMode;
  readonly #workspaceRoot: string;
  readonly #toolchainReadRoots: readonly string[];
  readonly #developerReadRoots: readonly string[];
  readonly #userTemporaryRoot: string;
  readonly #resourceLimits: SandboxResourceLimits;

  private constructor(
    accessMode: SeatbeltAccessMode,
    workspaceRoot: string,
    toolchainReadRoots: readonly string[],
    developerReadRoots: readonly string[],
    userTemporaryRoot: string,
    resourceLimits: SandboxResourceLimits,
  ) {
    this.#accessMode = accessMode;
    this.#workspaceRoot = workspaceRoot;
    this.#toolchainReadRoots = toolchainReadRoots;
    this.#developerReadRoots = developerReadRoots;
    this.#userTemporaryRoot = userTemporaryRoot;
    this.#resourceLimits = resourceLimits;
  }

  static async create(
    workspaceRoot: string,
    resourceLimits: SandboxResourceLimits =
      DEFAULT_SANDBOX_RESOURCE_LIMITS,
  ): Promise<MacOsSeatbeltSandboxRunner> {
    return MacOsSeatbeltSandboxRunner.#create(
      "workspace-sandbox",
      workspaceRoot,
      resourceLimits,
    );
  }

  static async createFullAccess(
    workspaceRoot: string,
    resourceLimits: SandboxResourceLimits =
      DEFAULT_SANDBOX_RESOURCE_LIMITS,
  ): Promise<MacOsSeatbeltSandboxRunner> {
    return MacOsSeatbeltSandboxRunner.#create(
      "full-access",
      workspaceRoot,
      resourceLimits,
    );
  }

  static async #create(
    accessMode: SeatbeltAccessMode,
    workspaceRoot: string,
    resourceLimits: SandboxResourceLimits,
  ): Promise<MacOsSeatbeltSandboxRunner> {
    if (process.platform !== "darwin") {
      throw new SandboxRunnerError(
        "SANDBOX_UNAVAILABLE",
        "The macOS Seatbelt sandbox is only available on macOS.",
      );
    }

    try {
      await access(SANDBOX_EXECUTABLE, constants.X_OK);
    } catch {
      throw new SandboxRunnerError(
        "SANDBOX_UNAVAILABLE",
        "The macOS Seatbelt sandbox launcher is unavailable.",
      );
    }
    await assertDarwinProcessContainmentAvailable();

    const runner = new MacOsSeatbeltSandboxRunner(
      accessMode,
      await realpath(workspaceRoot),
      accessMode === "workspace-sandbox"
        ? await resolveToolchainReadRoots()
        : [],
      accessMode === "workspace-sandbox"
        ? await resolveDeveloperReadRoots()
        : [],
      await realpath(tmpdir()),
      resourceLimits,
    );
    await runner.#preflight();
    return runner;
  }

  async run(command: SandboxCommand): Promise<SandboxCommandResult> {
    const temporaryHome = await mkdtemp(
      path.join(tmpdir(), "my-agent-harness-sandbox-"),
    );
    const containmentDirectory = await mkdtemp(
      path.join(tmpdir(), "my-agent-harness-containment-"),
    );
    let containment: DarwinProcessContainment | undefined;

    try {
      containment = await DarwinProcessContainment.create(
        await realpath(containmentDirectory),
        this.#resourceLimits,
      );
      const profile = this.#createProfile(
        await realpath(temporaryHome),
        containment,
      );
      const limitedCommand = createResourceLimitedCommand(
        SANDBOX_EXECUTABLE,
        [
          "-p",
          profile,
          command.executable,
          ...command.args,
        ],
        this.#resourceLimits,
      );
      const result = await runSpawnedCommand({
        executable: limitedCommand.executable,
        args: limitedCommand.args,
        cwd: command.cwd,
        env: createCommandEnvironment(this.#accessMode, temporaryHome),
        timeoutMs: command.timeoutMs,
        maxOutputBytes: command.maxOutputBytes,
        ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
        signal: command.signal,
        containment,
      });

      return result.exitCode !== 0 && indicatesPossibleSandboxViolation(result.stderr)
        ? { ...result, sandboxStatus: "possibly_blocked" }
        : result;
    } finally {
      await containment?.terminate();
      await rm(temporaryHome, { recursive: true, force: true });
      await rm(containmentDirectory, { recursive: true, force: true });
    }
  }

  async #preflight(): Promise<void> {
    const temporaryHome = await mkdtemp(
      path.join(tmpdir(), "my-agent-harness-sandbox-preflight-"),
    );
    const containmentDirectory = await mkdtemp(
      path.join(tmpdir(), "my-agent-harness-containment-preflight-"),
    );
    let containment: DarwinProcessContainment | undefined;
    try {
      containment = await DarwinProcessContainment.create(
        await realpath(containmentDirectory),
        this.#resourceLimits,
      );
      const profile = this.#createProfile(
        await realpath(temporaryHome),
        containment,
      );
      const limitedCommand = createResourceLimitedCommand(
        SANDBOX_EXECUTABLE,
        ["-p", profile, "/usr/bin/true"],
        this.#resourceLimits,
      );
      const result = await runSpawnedCommand({
        executable: limitedCommand.executable,
        args: limitedCommand.args,
        cwd: this.#workspaceRoot,
        env: createCommandEnvironment(this.#accessMode, temporaryHome),
        timeoutMs: 2_000,
        maxOutputBytes: 4 * 1024,
        containment,
      });
      if (result.exitCode !== 0) {
        throw new SandboxRunnerError(
          "SANDBOX_UNAVAILABLE",
          "The macOS Seatbelt sandbox policy could not be initialized.",
        );
      }
    } finally {
      await containment?.terminate();
      await rm(temporaryHome, { recursive: true, force: true });
      await rm(containmentDirectory, { recursive: true, force: true });
    }
  }

  #createProfile(
    temporaryHome: string,
    containment: DarwinProcessContainment,
  ): string {
    if (this.#accessMode === "full-access") {
      return createFullAccessSeatbeltProfile(containment);
    }
    return createSeatbeltProfile(
      this.#workspaceRoot,
      temporaryHome,
      this.#toolchainReadRoots,
      this.#developerReadRoots,
      this.#userTemporaryRoot,
      containment.allowedCanaryPath,
    );
  }
}

function createCommandEnvironment(
  accessMode: SeatbeltAccessMode,
  temporaryHome: string,
): NodeJS.ProcessEnv {
  return {
    HOME: accessMode === "full-access" ? homedir() : temporaryHome,
    TMPDIR: temporaryHome,
    PATH: process.env.PATH ?? DEFAULT_PATH,
    SHELL: "/bin/zsh",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    ...(process.env.LC_ALL === undefined ? {} : { LC_ALL: process.env.LC_ALL }),
    ...(process.env.TERM === undefined ? {} : { TERM: process.env.TERM }),
    MY_AGENT_HARNESS_SANDBOX:
      accessMode === "full-access" ? "full-access-tagged" : "seatbelt",
  };
}

function createFullAccessSeatbeltProfile(
  containment: DarwinProcessContainment,
): string {
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read-data (literal ${quoteSeatbeltPath(containment.deniedCanaryPath)}))`,
    "(deny file-write*",
    `  (literal ${quoteSeatbeltPath(containment.canaryDirectory)})`,
    `  (subpath ${quoteSeatbeltPath(containment.canaryDirectory)}))`,
  ].join("\n");
}

function createSeatbeltProfile(
  workspaceRoot: string,
  temporaryHome: string,
  toolchainReadRoots: readonly string[],
  developerReadRoots: readonly string[],
  userTemporaryRoot: string,
  allowedContainmentCanary: string | undefined,
): string {
  const readableRoots = [
    ...SYSTEM_READ_ROOTS,
    ...toolchainReadRoots,
    ...developerReadRoots,
    workspaceRoot,
    temporaryHome,
  ];
  const sensitivePathRegexes =
    createSensitiveWorkspacePathRegexes()
      .map(quoteSeatbeltRegex);
  const safeDotenvPathRegex =
    quoteSeatbeltRegex(createSafeDotenvWorkspacePathRegex());

  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow process-info* (target same-sandbox))",
    "(allow signal (target same-sandbox))",
    "(allow mach-priv-task-port (target same-sandbox))",
    "(allow user-preference-read)",
    "(allow mach-lookup",
    '  (global-name "com.apple.FontObjectsServer")',
    '  (global-name "com.apple.fonts")',
    '  (global-name "com.apple.logd")',
    '  (global-name "com.apple.lsd.mapdb")',
    '  (global-name "com.apple.PowerManagement.control")',
    '  (global-name "com.apple.system.logger")',
    '  (global-name "com.apple.system.opendirectoryd.libinfo")',
    '  (global-name "com.apple.system.opendirectoryd.membership")',
    '  (global-name "com.apple.bsd.dirhelper")',
    '  (global-name "com.apple.coreservices.launchservicesd")',
    ")",
    "(allow ipc-posix-shm)",
    "(allow ipc-posix-sem)",
    "(allow iokit-get-properties)",
    "(allow system-socket",
    "  (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))",
    "(allow sysctl-read)",
    '(allow file-ioctl (literal "/dev/null"))',
    '(allow file-ioctl (literal "/dev/zero"))',
    '(allow file-ioctl (literal "/dev/random"))',
    '(allow file-ioctl (literal "/dev/urandom"))',
    '(allow file-read* file-test-existence (literal "/"))',
    '(allow file-read* file-test-existence (literal "/dev/autofs_nowait"))',
    '(allow file-read* file-test-existence (literal "/dev/null"))',
    '(allow file-read* file-test-existence (literal "/dev/zero"))',
    '(allow file-read* file-test-existence (literal "/dev/random"))',
    '(allow file-read* file-test-existence (literal "/dev/urandom"))',
    '(allow file-read* file-test-existence (subpath "/dev/fd"))',
    ...readableRoots.map(
      (root) =>
        `(allow file-read* file-test-existence (subpath ${quoteSeatbeltPath(root)}))`,
    ),
    "(allow file-read-metadata (vnode-type DIRECTORY))",
    "(allow file-read-metadata file-test-existence",
    '  (literal "/var")',
    '  (literal "/etc")',
    ...readableRoots.map(
      (root) => `  (path-ancestors ${quoteSeatbeltPath(root)})`,
    ),
    ")",
    "(allow file-map-executable",
    ...readableRoots.map(
      (root) => `  (subpath ${quoteSeatbeltPath(root)})`,
    ),
    ")",
    `(allow file-write* (subpath ${quoteSeatbeltPath(workspaceRoot)}))`,
    `(allow file-write* (subpath ${quoteSeatbeltPath(temporaryHome)}))`,
    '(allow file-write-data (literal "/dev/null"))',
    '(allow file-write-data (literal "/dev/zero"))',
    '(allow file-write-data (subpath "/dev/fd"))',
    "(allow file-read* file-write*",
    "  (require-all",
    `    (subpath ${quoteSeatbeltPath(userTemporaryRoot)})`,
    '    (regex #"/xcrun_db(-[^/]*)?$")))',
    ...sensitivePathRegexes.flatMap((sensitivePathRegex) => [
      "(deny file-read* file-write* file-test-existence",
      "  (require-all",
      `    (subpath ${quoteSeatbeltPath(workspaceRoot)})`,
      `    (regex ${sensitivePathRegex})))`,
    ]),
    "(allow file-read* file-write* file-test-existence",
    "  (require-all",
    `    (subpath ${quoteSeatbeltPath(workspaceRoot)})`,
    `    (regex ${safeDotenvPathRegex})))`,
    ...(allowedContainmentCanary === undefined
      ? []
      : [
          `(allow file-read-data (literal ${quoteSeatbeltPath(allowedContainmentCanary)}))`,
        ]),
  ].join("\n");
}

function quoteSeatbeltPath(value: string): string {
  return JSON.stringify(value);
}

function quoteSeatbeltRegex(value: string): string {
  return `#${JSON.stringify(value)}`;
}

function indicatesPossibleSandboxViolation(stderr: string): boolean {
  return /operation not permitted/i.test(stderr);
}

async function resolveToolchainReadRoots(): Promise<readonly string[]> {
  const pathEntries = (process.env.PATH ?? DEFAULT_PATH)
    .split(path.delimiter)
    .filter((entry) => entry !== "");
  const roots = new Set<string>();

  for (const command of TOOLCHAIN_COMMANDS) {
    for (const entry of pathEntries) {
      const candidate = path.join(entry, command);
      try {
        await access(candidate, constants.X_OK);
        const resolved = await realpath(candidate);
        roots.add(await realpath(entry));
        roots.add(toolchainRootFor(resolved));
        for (const dependencyRoot of await resolveMachODependencyRoots(resolved)) {
          roots.add(dependencyRoot);
        }
        break;
      } catch {
        // Try the next PATH entry.
      }
    }
  }

  return [...roots];
}

function toolchainRootFor(executable: string): string {
  const binMarker = `${path.sep}bin${path.sep}`;
  const binIndex = executable.lastIndexOf(binMarker);
  if (binIndex > 0 && isPathInside(homedir(), executable)) {
    return executable.slice(0, binIndex);
  }
  if (binIndex > 0 && executable.startsWith("/opt/homebrew/Cellar/")) {
    return executable.slice(0, binIndex);
  }
  return path.dirname(executable);
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." && !path.isAbsolute(relative);
}

async function resolveMachODependencyRoots(
  executable: string,
): Promise<readonly string[]> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/otool", ["-L", executable]);
    const roots = new Set<string>();
    for (const line of stdout.split("\n").slice(1)) {
      const dependency = line.trim().split(/\s+\(/, 1)[0];
      if (dependency === undefined || !dependency.startsWith("/")) continue;
      roots.add(path.dirname(dependency));
      try {
        roots.add(path.dirname(await realpath(dependency)));
      } catch {
        // The loader will report a missing dependency if the command uses it.
      }
    }
    return [...roots];
  } catch {
    return [];
  }
}

async function resolveDeveloperReadRoots(): Promise<readonly string[]> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/xcode-select", ["-p"]);
    const developerPath = await realpath(stdout.trim());
    const contentsMarker = `${path.sep}Contents${path.sep}`;
    const contentsIndex = developerPath.indexOf(contentsMarker);
    if (contentsIndex >= 0) {
      return [
        developerPath.slice(0, contentsIndex + `${path.sep}Contents`.length),
      ];
    }
    return [developerPath];
  } catch {
    return [];
  }
}
