import { createMcpTool } from "../src/tools/mcp-tool.js";
import { HostSandboxRunner } from "../src/sandbox/host-sandbox-runner.js";
import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent } from "../src/agent-events.js";
import type { RunEventSource } from "../src/run-stream.js";
import { ConversationRunService } from "../src/application/conversation-run-service.js";
import { ProjectMemoryStore } from "../src/infrastructure/memory-store.js";
import type { WorkspaceRuntimeProvider } from "../src/application/workspace-runtime.js";
import type { LlmProvider } from "../src/provider-protocol.js";
import { AuthorizedToolExecutor } from "../src/tool-permissions.js";
import { defineTool } from "../src/tools.js";
import { parseTranscriptMessage, type TranscriptMessage } from "../src/transcript.js";import {
  finalTurn,
  providerFromTurnFactory,
  toolCallTurn,
} from "./support/provider.js";
import { createSQLiteTestStore } from "./support/sqlite-test-store.js";
import { validSummary } from "./support/summary.js";
import { z } from "zod";

const emptyWorkspaceRuntimeProvider: WorkspaceRuntimeProvider = {
  async get(workspaceRoot, executionMode) {
    return { workspaceRoot, executionMode, sandboxRunner: new HostSandboxRunner(), tools: [] };
  },
};
const providerCapacity = {
  contextWindowTokens: 64_000,
  maxOutputTokens: 4_000,
} as const;
const noWorkspaceInstructions = async (): Promise<undefined> => undefined;

const provider = (
  factory: Parameters<typeof providerFromTurnFactory>[0],
): LlmProvider => providerFromTurnFactory(factory, providerCapacity);

async function consumeEvents(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // Consume the complete stream.
  }
}

