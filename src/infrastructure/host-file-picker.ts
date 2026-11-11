import { spawn } from "node:child_process";

export type HostFilePickerResult =
  | { readonly status: "selected"; readonly path: string }
  | { readonly status: "cancelled" };

export interface HostFilePicker {
  pickFile(signal?: AbortSignal): Promise<HostFilePickerResult>;
}

export type HostDirectoryPickerResult =
  | { readonly status: "selected"; readonly path: string }
  | { readonly status: "cancelled" };

export interface HostDirectoryPicker {
  pickDirectory(signal?: AbortSignal): Promise<HostDirectoryPickerResult>;
}

interface OsaScriptCommand {
  readonly executable: "/usr/bin/osascript";
  readonly args: readonly string[];
  readonly signal?: AbortSignal;
}

interface OsaScriptResult {
  readonly exitCode: number;
  readonly stdout: string;
}

type OsaScriptExecutor = (
  command: OsaScriptCommand,
) => Promise<OsaScriptResult>;

const CANCELLED_MARKER = "__MY_AGENT_HARNESS_FILE_PICKER_CANCELLED__";
const PICK_FILE_SCRIPT = `
try
  set selectedFile to choose file with prompt "Choose a file for the agent to access"
  return POSIX path of selectedFile
on error number -128
  return "${CANCELLED_MARKER}"
end try
`.trim();
const PICK_DIRECTORY_SCRIPT = `
try
  set selectedDirectory to choose folder with prompt "Choose a project for the agent to open"
  return POSIX path of selectedDirectory
on error number -128
  return "${CANCELLED_MARKER}"
end try
`.trim();

export class MacOsHostFilePicker implements HostFilePicker {
  constructor(
    private readonly executeOsaScript: OsaScriptExecutor =
      runOsaScript,
  ) {}

  async pickFile(signal?: AbortSignal): Promise<HostFilePickerResult> {
    return pickPath(
      this.executeOsaScript,
      PICK_FILE_SCRIPT,
      "Could not open the macOS file picker.",
      signal,
    );
  }
}

export class MacOsHostDirectoryPicker implements HostDirectoryPicker {
  constructor(
    private readonly executeOsaScript: OsaScriptExecutor =
      runOsaScript,
  ) {}

  async pickDirectory(
    signal?: AbortSignal,
  ): Promise<HostDirectoryPickerResult> {
    return pickPath(
      this.executeOsaScript,
      PICK_DIRECTORY_SCRIPT,
      "Could not open the macOS directory picker.",
      signal,
    );
  }
}

async function pickPath(
  executeOsaScript: OsaScriptExecutor,
  script: string,
  failureMessage: string,
  signal?: AbortSignal,
): Promise<HostFilePickerResult> {
  signal?.throwIfAborted();

  let result: OsaScriptResult;
  try {
    result = await executeOsaScript({
      executable: "/usr/bin/osascript",
      args: ["-e", script],
      signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    throw new Error(failureMessage);
  }

  if (result.exitCode !== 0) throw new Error(failureMessage);

  const output = result.stdout.trim();
  if (output === CANCELLED_MARKER) return { status: "cancelled" };
  if (output.length === 0) throw new Error(failureMessage);
  return { status: "selected", path: output };
}

function runOsaScript(
  command: OsaScriptCommand,
): Promise<OsaScriptResult> {
  command.signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      shell: false,
      signal: command.signal,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const stdout: Buffer[] = [];
    let settled = false;

    const cleanup = (): void => {
      command.signal?.removeEventListener("abort", handleAbort);
    };
    const finishResolve = (result: OsaScriptResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const finishReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handleAbort = (): void => {
      child.kill("SIGKILL");
      finishReject(
        command.signal?.reason ??
          new DOMException("Aborted", "AbortError"),
      );
    };

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.once("error", finishReject);
    child.once("close", (exitCode) => {
      finishResolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });

    command.signal?.addEventListener("abort", handleAbort, {
      once: true,
    });
    if (command.signal?.aborted) handleAbort();
  });
}
