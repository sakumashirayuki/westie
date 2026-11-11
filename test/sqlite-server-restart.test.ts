import assert from "node:assert/strict";
import { HostSandboxRunner } from "../src/sandbox/host-sandbox-runner.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import test from "node:test";

import type {
  LlmProvider,
  ProviderRequest,
} from "../src/provider-protocol.js";
import { ConversationRunService } from "../src/application/conversation-run-service.js";
import { ConversationService } from "../src/application/conversation-service.js";
import { createProjectServices } from "../src/application/project-services.js";
import { InMemoryInteractionBroker } from "../src/application/interaction-broker.js";
import { RunRegistry } from "../src/application/run-registry.js";
import { AgentController } from "../src/http/agent-controller.js";
import { WorkspaceProjectsRoutes } from "../src/http/workspace-projects-route.js";
import {
  initializeSqliteSchema,
  openSqliteDatabase,
  SQLiteConversationStore,
} from "../src/infrastructure/sqlite/index.js";
import { SQLiteWorktreeOperationStore } from "../src/infrastructure/sqlite/worktree-operation-store.js";
import { createAgentServer } from "../src/server.js";
import {
  finalTurn,
  providerFromTurnFactory,
} from "./support/provider.js";

const providerCapacity = {
  contextWindowTokens: 64_000,
  maxOutputTokens: 4_000,
} as const;

test("HTTP conversations survive a SQLite-backed server restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-server-restart-"));
  const databasePath = join(directory, "agent.sqlite");
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot);
  let conversationId = "";
  try {
    const first = createPersistentServer(
      databasePath,
      workspaceRoot,
      providerFromTurnFactory(
        () => finalTurn("first answer"),
        providerCapacity,
      ),
    );
    const firstBaseUrl = await listen(first.server);
    try {
      const inspectionResponse = await fetch(
        `${firstBaseUrl}/v1/agent/conversations:select-workspace`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "inspect" }),
        },
      );
      assert.equal(inspectionResponse.status, 200);
      const { selectionToken } = await inspectionResponse.json() as { selectionToken: string };
      const createResponse = await fetch(
        `${firstBaseUrl}/v1/agent/conversations:open`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            selectionToken,
            executionMode: "workspace_sandbox",
            workspace: { kind: "selected_directory" },
          }),
        },
      );
      assert.equal(createResponse.status, 201);
      conversationId = String((await createResponse.json() as { id: string }).id);

      const runResponse = await fetch(
        `${firstBaseUrl}/v1/agent/conversations/${conversationId}/runs:stream`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: "first question" }),
        },
      );
      assert.equal(runResponse.status, 200);
      assert.match(await runResponse.text(), /run\.completed/);
    } finally {
      await close(first.server);
      first.store.close();
    }

    let secondRequest: ProviderRequest | undefined;
    const secondProvider = providerFromTurnFactory(
      (request) => {
        secondRequest = request;
        return finalTurn("second answer");
      },
      providerCapacity,
    );
    const second = createPersistentServer(
      databasePath,
      workspaceRoot,
      secondProvider,
    );
    const secondBaseUrl = await listen(second.server);
    try {
      const persistedResponse = await fetch(
        `${secondBaseUrl}/v1/agent/conversations/${conversationId}`,
      );
      assert.equal(persistedResponse.status, 200);
      const persisted = await persistedResponse.json() as {
        turns: Array<{ assistantMessage?: string }>;
      };
      assert.equal(persisted.turns[0]?.assistantMessage, "first answer");

      const runResponse = await fetch(
        `${secondBaseUrl}/v1/agent/conversations/${conversationId}/runs:stream`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: "second question" }),
        },
      );
      assert.equal(runResponse.status, 200);
      await runResponse.text();
      assert.deepEqual(
        secondRequest?.transcript,
        [
          { role: "user", content: "first question" },
          { role: "assistant", content: "first answer" },
          { role: "user", content: "second question" },
        ],
      );
    } finally {
      await close(second.server);
      second.store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function createPersistentServer(
  databasePath: string,
  workspaceRoot: string,
  provider: LlmProvider,
): {
  readonly server: Server;
  readonly store: SQLiteConversationStore;
} {
  const database = openSqliteDatabase(databasePath);
  initializeSqliteSchema(database);
  const store = new SQLiteConversationStore(database);
  store.recoverStaleRuns();
  const conversationService = new ConversationService(store);
  const workspaceRuntimeProvider = {
    async get(
      requestedRoot: string,
      executionMode: "workspace_sandbox" | "full_access",
    ) {
      return { workspaceRoot: requestedRoot, executionMode, sandboxRunner: new HostSandboxRunner(), tools: [] };
    },
  };
  const conversationRunService = new ConversationRunService({
    provider,
    conversationStore: store,
    loadWorkspaceInstructions: async () => undefined,
    workspaceRuntimeProvider,
  });
  const worktreeOperations = new SQLiteWorktreeOperationStore(database);
  const projectServices = createProjectServices({
    conversationStore: store,
    workspaceRuntimeProvider,
    worktreeOperations,
  });
  const hostDirectoryPicker = {
    async pickDirectory() {
      return { status: "selected" as const, path: workspaceRoot };
    },
  };
  const conversationOpenService = projectServices.createOpenService(conversationService);
  const workspaceProjectsRoutes = new WorkspaceProjectsRoutes({
    conversationService,
    conversationOpenService,
    selectionTokens: projectServices.selectionTokens,
    projectInspection: projectServices.projectInspection,
    git: projectServices.git,
    hostDirectoryPicker,
    fullAccessAvailable: true,
  });
  const controller = new AgentController({
    conversationService,
    conversationRunService,
    registry: new RunRegistry({ runService: conversationRunService }),
    interactionBroker: new InMemoryInteractionBroker(),
    workspaceProjectsRoutes,
    conversationOpenService,
  });
  return {
    store,
    server: createAgentServer(controller),
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
