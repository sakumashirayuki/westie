import assert from "node:assert/strict";
import { HostSandboxRunner } from "../src/sandbox/host-sandbox-runner.js";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { request as httpRequest, IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import { Writable } from "node:stream";
import test from "node:test";

import type {
  LlmProvider,
  ProviderRequest,
  ProviderTurn,
} from "../src/provider-protocol.js";
import type { AgentEvent } from "../src/agent-events.js";
import { MAX_STEERING_MESSAGE_BYTES } from "../src/protocol.js";
import { ConversationRunService } from "../src/application/conversation-run-service.js";
import { ConversationService } from "../src/application/conversation-service.js";
import { createProjectServices } from "../src/application/project-services.js";
import type { ConversationStore } from "../src/application/conversation-store.js";
import {
  InMemoryInteractionBroker,
  type InteractionBroker,
} from "../src/application/interaction-broker.js";
import {
  InMemoryWorkspaceGrantStore,
  type WorkspaceGrantStore,
} from "../src/application/workspace-grant-store.js";
import { InMemoryToolGrantStore } from "../src/application/tool-grant-store.js";
import { RunSteeringQueue } from "../src/application/run-steering-queue.js";
import { RunRegistry } from "../src/application/run-registry.js";
import { LarkBindingTokenStore } from "../src/application/lark-binding-token-store.js";
import { LarkBindingRoutes } from "../src/http/lark-binding-routes.js";
import type { WorkspaceRuntimeProvider } from "../src/application/workspace-runtime.js";
import { AgentController } from "../src/http/agent-controller.js";
import { WorkspaceProjectsRoutes } from "../src/http/workspace-projects-route.js";
import { watchClientDisconnect } from "../src/http/client-disconnect.js";
import type {
  HostDirectoryPicker,
  HostFilePicker,
  HostFilePickerResult,
} from "../src/infrastructure/host-file-picker.js";
import {
  initializeSqliteSchema,
  LarkBindingStore,
  openSqliteDatabase,
  SQLiteConversationStore,
} from "../src/infrastructure/sqlite/index.js";
import { SQLiteWorktreeOperationStore } from "../src/infrastructure/sqlite/worktree-operation-store.js";
import {
  createAgentServer as createConfiguredAgentServer,
  writeWithBackpressure,
} from "../src/server.js";
import {
  allowAllToolPermissionPolicy,
  AuthorizedToolExecutor,
  createDefaultToolPermissionPolicy,
  type ToolAuditSink,
  type ToolPermissionPolicy,
} from "../src/tool-permissions.js";
import { defineTool, type Tool } from "../src/tools.js";
import {
  validateTranscriptBatches,
  type TranscriptMessage,
} from "../src/transcript.js";
import {
  finalTurn,
  providerFromTurnFactory,
  providerReturning,
  streamTurn,
  toolCallTurn,
} from "./support/provider.js";
import { z } from "zod";

interface TestAgentServerOptions {
  readonly provider: LlmProvider;
  readonly conversationStore?: ConversationStore;
  readonly tools?: readonly Tool[];
  readonly allowedOrigin?: string;
  readonly staticDirectory?: string;
  readonly interactionBroker?: InteractionBroker;
  readonly interactionTimeoutMs?: number;
  readonly toolPermissionPolicy?: ToolPermissionPolicy;
  readonly workspaceRoot?: string;
  readonly toolAuditSink?: ToolAuditSink;
  readonly workspaceGrantStore?: WorkspaceGrantStore;
  readonly hostFilePicker?: HostFilePicker;
  readonly hostDirectoryPicker?: HostDirectoryPicker;
  readonly workspaceRuntimeProvider?: WorkspaceRuntimeProvider;
  readonly disableWorkspaceSelection?: boolean;
  readonly fullAccessAvailable?: boolean;
  readonly loadWorkspaceInstructions?: (
    canonicalWorkspaceRoot: string,
  ) => Promise<string | undefined>;
  readonly runRegistry?: RunRegistry;
}

function createAgentServer(options: TestAgentServerOptions) {
  const provider: LlmProvider = {
    model: "test-model",
    contextWindowTokens:
      options.provider.contextWindowTokens ?? 64_000,
    maxOutputTokens: options.provider.maxOutputTokens ?? 4_000,
    stream: (request) => options.provider.stream(request),
  };
  const database =
    options.conversationStore === undefined
      ? openSqliteDatabase(":memory:")
      : undefined;
  if (database !== undefined) initializeSqliteSchema(database);
  const conversationStore =
    options.conversationStore ?? new SQLiteConversationStore(database!);
  const defaultWorkspaceRoot = options.workspaceRoot ?? process.cwd();
  const interactionBroker =
    options.interactionBroker ?? new InMemoryInteractionBroker();
  const workspaceGrantStore =
    options.workspaceGrantStore ?? new InMemoryWorkspaceGrantStore();
  const toolGrantStore = new InMemoryToolGrantStore();
  const steeringQueue = new RunSteeringQueue();
  const authorizedToolExecutor = new AuthorizedToolExecutor({
    policy:
      options.toolPermissionPolicy ?? createDefaultToolPermissionPolicy(),
    interactionBroker,
    interactionTimeoutMs: options.interactionTimeoutMs,
    auditSink: options.toolAuditSink,
    workspaceGrantStore,
    toolGrantStore,
  });
  const conversationRuntimeProvider: WorkspaceRuntimeProvider =
    options.workspaceRuntimeProvider ?? {
      async get(workspaceRoot, executionMode) {
        if (workspaceRoot !== defaultWorkspaceRoot) {
          throw new Error("No runtime is configured for this workspace.");
        }
        return { workspaceRoot, executionMode, sandboxRunner: new HostSandboxRunner(), tools: options.tools ?? [] };
      },
    };
  const conversationService = new ConversationService(conversationStore, {
    toolGrantStore,
  });
  const operationDatabase = database ?? openSqliteDatabase(":memory:");
  if (database === undefined) initializeSqliteSchema(operationDatabase);
  const projectServices = createProjectServices({
    conversationStore,
    workspaceRuntimeProvider: conversationRuntimeProvider,
    worktreeOperations: new SQLiteWorktreeOperationStore(operationDatabase),
  });
  const conversationOpenService = projectServices.createOpenService(
    conversationService,
  );
  const conversationRunService = new ConversationRunService({
    provider,
    conversationStore,
    authorizedToolExecutor,
    workspaceRuntimeProvider: conversationRuntimeProvider,
    loadWorkspaceInstructions:
      options.loadWorkspaceInstructions ?? (async () => undefined),
    steeringSource: (runId) => ({
      async take(step) {
        return steeringQueue.take(runId, step);
      },
    }),
  });
  const runRegistry = options.runRegistry ?? new RunRegistry({
    runService: conversationRunService,
  });
  const larkBindingStore = new LarkBindingStore(operationDatabase);
  const controller = new AgentController({
    conversationService,
    conversationRunService,
    registry: runRegistry,
    interactionBroker,
    steeringQueue,
    getActiveRunId: (conversationId) =>
      conversationStore.getActiveRunId(conversationId),
    hostFilePicker: options.hostFilePicker,
    allowedOrigin: options.allowedOrigin,
    fullAccessAvailable: options.fullAccessAvailable ?? true,
    staticDirectory: options.staticDirectory,
    conversationOpenService,
    workspaceProjectsRoutes: new WorkspaceProjectsRoutes({
      conversationService,
      conversationOpenService,
      selectionTokens: projectServices.selectionTokens,
      projectInspection: projectServices.projectInspection,
      git: projectServices.git,
      hostDirectoryPicker: options.disableWorkspaceSelection === true
        ? undefined
        : options.hostDirectoryPicker ?? {
            async pickDirectory() {
              return { status: "selected", path: defaultWorkspaceRoot };
            },
          },
      allowedOrigin: options.allowedOrigin,
      fullAccessAvailable: options.fullAccessAvailable ?? true,
    }),
    larkBindingRoutes: new LarkBindingRoutes({
      bindingStore: larkBindingStore,
      tokenStore: new LarkBindingTokenStore(),
      conversationService,
      bridgeEnabled: true,
    }),
    larkBindingStore,
  });
  const server = createConfiguredAgentServer(controller);
  if (database !== undefined) {
    server.once("close", () => {
      if (database.isOpen) database.close();
    });
  } else {
    server.once("close", () => {
      if (operationDatabase.isOpen) operationDatabase.close();
    });
  }
  return server;
}

const finalStep = finalTurn;
const toolStep = toolCallTurn;

async function createConversationRunUrl(origin: string): Promise<string> {
  const inspected = await fetch(
    `${origin}/v1/agent/conversations:select-workspace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "inspect" }),
    });
  assert.equal(inspected.status, 200);
  const selection = await inspected.json() as { selectionToken: string };
  const response = await fetch(`${origin}/v1/agent/conversations:open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      selectionToken: selection.selectionToken,
      executionMode: "workspace_sandbox",
      workspace: { kind: "selected_directory" },
    }),
  });
  assert.equal(response.status, 201);
  const conversation = await response.json() as { id: string };
  return `${origin}/v1/agent/conversations/${
    encodeURIComponent(conversation.id)
  }/runs:stream`;
}