test("loads workspace instructions once per run and reuses the prompt across steps", async (t) => {
  const { store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace", "workspace_sandbox");
  const loadedRoots: string[] = [];
  const prompts: string[] = [];
  let providerCall = 0;
  const service = new ConversationRunService({
    bytesPerToken: 1,
    conversationStore: store,
    workspaceRuntimeProvider: emptyWorkspaceRuntimeProvider,
    async loadWorkspaceInstructions(workspaceRoot) {
      loadedRoots.push(workspaceRoot);
      return `Workspace instruction ${loadedRoots.length}.`;
    },
    provider: provider((request) => {
      prompts.push(request.systemPrompt);
      providerCall += 1;
      if (providerCall === 1) {
        return toolCallTurn("missing_tool", {}, "missing-call");
      }
      return finalTurn(providerCall === 2 ? "first" : "second");
    }),
  });

  await consumeEvents(service.startRun({
    conversationId: conversation.id,
    input: "first run",
  }).events);
  await consumeEvents(service.startRun({
    conversationId: conversation.id,
    input: "second run",
  }).events);

  assert.deepEqual(loadedRoots, ["/workspace", "/workspace"]);
  assert.equal(prompts.length, 3);
  assert.equal(prompts[0], prompts[1]);
  assert.match(prompts[0]!, /Workspace instruction 1\./);
  assert.match(prompts[2]!, /Workspace instruction 2\./);
});

test("discovers workspace skills once per run and composes a run-local skill tool", async (t) => {
  const { store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace", "workspace_sandbox");
  let discoveryCount = 0;
  const prompts: string[] = [];
  const toolNames: string[][] = [];
  const service = new ConversationRunService({
    bytesPerToken: 1,
    conversationStore: store,
    workspaceRuntimeProvider: emptyWorkspaceRuntimeProvider,
    loadWorkspaceInstructions: noWorkspaceInstructions,
    async discoverWorkspaceSkills() {
      discoveryCount += 1;
      const name = `skill-${discoveryCount}`;
      return {
        skills: [{ name, description: `Description ${discoveryCount}.`, source: "workspace" as const }],
        catalog:
          `<skills><skill><name>${name}</name><description>Description ${discoveryCount}.</description></skill></skills>`,
        diagnostics: [],
        async load(requestedName: string) {
          return {
            content: `Instructions for ${requestedName}.`,
            directory: "/workspace/.agents/skills/" + requestedName,
            source: "workspace" as const,
          };
        },
      };
    },
    provider: provider((request) => {
      prompts.push(request.systemPrompt);
      toolNames.push(request.tools.map((tool) => tool.name));
      return finalTurn("done");
    }),
  });

  await consumeEvents(service.startRun({
    conversationId: conversation.id,
    input: "first",
  }).events);
  await consumeEvents(service.startRun({
    conversationId: conversation.id,
    input: "second",
  }).events);

  assert.equal(discoveryCount, 2);
  assert.deepEqual(toolNames, [["skill", "agent", "wait_agent", "stop_agent"], ["skill", "agent", "wait_agent", "stop_agent"]]);
  assert.match(prompts[0]!, /skill-1/);
  assert.doesNotMatch(prompts[0]!, /skill-2/);
  assert.match(prompts[1]!, /skill-2/);
});

test("fails the run before calling the Provider when workspace instructions cannot be loaded", async (t) => {
  const { database, store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace", "workspace_sandbox");
  let providerCalls = 0;
  const service = new ConversationRunService({
    bytesPerToken: 1,
    conversationStore: store,
    workspaceRuntimeProvider: emptyWorkspaceRuntimeProvider,
    async loadWorkspaceInstructions() {
      throw new Error("AGENTS.md is unreadable");
    },
    provider: provider(() => {
      providerCalls += 1;
      return finalTurn("unused");
    }),
  });

  const run = service.startRun({
    conversationId: conversation.id,
    input: "run",
  });
  await assert.rejects(consumeEvents(run.events), /AGENTS\.md is unreadable/);

  assert.equal(providerCalls, 0);
  assert.equal(
    database.prepare(`
      SELECT system_prompt
      FROM runs
      WHERE id = $runId
    `).get({ "$runId": run.runId })?.system_prompt,
    null,
  );
  assert.equal(
    store.getConversation(conversation.id).turns[0]?.status,
    "failed",
  );
});

test("fails before calling the Provider when the system prompt cannot be recorded", async (t) => {
  const { database, store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace", "workspace_sandbox");
  database.exec(`
    CREATE TRIGGER reject_system_prompt
    BEFORE UPDATE OF system_prompt ON runs
    WHEN NEW.system_prompt IS NOT OLD.system_prompt
    BEGIN
      SELECT RAISE(ABORT, 'reject system prompt');
    END;
  `);
  let providerCalls = 0;
  const service = new ConversationRunService({
    bytesPerToken: 1,
    loadWorkspaceInstructions: noWorkspaceInstructions,
    conversationStore: store,
    workspaceRuntimeProvider: emptyWorkspaceRuntimeProvider,
    provider: provider(() => {
      providerCalls += 1;
      return finalTurn("unused");
    }),
  });

  const run = service.startRun({
    conversationId: conversation.id,
    input: "run",
  });
  await assert.rejects(consumeEvents(run.events), /reject system prompt/);

  assert.equal(providerCalls, 0);
  assert.deepEqual(
    { ...database.prepare(`
      SELECT status, system_prompt
      FROM runs
      WHERE id = $runId
    `).get({ "$runId": run.runId }) },
    { status: "failed", system_prompt: null },
  );
});

test("ConversationRunService owns successful run persistence", async (t) => {
  const { database, store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace", "workspace_sandbox");
  let activeRunId = "";
  const service = new ConversationRunService({
    bytesPerToken: 1,
    loadWorkspaceInstructions: noWorkspaceInstructions,
    conversationStore: store,
    workspaceRuntimeProvider: emptyWorkspaceRuntimeProvider,
    provider: provider((request) => {
      assert.equal(
        database.prepare(`
          SELECT system_prompt
          FROM runs
          WHERE id = $runId
        `).get({ "$runId": activeRunId })?.system_prompt,
        request.systemPrompt,
      );
      return finalTurn("done");
    }),
  });

  const run = service.startRun({
    conversationId: conversation.id,
    input: "do it",
  });
  activeRunId = run.runId;
  const eventTypes: string[] = [];
  for await (const source of run.events) eventTypes.push(source.event.type);

  assert.equal(eventTypes.at(-1), "run.completed");
  const turn = store.getConversation(conversation.id).turns[0];
  assert.equal(turn.userMessage, "do it");
  assert.equal(turn.assistantMessage, "done");
  assert.equal(turn.status, "completed");
  assert.equal(turn.runs[0].id, run.runId);
  assert.equal(turn.runs[0].status, "completed");
});

test("ConversationRunService persists normalized tool actions", async (t) => {
  const { database, store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace", "workspace_sandbox");
  const searchTool = defineTool({
    name: "web_search",
    description: "Search the web.",
    inputSchema: z.strictObject({ query: z.string() }),
    execute({ query }) {
      return { query };
    },
  });
  let generation = 0;
  const service = new ConversationRunService({
    bytesPerToken: 1,
    loadWorkspaceInstructions: noWorkspaceInstructions,
    conversationStore: store,
    workspaceRuntimeProvider: {
      async get(workspaceRoot, executionMode) {
        return { workspaceRoot, executionMode, sandboxRunner: new HostSandboxRunner(), tools: [searchTool] };
      },
    },
    provider: provider(() => generation++ === 0
      ? toolCallTurn("web_search", { query: "Miaoda" }, "search-call")
      : finalTurn("done")),
  });

  const run = service.startRun({
    conversationId: conversation.id,
    input: "search",
  });
  for await (const _event of run.events) {
    // Consume the completed run.
  }

  const assistantMessages = database.prepare(`
    SELECT message_json
    FROM transcript_messages
    WHERE run_id = $runId AND role = 'assistant'
    ORDER BY seq
  `).all({ "$runId": run.runId });
  assert.deepEqual(
    parseTranscriptMessage(String(assistantMessages[0]?.message_json)),
    {
      role: "assistant",
      content: null,
      toolCalls: [{
        callId: "search-call",
        name: "web_search",
        arguments: '{"query":"Miaoda"}',
      }],
    },
  );
});

test("ConversationRunService uses and persists a compacted provider view", async (t) => {
  const { database, store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace", "workspace_sandbox");
  const largeTool = defineTool({
    name: "read",
    description: "Returns a large result.",
    inputSchema: z.strictObject({}),
    maxOutputBytes: 64 * 1_024,
    execute() {
      return "x".repeat(60_000);
    },
  });
  let agentCalls = 0;
  let summaryCalls = 0;
  const requests: Parameters<NonNullable<LlmProvider["stream"]>>[0][] = [];
  const compactionProvider = providerFromTurnFactory((request) => {
    requests.push({
      ...request,
      transcript: structuredClone(request.transcript),
      tools: [...request.tools],
    });
    if (request.tools.length === 0) {
      summaryCalls += 1;
      // 下限 4,096 抬起后被 provider 的 4,000 压回。
      assert.equal(request.maxOutputTokens, 4_000);
      return finalTurn(validSummary("完成任务"));
    }
    agentCalls += 1;
    return agentCalls === 1
      ? toolCallTurn("read", {}, "large-call")
      : finalTurn("done");
  }, providerCapacity);
  const service = new ConversationRunService({
    bytesPerToken: 1,
    loadWorkspaceInstructions: noWorkspaceInstructions,
    conversationStore: store,
    workspaceRuntimeProvider: {
      async get(workspaceRoot, executionMode) {
        return { workspaceRoot, executionMode, sandboxRunner: new HostSandboxRunner(), tools: [largeTool] };
      },
    },
    provider: compactionProvider,
  });

  const run = service.startRun({
    conversationId: conversation.id,
    input: "use the large tool",
  });
  await consumeEvents(run.events);

  assert.equal(
    summaryCalls,
    1,
    JSON.stringify(requests.map((request) => ({
      tools: request.tools.map((tool) => tool.name),
      maxOutputTokens: request.maxOutputTokens,
      roles: request.transcript.map((message) => message.role),
    }))),
  );
  const finalRequest = requests.at(-1)!;
  assert.equal(finalRequest.transcript[0]?.role, "user");
  assert.match(
    finalRequest.transcript[0]?.role === "user"
      ? finalRequest.transcript[0].content
      : "",
    /Harness 生成的累计上下文摘要/,
  );
  // 未结束 Turn 的开场消息原文保留，紧跟在摘要之后。
  assert.deepEqual(finalRequest.transcript[1], {
    role: "user",
    content: "use the large tool",
  });
  assert.deepEqual(database.prepare(`
    SELECT position, covered_through_seq, summary_text
    FROM conversation_context_compactions
    WHERE conversation_id = $conversationId
  `).all({ "$conversationId": conversation.id }).map((row) => ({ ...row })), [{
    position: 0,
    covered_through_seq: 2,
    summary_text: validSummary("完成任务"),
  }]);
  assert.deepEqual(database.prepare(`
    SELECT role FROM transcript_messages
    WHERE run_id = $runId ORDER BY seq
  `).all({ "$runId": run.runId }).map((row) => row.role), [
    "user",
    "assistant",
    "tool",
    "assistant",
  ]);
});

test("ConversationRunService persists business failures", async (t) => {
  const { database, store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace", "workspace_sandbox");
  const provider: LlmProvider = {
    ...providerCapacity,
    model: "test-model",
    async *stream() {
      throw new Error("provider failed");
    },
  };
  const service = new ConversationRunService({
    bytesPerToken: 1,
    loadWorkspaceInstructions: noWorkspaceInstructions,
    conversationStore: store,
    provider,
    workspaceRuntimeProvider: emptyWorkspaceRuntimeProvider,
  });
  const run = service.startRun({
    conversationId: conversation.id,
    input: "fail",
  });

  const eventTypes: string[] = [];
  for await (const source of run.events) eventTypes.push(source.event.type);

  assert.equal(eventTypes.at(-1), "run.error");
  assert.equal(
    store.getConversation(conversation.id).turns[0].status,
    "failed",
  );
  assert.deepEqual(
    store.getConversation(conversation.id).turns[0].runs[0].error,
    { code: "AGENT_RUN_FAILED", message: "Agent run failed." },
  );
  const persisted = database.prepare(`
    SELECT error_code, error_message, internal_error, system_prompt
    FROM runs
    WHERE id = $runId
  `).get({ "$runId": run.runId });
  assert.equal(persisted?.error_code, "AGENT_RUN_FAILED");
  assert.equal(persisted?.error_message, "Agent run failed.");
  assert.match(String(persisted?.internal_error), /provider failed/);
  assert.match(String(persisted?.system_prompt), /tool-execution loop/);
  assert.deepEqual(
    database.prepare(`
      SELECT role, message_json
      FROM transcript_messages
      WHERE run_id = $runId
      ORDER BY seq
    `).all({ "$runId": run.runId }).map((row) => ({ ...row })),
    [{
      role: "user",
      message_json: JSON.stringify({ role: "user", content: "fail" }),
    }],
  );
});

test("ConversationRunService marks an aborted run as cancelled", async (t) => {
  const { database, store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace", "workspace_sandbox");
  const controller = new AbortController();
  const service = new ConversationRunService({
    bytesPerToken: 1,
    loadWorkspaceInstructions: noWorkspaceInstructions,
    conversationStore: store,
    workspaceRuntimeProvider: emptyWorkspaceRuntimeProvider,
    provider: provider(() => finalTurn("unused")),
  });
  const run = service.startRun({
    conversationId: conversation.id,
    input: "cancel",
    signal: controller.signal,
  });
  const events = run.events[Symbol.asyncIterator]();

  assert.equal((await events.next()).value?.event.type, "run.started");
  assert.equal((await events.next()).value?.event.type, "step.started");
  controller.abort(new Error("stop"));
  await assert.rejects(events.next(), /stop/);

  assert.equal(
    store.getConversation(conversation.id).turns[0].status,
    "cancelled",
  );
  assert.deepEqual(
    { ...database.prepare(`
      SELECT error_code, error_message
      FROM runs
      WHERE id = $runId
    `).get({ "$runId": run.runId }) },
    { error_code: null, error_message: null },
  );
  assert.deepEqual(
    database.prepare(`
      SELECT role, message_json
      FROM transcript_messages
      WHERE run_id = $runId
      ORDER BY seq
    `).all({ "$runId": run.runId }).map((row) => ({ ...row })),
    [{
      role: "user",
      message_json: JSON.stringify({ role: "user", content: "cancel" }),
    }],
  );
});

test("ConversationRunService keeps partial transcripts before a failure", async (t) => {
  const { database, store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace", "workspace_sandbox");
  let generation = 0;
  const service = new ConversationRunService({
    bytesPerToken: 1,
    loadWorkspaceInstructions: noWorkspaceInstructions,
    conversationStore: store,
    workspaceRuntimeProvider: emptyWorkspaceRuntimeProvider,
    provider: provider(() => {
      if (generation++ === 0) {
        return toolCallTurn("missing_tool", {}, "missing-call");
      }
      throw new Error("provider disconnected");
    }),
  });

  const run = service.startRun({
    conversationId: conversation.id,
    input: "use a tool",
  });
  for await (const _event of run.events) {
    // Consume the failed run.
  }

  const transcript = database.prepare(`
    SELECT role, message_json
    FROM transcript_messages
    WHERE run_id = $runId
    ORDER BY seq
  `).all({ "$runId": run.runId });
  assert.deepEqual(transcript.map((message) => message.role), [
    "user",
    "assistant",
    "tool",
  ]);
  assert.deepEqual(
    parseTranscriptMessage(String(transcript[1]?.message_json)),
    {
      role: "assistant",
      content: null,
      toolCalls: [{
        callId: "missing-call",
        name: "missing_tool",
        arguments: "{}",
      }],
    },
  );
  assert.deepEqual(
    parseTranscriptMessage(String(transcript[2]?.message_json)),
    {
      role: "tool",
      results: [{
        toolCallId: "missing-call",
        result: {
        type: "tool_result",
        tool: "missing_tool",
        status: "error",
        error: {
          code: "UNKNOWN_TOOL",
          message: "Unknown tool: missing_tool",
        },
        },
      }],
    },
  );
});

test("ConversationRunService uses one conversation runtime for tools and permission context", async (t) => {
  const workspaceRoot = "/workspace-a";
  const { store } = createSQLiteTestStore(t);
  const conversation = store.createConversation(
    workspaceRoot,
    "workspace_sandbox",
  );
  const selectedRoots: string[] = [];
  const selectedModes: string[] = [];
  const permissionRoots: string[] = [];
  const permissionModes: string[] = [];
  let executed = false;
  const markerTool = defineTool({
    name: "workspace_marker",
    description: "Mark the selected workspace.",
    inputSchema: z.strictObject({}),
    execute() {
      executed = true;
      return { workspaceRoot };
    },
  });
  const workspaceRuntimeProvider: WorkspaceRuntimeProvider = {
    async get(requestedRoot, executionMode) {
      selectedRoots.push(requestedRoot);
      selectedModes.push(executionMode);
      return {
        workspaceRoot: requestedRoot,
        executionMode,
        sandboxRunner: new HostSandboxRunner(),
        tools: [markerTool],
      };
    },
  };
  const authorizedToolExecutor = new AuthorizedToolExecutor({
    policy: {
      evaluate() {
        return { effect: "allow", ruleId: "test:allow" };
      },
      isVisible(_tool, context) {
        permissionRoots.push(context.workspaceRoot);
        permissionModes.push(context.executionMode ?? "missing");
        return true;
      },
    },
  });
  let generation = 0;
  const service = new ConversationRunService({
    bytesPerToken: 1,
    loadWorkspaceInstructions: noWorkspaceInstructions,
    conversationStore: store,
    provider: provider((request) => {
        if (generation++ === 0) {
          assert.deepEqual(
            request.tools.map((tool) => tool.name),
            ["workspace_marker", "agent", "wait_agent", "stop_agent"],
          );
          return toolCallTurn("workspace_marker", {}, "marker-call");
        }
        return finalTurn("done");
      }),
    workspaceRuntimeProvider,
    authorizedToolExecutor,
  });

  const run = service.startRun({
    conversationId: conversation.id,
    input: "use the workspace",
  });
  for await (const _event of run.events) {
    // Consume the run.
  }

  assert.deepEqual(selectedRoots, [workspaceRoot]);
  assert.deepEqual(selectedModes, ["workspace_sandbox"]);
  // 两步 × 四个父工具，每次可见性判定都带同一份上下文。
  assert.deepEqual(permissionRoots, Array(8).fill(workspaceRoot));
  assert.deepEqual(permissionModes, Array(8).fill("workspace_sandbox"));
  assert.equal(executed, true);
});

test("delegates to a sub agent, forwards its events, and persists it beside the parent", async (t) => {
  const { store, database } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace", "workspace_sandbox");
  const probeTool = defineTool({
    name: "probe",
    description: "Returns a marker.",
    inputSchema: z.strictObject({}),
    async execute() {
      return { marker: "from-child" };
    },
  });
  const workspaceRuntimeProvider: WorkspaceRuntimeProvider = {
    async get(workspaceRoot, executionMode) {
      return { workspaceRoot, executionMode, sandboxRunner: new HostSandboxRunner(), tools: [probeTool] };
    },
  };
  const prompts: string[] = [];
  const toolSets: string[][] = [];
  const service = new ConversationRunService({
    bytesPerToken: 1,
    conversationStore: store,
    workspaceRuntimeProvider,
    loadWorkspaceInstructions: noWorkspaceInstructions,
    provider: provider((request) => {
      prompts.push(request.systemPrompt);
      toolSets.push(request.tools.map((tool) => tool.name));
      const isChild = request.systemPrompt.includes("You are a sub agent");
      if (isChild) {
        return request.transcript.length === 1
          ? toolCallTurn("probe", {}, "child-probe")
          : finalTurn("child found the marker");
      }
      return request.transcript.length === 1
        ? toolCallTurn(
            "agent",
            { description: "find marker", task: "Call probe and report." },
            "parent-agent",
          )
        : finalTurn("parent done");
    }),
  });

  const events: RunEventSource[] = [];
  const started = service.startRun({ conversationId: conversation.id, input: "delegate" });
  for await (const source of started.events) events.push(source);

  // 父 Run 看到 agent 工具，子 Run 看不到；两份 prompt 各带自己的段落。
  assert.deepEqual(toolSets[0], ["probe", "agent", "wait_agent", "stop_agent"]);
  assert.deepEqual(toolSets[1], ["probe"]);
  assert.match(prompts[0]!, /Delegating with agent/);
  assert.match(prompts[1]!, /You are a sub agent/);

  const forwarded = events.filter((source) => source.subAgent !== undefined);
  assert.ok(forwarded.length > 0);
  assert.ok(forwarded.every((source) =>
    source.subAgent?.toolCallId === "parent-agent"
  ));
  const completed = events.find((source) => source.subAgent === undefined && source.event.type === "tool.completed");
  assert.ok(completed?.event.type === "tool.completed" && completed.event.data.status === "success");
  if (completed?.event.type === "tool.completed" && completed.event.data.status === "success") {
    assert.equal(typeof completed.event.data.result, "object");
    assert.equal((completed.event.data.result as { status?: string } | null)?.status, "started");
  }

  // 主线只有 agent 调用对；子 Run 的 probe 调用在它自己的 transcript 里。
  const transcript = store.loadConversationTranscript(conversation.id);
  const parentToolNames = transcript.flatMap((message) =>
    message.role === "assistant" && message.content === null
      ? message.toolCalls.map((call) => call.name)
      : []
  );
  assert.deepEqual(parentToolNames, ["agent"]);
  const subAgentRuns = store.listSubAgentRuns(started.runId);
  assert.equal(subAgentRuns.length, 1);
  const child = subAgentRuns[0]!;
  assert.equal(child.toolCallId, "parent-agent");
  assert.equal(child.description, "find marker");
  assert.equal(child.status, "completed");
  assert.equal(child.finalAnswer, "child found the marker");
  assert.equal(child.messageCount, 4);
  assert.equal(child.usage.calls, 2);
  const childToolNames = store.loadSubAgentTranscript(child.id).flatMap((message) =>
    message.role === "assistant" && message.content === null
      ? message.toolCalls.map((call) => call.name)
      : []
  );
  assert.deepEqual(childToolNames, ["probe"]);

  // 子 Run 的两次模型调用以 sub_agent 记在父 Run 上并指向该子 Run，父 Run 自己三步。
  const rows = database.prepare(
    "SELECT kind, step, sub_agent_run_id FROM run_model_calls ORDER BY seq",
  ).all() as Array<{ kind: string; step: number | null; sub_agent_run_id: string | null }>;
  assert.deepEqual(rows.map((row) => row.kind).sort(), ["step", "step", "step", "sub_agent", "sub_agent"]);
  assert.ok(rows.filter((row) => row.kind === "sub_agent").every(
    (row) => row.step === null && row.sub_agent_run_id === child.id,
  ));
  const view = store.getConversation(conversation.id);
  assert.equal(view.usage.calls, 5);
  assert.deepEqual(view.turns[0]!.runs[0]!.subAgentRuns.map((run) => run.id), [child.id]);
});

test("acquireMcpTools adds MCP tools to parent and child tool sets", async (t) => {
  const { store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace", "workspace_sandbox");
  const service = new ConversationRunService({
    bytesPerToken: 1,
    conversationStore: store,
    workspaceRuntimeProvider: emptyWorkspaceRuntimeProvider,
    loadWorkspaceInstructions: noWorkspaceInstructions,
    async acquireMcpTools() {
      const tool = createMcpTool({
        server: "s",
        remoteTool: { name: "echo", inputSchema: { type: "object", properties: {} } },
        async callTool() {
          return { content: [{ type: "text", text: "ok" }] };
        },
        timeoutMs: 1000,
      });
      return { tools: [tool!] };
    },
    provider: provider((request) => {
      const names = request.tools.map((tool) => tool.name);
      if (request.systemPrompt.includes("You are a sub agent")) {
        // 子 Run 也应看到 MCP 工具。
        assert.ok(names.includes("mcp__s__echo"));
        return finalTurn("child done");
      }
      assert.ok(names.includes("mcp__s__echo"));
      return finalTurn("parent done");
    }),
  });
  await consumeEvents(service.startRun({
    conversationId: conversation.id,
    input: "hi",
  }).events);
});

test("acquireMcpTools throwing does not fail the run", async (t) => {
  const { store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace", "workspace_sandbox");
  const service = new ConversationRunService({
    bytesPerToken: 1,
    conversationStore: store,
    workspaceRuntimeProvider: emptyWorkspaceRuntimeProvider,
    loadWorkspaceInstructions: noWorkspaceInstructions,
    async acquireMcpTools() {
      throw new Error("boom");
    },
    provider: provider(() => finalTurn("done")),
  });
  const started = service.startRun({ conversationId: conversation.id, input: "hi" });
  for await (const source of started.events) {
    if (source.event.type === "run.completed") {
      assert.equal(source.event.data.stopReason, "final");
    }
  }
});

test("a run cancelled mid-tool stays resumable and the next run sees TOOL_INTERRUPTED", async (t) => {
  const { database, store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace", "workspace_sandbox");

  let started!: () => void;
  const startedP = new Promise<void>((resolve) => (started = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slowTool = defineTool({
    name: "slow",
    description: "Waits for a gate.",
    inputSchema: z.strictObject({}),
    execute(_input, context) {
      started();
      return new Promise((resolve, reject) => {
        context.signal?.addEventListener("abort", () =>
          reject(context.signal?.reason ?? new Error("cancelled"))
        );
        gate.then(() => resolve({ ok: true }));
      });
    },
  });

  const requests: Array<{ transcript: readonly TranscriptMessage[] }> = [];
  let call = 0;
  const service = new ConversationRunService({
    bytesPerToken: 1,
    loadWorkspaceInstructions: noWorkspaceInstructions,
    conversationStore: store,
    workspaceRuntimeProvider: {
      async get(workspaceRoot, executionMode) {
        return { workspaceRoot, executionMode, sandboxRunner: new HostSandboxRunner(), tools: [slowTool] };
      },
    },
    provider: provider((request) => {
      requests.push({ transcript: structuredClone(request.transcript) });
      call += 1;
      if (call === 1) return toolCallTurn("slow", {}, "slow-call");
      return finalTurn("continued");
    }),
  });

  const controller = new AbortController();
  const run = service.startRun({
    conversationId: conversation.id,
    input: "run the slow tool",
    signal: controller.signal,
  });
  const events = run.events[Symbol.asyncIterator]();

  // Drive into the tool, then cancel.
  const drive = (async () => {
    try {
      for (;;) await events.next();
    } catch (error) {
      return error;
    }
  })();
  await startedP;
  controller.abort(new Error("cancelled"));
  release();
  await drive;

  // 第二个 Run 继续同一会话，应能正常完成。
  await consumeEvents(service.startRun({
    conversationId: conversation.id,
    input: "continue",
  }).events);

  // 最后一个 provider 请求的 transcript 应包含那条 TOOL_INTERRUPTED 结果。
  const lastTranscript = requests.at(-1)!.transcript;
  const interrupted = lastTranscript.find((message) =>
    message.role === "tool" &&
    message.results.some((entry: { result: { status: string } }) =>
      entry.result.status === "error"
    )
  );
  // 精确断言其错误码。
  const interruptedEntry = lastTranscript.flatMap((message) =>
    message.role === "tool" ? message.results : []
  ).find((entry: { result: { status: string; error?: { code: string } } }) =>
    entry.result.status === "error" && entry.result.error?.code === "TOOL_INTERRUPTED"
  );
  assert.ok(interrupted !== undefined, JSON.stringify(lastTranscript));
  assert.ok(interruptedEntry !== undefined, JSON.stringify(lastTranscript));
});

test("internal_error carries the cause chain using Caused by", async (t) => {
  const { database, store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace", "workspace_sandbox");
  const provider: LlmProvider = {
    ...providerCapacity,
    model: "test-model",
    async *stream() {
      throw new Error("provider failed", { cause: new Error("root cause") });
    },
  };
  const service = new ConversationRunService({
    bytesPerToken: 1,
    loadWorkspaceInstructions: noWorkspaceInstructions,
    conversationStore: store,
    provider,
    workspaceRuntimeProvider: emptyWorkspaceRuntimeProvider,
  });
  const run = service.startRun({ conversationId: conversation.id, input: "fail" });
  await consumeEvents(run.events);

  const persisted = database.prepare(`
    SELECT internal_error FROM runs WHERE id = $runId
  `).get({ "$runId": run.runId });
  const text = String(persisted?.internal_error);
  assert.match(text, /provider failed/);
  assert.match(text, /Caused by:/);
  assert.match(text, /root cause/);
});

test("loads a bounded project memory index into the parent prompt and reports its state", async (t) => {
  const { store } = createSQLiteTestStore(t);
  const conversation = store.createConversation(
    "/workspace",
    "workspace_sandbox",
    { projectKey: "git:/repo/app/.git", projectRoot: "/repo/app" },
    "worktree",
  );
  const prompts: string[] = [];
  const toolNames: string[][] = [];
  const loadedFor: string[] = [];
  const events: AgentEvent[] = [];
  const service = new ConversationRunService({
    bytesPerToken: 1,
    conversationStore: store,
    workspaceRuntimeProvider: emptyWorkspaceRuntimeProvider,
    loadWorkspaceInstructions: noWorkspaceInstructions,
    async loadMemory(begunRun) {
      loadedFor.push(`${begunRun.projectKey}:${begunRun.workspaceRoot}`);
      return {
        status: { status: "truncated", nextLine: 201 },
        index: "- 集成测试需要先启动 Redis",
        nextLine: 201,
        store: new ProjectMemoryStore("/unused", "git:/repo/app/.git"),
      };
    },
    provider: provider((request) => {
      prompts.push(request.systemPrompt);
      toolNames.push(request.tools.map((tool) => tool.name));
      return finalTurn("done");
    }),
  });

  const run = service.startRun({
    conversationId: conversation.id,
    input: "run the integration tests",
  });
  for await (const source of run.events) events.push(source.event);

  assert.deepEqual(loadedFor, ["git:/repo/app/.git:/workspace"]);
  assert.match(prompts[0]!, /<project_memory>\n- 集成测试需要先启动 Redis\n<\/project_memory>/);
  assert.match(prompts[0]!, /Only part of the project memory index was loaded/);
  assert.ok(toolNames[0]!.includes("memory"));
  // 只有父 Run 拿到 memory 工具；子 Run 的 baseTools 在装配时不包含它。
  assert.equal(toolNames.length, 1);
  const started = events.find((event) => event.type === "run.started");
  assert.deepEqual(started, {
    v: 1,
    runId: run.runId,
    seq: 1,
    type: "run.started",
    data: { memory: { status: "truncated", nextLine: 201 } },
  });
});

test("keeps the run going without a memory block when project memory is unavailable", async (t) => {
  const { store } = createSQLiteTestStore(t);
  const conversation = store.createConversation("/workspace", "workspace_sandbox");
  const promptList: string[] = [];
  const toolNames: string[][] = [];
  const events: AgentEvent[] = [];
  const service = new ConversationRunService({
    bytesPerToken: 1,
    conversationStore: store,
    workspaceRuntimeProvider: emptyWorkspaceRuntimeProvider,
    loadWorkspaceInstructions: noWorkspaceInstructions,
    async loadMemory() {
      return {
        status: { status: "unavailable", reason: "identity" },
        index: "",
        nextLine: null,
      };
    },
    provider: provider((request) => {
      promptList.push(request.systemPrompt);
      toolNames.push(request.tools.map((tool) => tool.name));
      return finalTurn("answered anyway");
    }),
  });

  const run = service.startRun({ conversationId: conversation.id, input: "hello" });
  for await (const source of run.events) events.push(source.event);

  assert.doesNotMatch(promptList[0]!, /project_memory/);
  assert.ok(!toolNames[0]!.includes("memory"));
  const started = events.find((event) => event.type === "run.started");
  assert.deepEqual(
    started?.type === "run.started" ? started.data : undefined,
    { memory: { status: "unavailable", reason: "identity" } },
  );
  assert.equal(store.getConversation(conversation.id).turns[0]?.status, "completed");
});
