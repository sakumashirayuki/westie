import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createServiceTool } from "../src/tools/service.js";
import { ToolExecutionError } from "../src/tools.js";
import type { ServiceProcessManager } from "../src/application/service-process-manager.js";

test("service tool validates inputs per action", async () => {
  const tool = createServiceTool("/workspace", "workspace_sandbox", {
    list() {
      return [];
    },
  } as unknown as ServiceProcessManager);

  await assert.rejects(
    tool.execute({ action: "start", command: "" }, {}),
    (error: unknown) =>
      error instanceof ToolExecutionError && error.code === "INVALID_TOOL_INPUT",
  );
  await assert.rejects(
    tool.execute({ action: "status" }, {}),
    (error: unknown) =>
      error instanceof ToolExecutionError && error.code === "INVALID_TOOL_INPUT",
  );
});

test("service tool lists services from the manager", async () => {
  const tool = createServiceTool("/workspace", "workspace_sandbox", {
    list() {
      return [{ id: "s-1", name: "web", status: "running" }];
    },
  } as unknown as ServiceProcessManager);

  const result = await tool.execute({ action: "list" }, {});
  assert.deepEqual(result, {
    action: "list",
    services: [{ id: "s-1", name: "web", status: "running" }],
  });
});

test("service tool maps not-found errors", async () => {
  const tool = createServiceTool("/workspace", "workspace_sandbox", {
    status() {
      throw new Error("SERVICE_NOT_FOUND");
    },
  } as unknown as ServiceProcessManager);

  await assert.rejects(
    tool.execute({ action: "status", id: "missing" }, {}),
    (error: unknown) =>
      error instanceof ToolExecutionError && error.code === "SERVICE_NOT_FOUND",
  );
});

test("service tool rejects cwd outside the workspace", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agent-service-tool-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const tool = createServiceTool(workspace, "workspace_sandbox", {
    start() {
      throw new Error("should not be called");
    },
  } as unknown as ServiceProcessManager);

  await assert.rejects(
    tool.execute(
      { action: "start", command: "true", cwd: "/" },
      {},
    ),
    (error: unknown) =>
      error instanceof ToolExecutionError && error.code === "PATH_OUTSIDE_WORKSPACE",
  );
});