test("POST SSE delivers an answer delta before the provider completes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let providerFinished = false;
  const provider: LlmProvider = {
    model: "test-model",
    async *stream() {
      yield { type: "output_text.delta", text: "he" } as const;
      await gate;
      yield { type: "output_text.delta", text: "llo" } as const;
      yield { type: "completed", turn: finalStep("hello") } as const;
      providerFinished = true;
    },
  };
  const server = createAgentServer({ provider, allowedOrigin: "http://localhost:5173" });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const runUrl = await createConversationRunUrl(
      `http://127.0.0.1:${port}`,
    );
    const response = await fetch(
      runUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:5173",
        },
        body: JSON.stringify({ input: "hi" }),
      },
    );

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      "http://localhost:5173",
    );

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    while (!body.includes("event: answer.delta")) {
      const result = await reader.read();
      assert.equal(result.done, false);
      body += decoder.decode(result.value, { stream: true });
    }
    assert.equal(providerFinished, false);
    assert.doesNotMatch(body, /event: run\.completed/);

    release();
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      body += decoder.decode(result.value, { stream: true });
    }
    body += decoder.decode();

    const events = parseSseEvents(body);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "run.started",
        "step.started",
        "answer.delta",
        "answer.delta",
        "step.completed",
        "answer.completed",
        "run.completed",
      ],
    );
    assert.equal(
      events
        .filter((event) => event.type === "answer.delta")
        .map((event) => event.data.text)
        .join(""),
      "hello",
    );
    assert.deepEqual(
      events.map((event) => event.seq),
      [1, 2, 3, 4, 5, 6, 7],
    );
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "run.completed");
    assert.equal(terminal?.type === "run.completed" ? terminal.data.steps : 0, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("rejects invalid run requests before starting SSE", async () => {
  const provider = providerReturning("unused");
  const server = createAgentServer({ provider });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    const runUrl = await createConversationRunUrl(origin);
    const response = await fetch(
      runUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "", maxSteps: 0 }),
      },
    );

    assert.equal(response.status, 422);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);

    const bodyUnknownField = await fetch(
      runUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "hi", unexpected: true }),
      },
    );
    assert.equal(bodyUnknownField.status, 422);

    const atStepLimit = await fetch(
      runUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "hi", maxSteps: 512 }),
      },
    );
    assert.equal(atStepLimit.status, 200);
    await atStepLimit.text();

    const overSystemLimits = await fetch(
      runUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: "hi",
          maxSteps: 513,
        }),
      },
    );
    assert.equal(overSystemLimits.status, 422);

    const removedStatelessRoute = await fetch(
      `${origin}/v1/agent/runs:stream`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "hi" }),
      },
    );
    assert.equal(removedStatelessRoute.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("serves the web entry point and static assets from the configured directory", async () => {
  const staticDirectory = await mkdtemp(join(tmpdir(), "agent-web-"));
  await mkdir(join(staticDirectory, "assets"));
  await writeFile(join(staticDirectory, "index.html"), "<main>Agent UI</main>");
  await writeFile(
    join(staticDirectory, "assets", "app.js"),
    "console.log('ready');",
  );
  await writeFile(join(staticDirectory, "assets", "app.css"), "main {}\n");

  const provider = providerReturning("unused");
  const server = createAgentServer({ provider, staticDirectory });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const entry = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(entry.status, 200);
    assert.match(entry.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(await entry.text(), "<main>Agent UI</main>");

    const asset = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /^text\/javascript/);
    assert.equal(await asset.text(), "console.log('ready');");

    const stylesheet = await fetch(
      `http://127.0.0.1:${port}/assets/app.css`,
    );
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get("content-type") ?? "", /^text\/css/);

    const conversationRoute = await fetch(
      `http://127.0.0.1:${port}/conversations/conversation-1`,
      { headers: { Accept: "text/html" } },
    );
    assert.equal(conversationRoute.status, 200);
    assert.equal(await conversationRoute.text(), "<main>Agent UI</main>");

    const missing = await fetch(
      `http://127.0.0.1:${port}/assets/missing.js`,
      { headers: { Accept: "text/javascript" } },
    );
    assert.equal(missing.status, 404);

    const unknownApi = await fetch(
      `http://127.0.0.1:${port}/v1/unknown`,
      { headers: { Accept: "text/html" } },
    );
    assert.equal(unknownApi.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    await rm(staticDirectory, { recursive: true });
  }
});

test("does not serve files outside the configured static directory", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agent-web-boundary-"));
  const staticDirectory = join(temporaryDirectory, "public");
  const outsideFile = join(temporaryDirectory, "secret.txt");
  await mkdir(staticDirectory);
  await writeFile(join(staticDirectory, "index.html"), "entry");
  await writeFile(outsideFile, "secret");
  await symlink(outsideFile, join(staticDirectory, "linked.txt"));

  const provider = providerReturning("unused");
  const server = createAgentServer({ provider, staticDirectory });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const traversal = await fetch(
      `http://127.0.0.1:${port}/%2e%2e%2fsecret.txt`,
    );
    assert.equal(traversal.status, 404);

    const linked = await fetch(`http://127.0.0.1:${port}/linked.txt`);
    assert.equal(linked.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    await rm(temporaryDirectory, { recursive: true });
  }
});

