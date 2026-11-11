import { defineConfig, devices } from "@playwright/test";
import { randomUUID } from "node:crypto";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: "list",
  outputDir: `test-results/e2e-${process.env.HARNESS_E2E_RUN_ID ?? randomUUID()}`,
  use: {
    ...devices["Desktop Chrome"],
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
