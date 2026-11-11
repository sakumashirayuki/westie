import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const temporaryHome = await mkdtemp(path.join(tmpdir(), "harness-e2e-"));
const browserPath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? (
  process.platform === "darwin"
    ? path.join(homedir(), "Library", "Caches", "ms-playwright")
    : path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"), "ms-playwright")
);
const env = {
  PATH: process.env.PATH,
  HOME: temporaryHome,
  TMPDIR: temporaryHome,
  LANG: process.env.LANG,
  CI: process.env.CI,
  HARNESS_E2E_RUN_ID: randomUUID(),
  PLAYWRIGHT_BROWSERS_PATH: browserPath,
};

try {
  const child = spawn(process.execPath, [
    path.resolve("node_modules/@playwright/test/cli.js"),
    "test",
    ...process.argv.slice(2),
  ], { env, stdio: "inherit" });
  const forwardSignal = (signal) => child.kill(signal);
  const onInterrupt = () => forwardSignal("SIGINT");
  const onTerminate = () => forwardSignal("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
  process.exitCode = result.code ?? (result.signal ? 1 : 0);
} finally {
  await rm(temporaryHome, { recursive: true, force: true });
}