test("sends one run.error and then closes cleanly on business failure", async () => {
  const provider: LlmProvider = {
    model: "test-model",
    async *stream() {
      throw new Error("provider failed");
    },
  };
  const server = createAgentServer({ provider });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const runUrl = await createConversationRunUrl(
      `http://127.0.0.1:${port}`,
    );
    const response = await fetch(
      runUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "hi" }),
      },
    );
    const body = await response.text();
    const events = parseSseEvents(body);

    assert.deepEqual(
      events.map((event) => event.type),
      ["run.started", "step.started", "run.error"],
    );
    assert.equal(events.filter((event) => event.type === "run.error").length, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("client disconnect does not abort the running provider stream", async () => {
  // 断开连接后 provider 流不被 abort，Run 继续跑完并以 completed 落库。
  const provider: LlmProvider = {
    model: "test-model",
    async *stream(request: ProviderRequest) {
      yield { type: "output_text.delta", text: "partial" } as const;
      void request.signal;
      yield { type: "output_text.delta", text: "done" } as const;
      yield { type: "completed", turn: finalStep("partialdone") } as const;
    },
  };
  const server = createAgentServer({ provider });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const controller = new AbortController();
    const origin = `http://127.0.0.1:${port}`;
    const runUrl = await createConversationRunUrl(origin);
    const conversationId = decodeURIComponent(
      runUrl.split("/conversations/")[1]!.split("/runs")[0]!,
    );
    const response = await fetch(
      runUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "hi" }),
        signal: controller.signal,
      },
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    while (!body.includes("event: run.started")) {
      const result = await reader.read();
      assert.equal(result.done, false);
      body += decoder.decode(result.value, { stream: true });
    }
    const runId = parseSseEvents(body)[0]!.runId;
    controller.abort();

    const resumed = await fetch(
      `${origin}/v1/agent/conversations/${conversationId}/runs/${runId}/events`,
      { method: "GET" },
    );
    assert.equal(resumed.status, 200);
    const resumedEvents = parseSseEvents(await resumed.text());
    assert.equal(resumedEvents.at(-1)?.type, "run.completed");

    const detail = await fetch(
      `${origin}/v1/agent/conversations/${conversationId}`,
    );
    const detailBody = await detail.json() as {
      turns: Array<{ status: string }>;
    };
    assert.equal(detailBody.turns.at(-1)?.status, "completed");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("conversation runs carry completed history into the next turn", async () => {
  const requests: ProviderRequest[] = [];
  const provider = providerFromTurnFactory((request) => {
      requests.push({
        ...request,
        transcript: request.transcript.map((message) => ({ ...message })),
      });
      return finalStep(`answer ${requests.length}`);
  });
  const server = createAgentServer({ provider });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    const inspected = await fetch(`${origin}/v1/agent/conversations:select-workspace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "inspect" }),
    });
    assert.equal(inspected.status, 200);
    const selection = await inspected.json() as { selectionToken: string };
    const created = await fetch(`${origin}/v1/agent/conversations:open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selectionToken: selection.selectionToken, executionMode: "workspace_sandbox", workspace: { kind: "selected_directory" } }),
    });
    assert.equal(created.status, 201);
    const conversation = await created.json() as { id: string };

    for (const input of ["first question", "second question"]) {
      const response = await fetch(
        `${origin}/v1/agent/conversations/${conversation.id}/runs:stream`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input }),
        },
      );
      assert.equal(response.status, 200);
      assert.equal(parseSseEvents(await response.text()).at(-1)?.type, "run.completed");
    }

    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].transcript, [
      { role: "user", content: "first question" },
      { role: "assistant", content: "answer 1" },
      { role: "user", content: "second question" },
    ]);

    const detail = await fetch(
      `${origin}/v1/agent/conversations/${conversation.id}`,
    );
    assert.equal(detail.status, 200);
    const body = await detail.json() as {
      turns: Array<{ status: string; assistantMessage?: string }>;
    };
    assert.deepEqual(
      body.turns.map((turn) => ({
        status: turn.status,
        assistantMessage: turn.assistantMessage,
      })),
      [
        { status: "completed", assistantMessage: "answer 1" },
        { status: "completed", assistantMessage: "answer 2" },
      ],
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("workspace selection requires an explicit workspace runtime provider", async () => {
  let pickerSignal: AbortSignal | undefined;
  const server = createAgentServer({
    provider: providerReturning("unused"),
    disableWorkspaceSelection: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/agent/conversations:select-workspace`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "inspect" }),
      },
    );

    assert.equal(response.status, 501);
    assert.deepEqual(await response.json(), {
      error: {
        code: "HOST_DIRECTORY_PICKER_UNAVAILABLE",
        message: "The host directory picker is unavailable.",
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("select-workspace rejects the removed direct-creation request", async () => {
  const server = createAgentServer({ provider: providerReturning("unused") });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/agent/conversations:select-workspace`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ executionMode: "workspace_sandbox" }),
      },
    );
    assert.equal(response.status, 422);
    assert.equal((await response.json() as { error: { code: string } }).error.code,
      "INVALID_REQUEST");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error)),
    );
  }
});

