import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { ServiceProcessManager } from "./application/service-process-manager.js";
import { SQLitePersistentServiceStore } from "./infrastructure/sqlite/persistent-service-store.js";
import {
  MacOsServiceSandboxLauncher,
  type ServiceLauncher,
} from "./sandbox/service-sandbox-launcher.js";

export async function initializeServiceProcessManager(
  database: DatabaseSync,
  databasePath: string,
  launcher?: ServiceLauncher,
): Promise<ServiceProcessManager | undefined> {
  try {
    const dataDirectory = dirname(databasePath);
    const serviceLauncher = launcher ??
      await MacOsServiceSandboxLauncher.create(dataDirectory);
    const manager = new ServiceProcessManager({
      store: new SQLitePersistentServiceStore(database),
      launcher: serviceLauncher,
      artifactsRoot: join(dataDirectory, "services"),
    });
    const interruptedServices = await manager.reconcileInterrupted();
    if (interruptedServices > 0) {
      console.warn(JSON.stringify({
        event: "service_recovery",
        reason: "PROCESS_RESTARTED",
        services: interruptedServices,
      }));
    }
    return manager;
  } catch (error) {
    console.warn(JSON.stringify({
      event: "service_sandbox_unavailable",
      message: error instanceof Error ? error.message : String(error),
    }));
    return undefined;
  }
}
