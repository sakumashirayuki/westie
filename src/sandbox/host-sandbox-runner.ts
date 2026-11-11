import { runSpawnedCommand } from "./process-runner.js";
import type {
  SandboxCommand,
  SandboxCommandResult,
  SandboxRunner,
} from "./sandbox-runner.js";

export class HostSandboxRunner implements SandboxRunner {
  run(command: SandboxCommand): Promise<SandboxCommandResult> {
    return runSpawnedCommand({
      ...command,
      env: process.env,
    });
  }
}