test("host directory picker creates a conversation bound to one canonical workspace", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "agent-workspace-server-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const workspace = join(parent, "project");
  const file = join(parent, "not-a-project.txt");
  await mkdir(workspace);
  await writeFile(file, "not a directory", "utf8");
  const canonicalWorkspace = await realpath(workspace);

  const selections = [
    { status: "cancelled" as const },
    { status: "selected" as const, path: file },
    { status: "selected" as const, path: workspace },
  ];
  const hostDirectoryPicker: HostDirectoryPicker = {
    async pickDirectory() {
      const selection = selections.shift();
      if (selection === undefined) throw new Error("No picker result.");
      return selection;
    },
  };
  const requestedRuntimeRoots: string[] = [];
  const requestedRuntimeModes: string[] = [];
  const workspaceRuntimeProvider: WorkspaceRuntimeProvider = {
    async get(workspaceRoot, executionMode) {
      requestedRuntimeRoots.push(workspaceRoot);
      requestedRuntimeModes.push(executionMode);
      return {
        workspaceRoot,
        executionMode,
        sandboxRunner: new HostSandboxRunner(),
        tools: [
          defineTool({
            name: "workspace_probe",
            description: "Return the bound workspace.",
            inputSchema: z.strictObject({}),
            execute() {
              return { workspaceRoot };
            },
          }),
        ],
      };
    },
  };
  let generation = 0;
  const provider = providerFromTurnFactory((request) => {
      if (generation++ === 0) {
        assert.deepEqual(
          request.tools.map((tool) => tool.name),
          ["workspace_probe", "agent", "wait_agent", "stop_agent"],
        );
        return toolStep("workspace_probe", {});
      }
      assert.match(
        JSON.stringify(request.transcript.at(-1)),
        new RegExp(canonicalWorkspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      return finalStep("workspace confirmed");
  });
  const server = createAgentServer({
    provider,
    hostDirectoryPicker,
    workspaceRuntimeProvider,
    toolPermissionPolicy: allowAllToolPermissionPolicy,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    const selectUrl =
      `${origin}/v1/agent/conversations:select-workspace`;

    const untrusted = await fetch(selectUrl, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    assert.equal(untrusted.status, 403);
    assert.equal(
      (await untrusted.json() as { error: { code: string } }).error.code,
      "UNTRUSTED_ORIGIN",
    );
    assert.equal(selections.length, 3);

    const selectRequest = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "inspect" }),
    } as const;
    const cancelled = await fetch(selectUrl, selectRequest);
    assert.equal(cancelled.status, 409);
    assert.equal(
      (await cancelled.json() as { error: { code: string } }).error.code,
      "HOST_DIRECTORY_PICKER_CANCELLED",
    );

    const invalid = await fetch(selectUrl, selectRequest);
    assert.equal(invalid.status, 409);
    assert.equal(
      (await invalid.json() as { error: { code: string } }).error.code,
      "WORKSPACE_SELECTION_INVALID",
    );
    assert.deepEqual(requestedRuntimeRoots, []);

    const selected = await fetch(selectUrl, selectRequest);
    assert.equal(selected.status, 200);
    const selection = await selected.json() as { selectionToken: string };
    const opened = await fetch(`${origin}/v1/agent/conversations:open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selectionToken: selection.selectionToken,
        executionMode: "workspace_sandbox",
        workspace: { kind: "selected_directory" },
      }),
    });
    assert.equal(opened.status, 201);
    const conversation = await opened.json() as {
      id: string;
      workspace: { name: string; canonicalPath: string };
    };
    assert.deepEqual(conversation.workspace, {
      name: "project",
      canonicalPath: canonicalWorkspace,
    });
    assert.deepEqual(requestedRuntimeRoots, [canonicalWorkspace]);
    assert.deepEqual(requestedRuntimeModes, ["workspace_sandbox"]);

    const rejectedOverride = await fetch(
      `${origin}/v1/agent/conversations/${conversation.id}/runs:stream`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: "probe",
          workspaceRoot: "/tmp/other",
        }),
      },
    );
    assert.equal(rejectedOverride.status, 422);

    const run = await fetch(
      `${origin}/v1/agent/conversations/${conversation.id}/runs:stream`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "probe" }),
      },
    );
    assert.equal(run.status, 200);
    assert.equal(
      parseSseEvents(await run.text()).at(-1)?.type,
      "run.completed",
    );
    assert.deepEqual(requestedRuntimeRoots, [
      canonicalWorkspace,
      canonicalWorkspace,
    ]);
    assert.deepEqual(requestedRuntimeModes, [
      "workspace_sandbox",
      "workspace_sandbox",
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("full access creation and runs require loopback and a trusted origin", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agent-full-access-server-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let executions = 0;
  let generation = 0;
  const bash = defineTool({
    name: "bash",
    description: "Test shell.",
    inputSchema: z.strictObject({}),
    execute() {
      executions += 1;
      return { ok: true };
    },
  });
  const workspaceRuntimeProvider: WorkspaceRuntimeProvider = {
    async get(workspaceRoot, executionMode) {
      return { workspaceRoot, executionMode, sandboxRunner: new HostSandboxRunner(), tools: [bash] };
    },
  };
  const server = createAgentServer({
    provider: providerFromTurnFactory(() =>
      generation++ === 0 ? toolStep("bash", {}) : finalStep("done")
    ),
    workspaceRoot: workspace,
    workspaceRuntimeProvider,
    hostDirectoryPicker: {
      async pickDirectory() {
        return { status: "selected", path: workspace };
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error))
    )
  );
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const selectUrl = `${origin}/v1/agent/conversations:select-workspace`;

  const untrusted = await fetch(selectUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://evil.example",
    },
    body: JSON.stringify({ action: "inspect" }),
  });
  assert.equal(untrusted.status, 403);
  assert.equal(
    (await untrusted.json() as { error: { code: string } }).error.code,
    "UNTRUSTED_ORIGIN",
  );

  const inspected = await fetch(selectUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "inspect" }),
  });
  assert.equal(inspected.status, 200);
  const selection = await inspected.json() as { selectionToken: string };
  const created = await fetch(`${origin}/v1/agent/conversations:open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      selectionToken: selection.selectionToken,
      executionMode: "full_access",
      workspace: { kind: "selected_directory" },
    }),
  });
  assert.equal(created.status, 201);
  const conversation = await created.json() as {
    id: string;
    executionMode: string;
  };
  assert.equal(conversation.executionMode, "full_access");

  const runUrl = `${origin}/v1/agent/conversations/${conversation.id}/runs:stream`;
  const rejectedRun = await fetch(runUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://evil.example",
    },
    body: JSON.stringify({ input: "run" }),
  });
  assert.equal(rejectedRun.status, 403);

  const run = await fetch(runUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "run" }),
  });
  assert.equal(run.status, 200);
  assert.equal(parseSseEvents(await run.text()).at(-1)?.type, "run.completed");
  assert.equal(executions, 1);
});

test("full access is unavailable when the server is not loopback-bound", async () => {
  const server = createAgentServer({
    provider: providerReturning("unused"),
    fullAccessAvailable: false,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const inspect = await fetch(
      `http://127.0.0.1:${port}/v1/agent/conversations:select-workspace`,
      { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "inspect" }) },
    );
    assert.equal(inspect.status, 200);
    const selection = await inspect.json() as { selectionToken: string };
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/agent/conversations:open`,
      { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ selectionToken: selection.selectionToken,
          executionMode: "full_access", workspace: { kind: "selected_directory" } }) },
    );
    assert.equal(response.status, 403);
    assert.equal(
      (await response.json() as { error: { code: string } }).error.code,
      "FULL_ACCESS_REQUIRES_LOOPBACK",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error))
    );
  }
});

test("an existing full access conversation cannot run after a non-loopback restart", async (t) => {
  const database = openSqliteDatabase(":memory:");
  initializeSqliteSchema(database);
  const store = new SQLiteConversationStore(database);
  t.after(() => store.close());
  const conversation = store.createConversation(process.cwd(), "full_access");
  const server = createAgentServer({
    conversationStore: store,
    provider: providerReturning("must not run"),
    fullAccessAvailable: false,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/agent/conversations/${conversation.id}/runs:stream`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "run" }),
      },
    );
    assert.equal(response.status, 403);
    assert.equal(
      (await response.json() as { error: { code: string } }).error.code,
      "FULL_ACCESS_REQUIRES_LOOPBACK",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error))
    );
  }
});

test("cancel route enforces the same full-access gate as runs:stream", async (t) => {
  const database = openSqliteDatabase(":memory:");
  initializeSqliteSchema(database);
  const store = new SQLiteConversationStore(database);
  t.after(() => store.close());
  const conversation = store.createConversation(process.cwd(), "full_access");
  const server = createAgentServer({
    conversationStore: store,
    provider: providerReturning("must not run"),
    fullAccessAvailable: false,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/agent/conversations/${conversation.id}/runs/run-1:cancel`,
      { method: "POST" },
    );
    assert.equal(response.status, 403);
    assert.equal(
      (await response.json() as { error: { code: string } }).error.code,
      "FULL_ACCESS_REQUIRES_LOOPBACK",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error))
    );
  }
});

test("disconnect during directory inspection aborts the picker without creating a conversation", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "agent-workspace-abort-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let pickerSignal: AbortSignal | undefined;
  const database = openSqliteDatabase(":memory:");
  initializeSqliteSchema(database);
  const store = new SQLiteConversationStore(database);
  t.after(() => store.close());
  const server = createAgentServer({
    conversationStore: store,
    provider: providerReturning("unused"),
    hostDirectoryPicker: {
      async pickDirectory(signal) {
        if (signal === undefined) throw new Error("Expected picker signal.");
        pickerSignal = signal;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        );
        return { status: "selected", path: workspace };
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const request = httpRequest(
      `http://127.0.0.1:${port}/v1/agent/conversations:select-workspace`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
      },
    );
    request.on("error", () => {});
    request.end(JSON.stringify({ action: "inspect" }));
    while (pickerSignal === undefined) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    request.destroy();
    await new Promise<void>((resolve) =>
      pickerSignal!.addEventListener("abort", () => resolve(), { once: true })
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(
      database.prepare(
        "SELECT COUNT(*) AS count FROM conversations",
      ).get()?.count,
      0,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("rejects a concurrent run before opening SSE", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = providerFromTurnFactory(async () => {
      await gate;
      return finalStep("done");
  });
  const server = createAgentServer({ provider });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    const runUrl = await createConversationRunUrl(origin);
    const first = await fetch(runUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "first" }),
    });
    assert.equal(first.status, 200);

    const second = await fetch(runUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "second" }),
    });
    assert.equal(second.status, 409);
    assert.match(
      second.headers.get("content-type") ?? "",
      /^application\/json/,
    );

    release();
    assert.equal(parseSseEvents(await first.text()).at(-1)?.type, "run.completed");
  } finally {
    release?.();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("responding to an interaction resumes the same SSE run and executes bash once", async () => {
  let executionCount = 0;
  const bash = defineTool({
    name: "bash",
    description: "Test bash.",
    impact: "Runs one test command.",
    inputSchema: z.strictObject({ command: z.string() }),
    summarizeInput(input) {
      return { ...input, cwd: "/workspace", timeoutMs: 30_000 };
    },
    execute() {
      executionCount += 1;
      return { executionCount };
    },
  });
  const responses: ProviderTurn[] = [
    toolStep("bash", { command: "pwd" }),
    finalStep("done"),
  ];
  const provider = providerFromTurnFactory(() => {
      const response = responses.shift();
      if (response === undefined) throw new Error("No response.");
      return response;
  });
  const broker = new InMemoryInteractionBroker();
  const server = createAgentServer({
    provider,
    tools: [bash],
    interactionBroker: broker,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    const runUrl = await createConversationRunUrl(origin);
    const response = await fetch(runUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "run pwd" }),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    while (!body.includes("event: interaction.required")) {
      const next = await reader.read();
      assert.equal(next.done, false);
      body += decoder.decode(next.value, { stream: true });
    }
    const required = parseSseEvents(body).find(
      (event) => event.type === "interaction.required",
    );
    assert.equal(required?.type, "interaction.required");
    assert.equal(executionCount, 0);
    assert.equal(broker.pendingCount, 1);
    if (required?.type !== "interaction.required") {
      assert.fail("Expected interaction.required.");
    }

    const approval = await fetch(
      `${origin}/v1/agent/interactions/${required.interactionId}:respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: { decision: "approve" } }),
      },
    );
    assert.equal(approval.status, 200);

    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      body += decoder.decode(next.value, { stream: true });
    }
    body += decoder.decode();
    const events = parseSseEvents(body);

    assert.equal(executionCount, 1);
    assert.equal(broker.pendingCount, 0);
    assert.deepEqual(
      events
        .filter((event) =>
          [
            "interaction.required",
            "interaction.resolved",
            "tool.started",
            "tool.completed",
          ].includes(event.type),
        )
        .map((event) => event.type),
      [
        "interaction.required",
        "interaction.resolved",
        "tool.started",
        "tool.completed",
      ],
    );
    assert.equal(events.at(-1)?.type, "run.completed");

    const retry = await fetch(
      `${origin}/v1/agent/interactions/${required.interactionId}:respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: { decision: "approve" } }),
      },
    );
    assert.equal(retry.status, 200);
    const conflict = await fetch(
      `${origin}/v1/agent/interactions/${required.interactionId}:respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: { decision: "deny" } }),
      },
    );
    assert.equal(conflict.status, 409);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("cancelling while awaiting approval closes the transcript into valid batches", async (t) => {
  const database = openSqliteDatabase(":memory:");
  initializeSqliteSchema(database);
  const store = new SQLiteConversationStore(database);
  t.after(() => store.close());
  const bash = defineTool({
    name: "bash",
    description: "Test bash.",
    impact: "Runs one test command.",
    inputSchema: z.strictObject({ command: z.string() }),
    summarizeInput(input) {
      return { ...input, cwd: "/workspace", timeoutMs: 30_000 };
    },
    execute() {
      return { ok: true };
    },
  });
  const responses: ProviderTurn[] = [toolStep("bash", { command: "pwd" })];
  const provider = providerFromTurnFactory(() => {
    const response = responses.shift();
    if (response === undefined) throw new Error("No response.");
    return response;
  });
  const broker = new InMemoryInteractionBroker();
  const server = createAgentServer({
    conversationStore: store,
    provider,
    tools: [bash],
    interactionBroker: broker,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    const runUrl = await createConversationRunUrl(origin);
    const conversationId = decodeURIComponent(
      runUrl.split("/conversations/")[1]!.split("/runs")[0]!,
    );
    const response = await fetch(runUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "run pwd" }),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    while (!body.includes("event: interaction.required")) {
      const next = await reader.read();
      assert.equal(next.done, false);
      body += decoder.decode(next.value, { stream: true });
    }
    const runId = parseSseEvents(body)[0]!.runId;

    // 等待审批期间取消。
    const cancel = await fetch(
      `${origin}/v1/agent/conversations/${conversationId}/runs/${runId}:cancel`,
      { method: "POST" },
    );
    assert.equal(cancel.status, 202);

    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      body += decoder.decode(next.value, { stream: true });
    }
    const events = parseSseEvents(body);
    assert.equal(events.at(-1)?.type, "run.cancelled");

    // 落库的 transcript 满足批次校验（工具批次被补齐）。
    const transcript = store.loadConversationTranscript(conversationId);
    assert.doesNotThrow(() => validateTranscriptBatches(transcript));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("interaction response route validates requests and reports unknown ids", async () => {
  const provider = providerReturning("unused");
  const server = createAgentServer({ provider });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const url =
      `http://127.0.0.1:${port}/v1/agent/interactions/missing:respond`;
    assert.equal((await fetch(url)).status, 405);
    assert.equal(
      (await fetch(url, { method: "POST", body: "{}" })).status,
      415,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ response: { decision: "later" } }),
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ response: { decision: "approve" } }),
        })
      ).status,
      404,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("host file picker keeps workspace grant pending until the exact file is selected", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-picker-server-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requestedPath = join(directory, "requested.txt");
  const otherPath = join(directory, "other.txt");
  await writeFile(requestedPath, "requested", "utf8");
  await writeFile(otherPath, "other", "utf8");
  const canonicalRequestedPath = await realpath(requestedPath);

  const selections: HostFilePickerResult[] = [
    { status: "cancelled" },
    { status: "selected", path: otherPath },
    { status: "selected", path: requestedPath },
  ];
  const hostFilePicker: HostFilePicker = {
    async pickFile() {
      const selection = selections.shift();
      if (selection === undefined) throw new Error("No picker result.");
      return selection;
    },
  };
  const broker = new InMemoryInteractionBroker();
  const pending = broker.create({
    kind: "workspace_grant",
    reason: "outside_workspace",
    runId: "run-1",
    step: 1,
    toolCallId: "run-1:tool:1",
    toolName: "read",
    conversationId: "conversation-1",
    requestedPath: canonicalRequestedPath,
    canonicalPath: canonicalRequestedPath,
    access: "read",
    scope: "once",
  });
  const provider = providerReturning("unused");
  const server = createAgentServer({
    provider,
    interactionBroker: broker,
    hostFilePicker,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const base =
      `http://127.0.0.1:${port}/v1/agent/interactions/${pending.interactionId}`;

    const directApproval = await fetch(`${base}:respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: { decision: "approve" } }),
    });
    assert.equal(directApproval.status, 422);
    assert.equal(broker.pendingCount, 1);

    const cancelled = await fetch(`${base}:select-file`, { method: "POST" });
    assert.equal(cancelled.status, 409);
    assert.deepEqual(await cancelled.json(), {
      error: {
        code: "HOST_FILE_PICKER_CANCELLED",
        message: "File selection was cancelled.",
        retryable: true,
      },
    });
    assert.equal(broker.pendingCount, 1);

    const mismatch = await fetch(`${base}:select-file`, { method: "POST" });
    assert.equal(mismatch.status, 409);
    assert.deepEqual(await mismatch.json(), {
      error: {
        code: "WORKSPACE_GRANT_SELECTION_MISMATCH",
        message: "Selected file does not match the requested file.",
        retryable: true,
      },
    });
    assert.equal(broker.pendingCount, 1);

    const accepted = await fetch(`${base}:select-file`, { method: "POST" });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
      interactionId: pending.interactionId,
      status: "accepted",
    });
    assert.deepEqual(await pending.wait(), {
      status: "responded",
      response: {
        decision: "approve",
        selectedPath: canonicalRequestedPath,
      },
    });
  } finally {
    pending.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("sensitive workspace grants use direct confirmation without a file picker", async () => {
  const broker = new InMemoryInteractionBroker();
  const pending = broker.create({
    kind: "workspace_grant",
    reason: "sensitive_workspace_file",
    runId: "run-1",
    step: 1,
    toolCallId: "run-1:tool:1",
    toolName: "read",
    conversationId: "conversation-1",
    requestedPath: "/workspace/.env",
    canonicalPath: "/workspace/.env",
    access: "read",
    scope: "once",
  });
  const server = createAgentServer({
    provider: providerReturning("unused"),
    interactionBroker: broker,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/agent/interactions/${pending.interactionId}:respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: { decision: "approve" } }),
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      interactionId: pending.interactionId,
      status: "accepted",
    });
    assert.deepEqual(await pending.wait(), {
      status: "responded",
      response: { decision: "approve" },
    });
  } finally {
    pending.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("waits for drain when the writable applies backpressure", async () => {
  let finishWrite!: () => void;
  const destination = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      finishWrite = callback;
    },
  });
  const controller = new AbortController();
  let settled = false;
  const write = writeWithBackpressure(destination, "SSE frame", controller.signal)
    .then(() => {
      settled = true;
    });

  await Promise.resolve();
  assert.equal(settled, false);
  finishWrite();
  await write;
  assert.equal(settled, true);
  destination.end();
});

test("steering an active run injects a user instruction at the next step", async () => {
  let releaseTool!: () => void;
  const toolGate = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  const clock = defineTool({
    name: "clock",
    description: "Test clock.",
    inputSchema: z.strictObject({}),
    async execute() {
      await toolGate;
      return { now: "12:00" };
    },
  });
  const userMessagesPerRequest: string[][] = [];
  let generation = 0;
  const provider: LlmProvider = {
    model: "test-model",
    contextWindowTokens: 64_000,
    maxOutputTokens: 4_000,
    async *stream(request) {
      userMessagesPerRequest.push(
        request.transcript
          .filter((message) => message.role === "user")
          .map((message) => (message as { content: string }).content),
      );
      if (generation++ === 0) {
        yield { type: "tool_arguments.delta", callIndex: 0, text: "{}" } as const;
        yield { type: "completed", turn: toolStep("clock", {}) } as const;
        return;
      }
      yield { type: "output_text.delta", text: "done" } as const;
      yield { type: "completed", turn: finalStep("done") } as const;
    },
  };
  const server = createAgentServer({
    provider,
    tools: [clock],
    toolPermissionPolicy: allowAllToolPermissionPolicy,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    const runUrl = await createConversationRunUrl(origin);
    const conversationId = decodeURIComponent(
      runUrl.split("/conversations/")[1]!.split("/runs")[0]!,
    );
    const response = await fetch(runUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "original task" }),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    // 工具已开始执行，说明第 1 步的抽取点已经过去，而 Loop 停在工具里等门。
    while (!body.includes("event: tool.started")) {
      body += decoder.decode((await reader.read()).value, { stream: true });
    }
    const runId = parseSseEvents(body)[0]!.runId;

    const steer = await fetch(
      `${origin}/v1/agent/conversations/${conversationId}/runs:steer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, input: "改用简洁中文回答" }),
      },
    );
    assert.equal(steer.status, 202);
    assert.deepEqual(await steer.json(), { runId, seq: 0, status: "queued" });

    releaseTool();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      body += decoder.decode(next.value, { stream: true });
    }

    const events = parseSseEvents(body);
    const applied = events.filter((event) => event.type === "steering.applied");
    assert.equal(applied.length, 1);
    assert.equal(applied[0]!.step, 2);
    assert.deepEqual(applied[0]!.data, {
      messageSeq: 0,
      content: "改用简洁中文回答",
    });
    // 第 2 步的请求里，转向消息作为独立 user 消息排在原始任务之后。
    assert.deepEqual(userMessagesPerRequest[1], [
      "original task",
      "改用简洁中文回答",
    ]);
  } finally {
    releaseTool();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("a full access conversation cannot be steered after a non-loopback restart", async (t) => {
  const database = openSqliteDatabase(":memory:");
  initializeSqliteSchema(database);
  const store = new SQLiteConversationStore(database);
  t.after(() => store.close());
  const conversation = store.createConversation(process.cwd(), "full_access");
  const server = createAgentServer({
    conversationStore: store,
    provider: providerReturning("must not run"),
    fullAccessAvailable: false,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/agent/conversations/${conversation.id}/runs:steer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: "run-1", input: "改个方向" }),
      },
    );
    // 门禁在活跃 Run 判定之前生效：拒绝的理由是执行模式，不是没有 Run。
    assert.equal(response.status, 403);
    assert.equal(
      (await response.json() as { error: { code: string } }).error.code,
      "FULL_ACCESS_REQUIRES_LOOPBACK",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error))
    );
  }
});

test("rejects steering an idle conversation, a missing runId and an oversized message", async () => {
  const provider: LlmProvider = {
    model: "test-model",
    contextWindowTokens: 64_000,
    maxOutputTokens: 4_000,
    async *stream() {
      yield { type: "completed", turn: finalStep("done") } as const;
    },
  };
  const server = createAgentServer({ provider });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    const runUrl = await createConversationRunUrl(origin);
    const conversationId = decodeURIComponent(
      runUrl.split("/conversations/")[1]!.split("/runs")[0]!,
    );
    const steerUrl =
      `${origin}/v1/agent/conversations/${conversationId}/runs:steer`;
    const steer = (payload: unknown) =>
      fetch(steerUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

    const idle = await steer({ runId: "run-1", input: "hi" });
    assert.equal(idle.status, 409);
    assert.equal(
      ((await idle.json()) as { error: { code: string } }).error.code,
      "CONVERSATION_IDLE",
    );

    // 缺 runId 属于 schema 不匹配，与其他路由一致返回 422。
    const missingRunId = await steer({ input: "hi" });
    assert.equal(missingRunId.status, 422);

    const oversized = await steer({
      runId: "run-1",
      input: "x".repeat(MAX_STEERING_MESSAGE_BYTES + 1),
    });
    assert.equal(oversized.status, 422);
    assert.equal(
      ((await oversized.json()) as { error: { code: string } }).error.code,
      "INVALID_REQUEST",
    );

    const unknown = await fetch(
      `${origin}/v1/agent/conversations/does-not-exist/runs:steer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: "run-1", input: "hi" }),
      },
    );
    assert.equal(unknown.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("events route replays from after=N and Last-Event-ID, then reaches terminal", async () => {
  // 一个会分两次产出的 provider，验证 seq 连续性。
  let generation = 0;
  const provider = providerFromTurnFactory((request) => {
    void request;
    if (generation++ === 0) return toolStep("clock", {});
    return finalStep("done");
  });
  const clock = defineTool({
    name: "clock",
    description: "clock",
    inputSchema: z.strictObject({}),
    execute() {
      return { now: "12:00" };
    },
  });
  const server = createAgentServer({
    provider,
    tools: [clock],
    toolPermissionPolicy: allowAllToolPermissionPolicy,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    const runUrl = await createConversationRunUrl(origin);
    const conversationId = decodeURIComponent(
      runUrl.split("/conversations/")[1]!.split("/runs")[0]!,
    );
    const response = await fetch(runUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("x-run-id") ?? "", /.+/);
    const events = parseSseEvents(await response.text());
    assert.equal(events.at(-1)?.type, "run.completed");
    const runId = events[0]!.runId;
    const total = events.length;
    const mid = Math.floor(total / 2);
    const afterSeq = events[mid]!.seq;

    // after=N
    const resumed = await fetch(
      `${origin}/v1/agent/conversations/${conversationId}/runs/${runId}/events?after=${afterSeq}`,
    );
    assert.equal(resumed.status, 200);
    const resumedEvents = parseSseEvents(await resumed.text());
    assert.equal(resumedEvents[0]!.seq, afterSeq + 1);
    assert.deepEqual(
      resumedEvents.map((event) => event.seq),
      events.filter((event) => event.seq > afterSeq).map((event) => event.seq),
    );
    assert.equal(resumedEvents.at(-1)?.type, "run.completed");

    // Last-Event-ID
    const lastEventId = `${runId}:${afterSeq}`;
    const viaHeader = await fetch(
      `${origin}/v1/agent/conversations/${conversationId}/runs/${runId}/events`,
      { headers: { "Last-Event-ID": lastEventId } },
    );
    assert.equal(viaHeader.status, 200);
    const headerEvents = parseSseEvents(await viaHeader.text());
    assert.equal(headerEvents[0]!.seq, afterSeq + 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("cancel stops the run, all subscribers see run.cancelled, and repeats are idempotent", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider: LlmProvider = {
    model: "test-model",
    async *stream() {
      await gate;
      yield { type: "completed", turn: finalStep("never") } as const;
    },
  };
  const server = createAgentServer({ provider });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    const runUrl = await createConversationRunUrl(origin);
    const conversationId = decodeURIComponent(
      runUrl.split("/conversations/")[1]!.split("/runs")[0]!,
    );
    const response = await fetch(runUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    while (!body.includes("event: run.started")) {
      const next = await reader.read();
      assert.equal(next.done, false);
      body += decoder.decode(next.value, { stream: true });
    }
    const runId = parseSseEvents(body)[0]!.runId;

    // 第二个订阅者
    const secondResponse = await fetch(
      `${origin}/v1/agent/conversations/${conversationId}/runs/${runId}/events`,
    );
    assert.equal(secondResponse.status, 200);
    const secondReader = secondResponse.body!.getReader();
    const secondDecoder = new TextDecoder();
    let secondBody = "";
    while (!secondBody.includes("event: run.started")) {
      const next = await secondReader.read();
      assert.equal(next.done, false);
      secondBody += secondDecoder.decode(next.value, { stream: true });
    }

    const cancel = await fetch(
      `${origin}/v1/agent/conversations/${conversationId}/runs/${runId}:cancel`,
      { method: "POST" },
    );
    assert.equal(cancel.status, 202);
    assert.deepEqual(await cancel.json(), { runId, status: "cancelling" });

    // 重复 cancel 幂等
    const again = await fetch(
      `${origin}/v1/agent/conversations/${conversationId}/runs/${runId}:cancel`,
      { method: "POST" },
    );
    assert.equal(again.status, 202);

    release();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      body += decoder.decode(next.value, { stream: true });
    }
    body += decoder.decode();
    const events = parseSseEvents(body);
    assert.equal(events.at(-1)?.type, "run.cancelled");

    for (;;) {
      const next = await secondReader.read();
      if (next.done) break;
      secondBody += secondDecoder.decode(next.value, { stream: true });
    }
    secondBody += secondDecoder.decode();
    const secondEvents = parseSseEvents(secondBody);
    assert.equal(secondEvents.at(-1)?.type, "run.cancelled");

    // 已结束的 Run 返回 409。
    await new Promise<void>((resolve) => setImmediate(resolve));
    const after = await fetch(
      `${origin}/v1/agent/conversations/${conversationId}/runs/${runId}:cancel`,
      { method: "POST" },
    );
    assert.equal(after.status, 409);
    assert.equal(
      ((await after.json()) as { error: { code: string } }).error.code,
      "RUN_NOT_ACTIVE",
    );

    // 别的会话的 runId 返回 404。
    const other = await createConversationRunUrl(origin);
    const otherId = decodeURIComponent(
      other.split("/conversations/")[1]!.split("/runs")[0]!,
    );
    const wrongConversation = await fetch(
      `${origin}/v1/agent/conversations/${otherId}/runs/${runId}:cancel`,
      { method: "POST" },
    );
    assert.equal(wrongConversation.status, 404);
  } finally {
    release?.();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("runs:watch emits snapshot and run.state transitions", async () => {
  const bash = defineTool({
    name: "bash",
    description: "bash",
    impact: "test",
    inputSchema: z.strictObject({ command: z.string() }),
    summarizeInput(input) {
      return input;
    },
    execute() {
      return { ok: true };
    },
  });
  const responses: import("../src/provider-protocol.js").ProviderTurn[] = [
    toolStep("bash", { command: "pwd" }),
    finalStep("done"),
  ];
  const provider = providerFromTurnFactory(() => {
    const response = responses.shift();
    if (response === undefined) throw new Error("No response.");
    return response;
  });
  const server = createAgentServer({
    provider,
    tools: [bash],
    interactionBroker: new InMemoryInteractionBroker(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const watchController = new AbortController();
  try {
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;

    const watchResponse = await fetch(`${origin}/v1/agent/runs:watch`, {
      signal: watchController.signal,
    });
    assert.equal(watchResponse.status, 200);
    const watchReader = watchResponse.body!.getReader();
    const watchDecoder = new TextDecoder();
    let watchBody = "";
    const readWatch = async (until: string) => {
      while (!watchBody.includes(until)) {
        const next = await watchReader.read();
        if (next.done) break;
        watchBody += watchDecoder.decode(next.value, { stream: true });
      }
    };

    await readWatch("event: snapshot");
    assert.match(watchBody, /"runs":\[\]/);

    const runUrl = await createConversationRunUrl(origin);
    const runResponse = await fetch(runUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "run pwd" }),
    });
    assert.equal(runResponse.status, 200);
    const runReader = runResponse.body!.getReader();
    const runDecoder = new TextDecoder();
    let runBody = "";
    while (!runBody.includes("event: interaction.required")) {
      const next = await runReader.read();
      assert.equal(next.done, false);
      runBody += runDecoder.decode(next.value, { stream: true });
    }

    await readWatch("awaiting_interaction");
    assert.match(watchBody, /"state":"running"/);
    assert.match(watchBody, /"state":"awaiting_interaction"/);

    const required = parseSseEvents(runBody).find(
      (event) => event.type === "interaction.required",
    );
    assert.equal(required?.type, "interaction.required");
    if (required?.type !== "interaction.required") assert.fail("no required");

    const approval = await fetch(
      `${origin}/v1/agent/interactions/${required.interactionId}:respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: { decision: "approve" } }),
      },
    );
    assert.equal(approval.status, 200);

    for (;;) {
      const next = await runReader.read();
      if (next.done) break;
      runBody += runDecoder.decode(next.value, { stream: true });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    await readWatch("\"state\":\"ended\"");
    assert.match(watchBody, /"state":"ended"/);
    assert.match(watchBody, /"status":"completed"/);
    watchController.abort();
  } finally {
    watchController.abort();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 2000);

      server.close((error) => {
        clearTimeout(timer);
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }
});

test("watchClientDisconnect release removes request and response listeners", () => {
  const request = new IncomingMessage(new Socket());
  const response = new ServerResponse(request);

  const watcher = watchClientDisconnect(request, response);
  assert.equal(request.listenerCount("aborted"), 1);
  assert.equal(response.listenerCount("close"), 1);

  watcher.release();
  assert.equal(request.listenerCount("aborted"), 0);
  assert.equal(response.listenerCount("close"), 0);
});

function parseSseEvents(body: string): AgentEvent[] {
  return body
    .split("\n\n")
    .map((frame) =>
      frame
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length),
    )
    .filter((data): data is string => data !== undefined)
    .map((data) => {
      const record = JSON.parse(data) as {
        readonly event?: AgentEvent;
        readonly snapshot?: unknown;
        readonly streamSeq?: number;
      };
      if (record.event !== undefined) return record.event;
      return {
        v: 1,
        runId: "snapshot",
        seq: record.streamSeq ?? 0,
        type: "run.snapshot",
        data: record.snapshot,
      } as unknown as AgentEvent;
    });
}

test("select-workspace accepts a configured cross-origin frontend", async (t) => {
  // 回归守卫：defineRoute 的 Origin 闸门必须拿到 CORS_ALLOW_ORIGIN 配置的
  // allowedOrigin，否则跨域前端连 workspace_sandbox 都拿 403。
  const directory = await mkdtemp(join(tmpdir(), "agent-allowed-origin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let picks = 0;
  const server = createAgentServer({
    provider: {
      model: "test-model",
      async *stream() {
        throw new Error("Provider should not be called.");
      },
    },
    allowedOrigin: "http://frontend.example",
    workspaceRoot: directory,
    // 该目录不在默认工作区内，需要显式给 runtime，与其它 select-workspace 用例一致。
    workspaceRuntimeProvider: {
      async get(workspaceRoot, executionMode) {
        return {
          workspaceRoot,
          executionMode,
          sandboxRunner: new HostSandboxRunner(),
          tools: [],
        };
      },
    },
    hostDirectoryPicker: {
      async pickDirectory() {
        picks += 1;
        return { status: "selected" as const, path: directory };
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error))
    )
  );
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const url = `http://127.0.0.1:${port}/v1/agent/conversations:select-workspace`;

  const allowedInspect = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://frontend.example",
    },
    body: JSON.stringify({ action: "inspect" }),
  });
  assert.equal(allowedInspect.status, 200);
  const selection = await allowedInspect.json() as { selectionToken: string };
  const allowed = await fetch(`${origin}/v1/agent/conversations:open`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://frontend.example",
    },
    body: JSON.stringify({ selectionToken: selection.selectionToken,
      executionMode: "workspace_sandbox", workspace: { kind: "selected_directory" } }),
  });
  assert.equal(allowed.status, 201);
  assert.equal(picks, 1);

  const rejected = await fetch(`${origin}/v1/agent/conversations:open`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://other.example",
    },
    body: JSON.stringify({ selectionToken: selection.selectionToken,
      executionMode: "workspace_sandbox", workspace: { kind: "selected_directory" } }),
  });
  assert.equal(rejected.status, 403);
  assert.equal(
    (await rejected.json() as { error: { code: string } }).error.code,
    "UNTRUSTED_ORIGIN",
  );
  // 被拒的请求不能走到宿主目录选择器。
  assert.equal(picks, 1);
});
