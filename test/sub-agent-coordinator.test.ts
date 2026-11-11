import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { AgentEventFactory, AgentEventType, type AgentEvent } from "../src/agent-events.js";
import { mergeAgentEvents } from "../src/agent-event-stream.js";
import type { RunEventSource } from "../src/run-stream.js";
import { streamAgentRun as streamAgentRunRaw } from "../src/agent-loop.js";
import { InMemoryInteractionBroker } from "../src/application/interaction-broker.js";
import { RunUsageLog } from "../src/run-usage.js";
import { SubAgentCoordinator } from "../src/sub-agent-coordinator.js";
import { createSubAgentTools, WAIT_AGENT_TOOL_NAME } from "../src/tools/sub-agents.js";
import { allowAllToolPermissionPolicy, AuthorizedToolExecutor } from "../src/tool-permissions.js";
import { defineTool, ToolExecutionError } from "../src/tools.js";
import type { TranscriptMessage } from "../src/transcript.js";
import { finalTurn, providerFromTurnFactory, toolCallTurn } from "./support/provider.js";
import { testRunOptions, testToolEnvironment, testRun } from "./support/agent-run-options.js";

function streamAgentRun(options: Parameters<typeof testRunOptions>[0]) {
  return streamAgentRunRaw(testRunOptions(options));
}

function userText(request: { transcript: readonly TranscriptMessage[] }): string | undefined {
  const message = request.transcript[0];
  return message?.role === "user" ? message.content : undefined;
}

function coordinator(options: {
  provider: ReturnType<typeof providerFromTurnFactory>;
  persist?: (finish: unknown) => void;
}) {
  return new SubAgentCoordinator({
    provider: options.provider,
    tools: [],
    systemPrompt: "You are a sub agent.",
    authorizedToolExecutor: new AuthorizedToolExecutor({ policy: allowAllToolPermissionPolicy }),
    toolPermissionContext: { workspaceRoot: "/workspace", executionMode: "full_access" },
    eventFactory: new AgentEventFactory("parent"),
    usageLog: new RunUsageLog(),
    persist: options.persist ?? (() => {}),
  });
}

test("a blocked child does not stop the parent from running an independent tool", async () => {
  let releaseChild!: () => void;
  const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
  const effects: string[] = [];
  const gate = defineTool({
    name: "gate",
    description: "Wait for the test to release the child.",
    inputSchema: z.strictObject({}),
    async execute() { await childGate; return { ok: true }; },
  });
  const independent = defineTool({
    name: "independent",
    description: "A parent-only operation.",
    inputSchema: z.strictObject({}),
    async execute() { effects.push("independent"); return { ran: true }; },
  });
  let childCalls = 0;
  let parentCalls = 0;
  const provider = providerFromTurnFactory((request) => {
    if (userText(request) === "slow child") {
      childCalls += 1;
      return childCalls === 1 ? toolCallTurn("gate", {}) : finalTurn("child done");
    }
    parentCalls += 1;
    if (parentCalls === 1) {
      return {
        type: "tool_calls",
        calls: [
          { callId: "delegate", name: "agent", arguments: JSON.stringify({ description: "slow", task: "slow child" }) },
          { callId: "independent", name: "independent", arguments: "{}" },
        ],
      };
    }
    return finalTurn("parent done");
  }, { contextWindowTokens: 64_000, maxOutputTokens: 4_000 });
  const parentUsage = new RunUsageLog();
  const subAgents = new SubAgentCoordinator({
    provider, tools: [gate], systemPrompt: "You are a sub agent.",
    authorizedToolExecutor: new AuthorizedToolExecutor({ policy: allowAllToolPermissionPolicy }),
    toolPermissionContext: { workspaceRoot: "/workspace", executionMode: "full_access" },
    eventFactory: new AgentEventFactory("parent"), usageLog: parentUsage, persist: () => {},
  });
  const events: AgentEvent[] = [];
  const childSources: RunEventSource[] = [];
  const run = (async () => {
    for await (const source of mergeAgentEvents({
      parentEvents: streamAgentRun({
        systemPrompt: "parent",
        provider,
        subAgents,
        transcript: [{ role: "user", content: "start" }],
        toolEnvironment: testToolEnvironment({
          tools: [
            ...createSubAgentTools({ coordinator: subAgents, onSteeringEnqueued: () => () => { } }), independent,
          ]
        }),
        run: { ...testRun(), usageLog: parentUsage }
      }),
      coordinator: subAgents, eventFactory: new AgentEventFactory("parent"),
    })) {
      events.push(source.event);
      if (source.subAgent !== undefined) childSources.push(source);
    }
  })();
  while (!effects.includes("independent")) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(effects, ["independent"]);
  assert.equal(subAgents.hasActive(), true);
  releaseChild();
  await run;
  assert.ok(events.some((event) => event.type === AgentEventType.StepStarted && event.step === 2));
  assert.ok(childSources.some((source) => source.event.type === AgentEventType.RunCompleted));
  assert.ok(childSources.every((source) => source.subAgent?.toolCallId === "delegate" && source.subAgent.parentStep === 1));
  assert.ok(events.some((event) => event.type === AgentEventType.RunCompleted));
});

test("wait_agent waits without another model call and wakes on the child result", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  let childCalls = 0;
  let parentCalls = 0;
  const provider = providerFromTurnFactory((request) => {
    calls += 1;
    if (userText(request) === "child") {
      childCalls += 1;
      return childCalls === 1 ? toolCallTurn("gate", {}) : finalTurn("done");
    }
    parentCalls += 1;
    if (parentCalls === 1) return toolCallTurn("agent", { description: "child", task: "child" }, "delegate");
    return parentCalls === 2 ? toolCallTurn("wait_agent", {}, "wait") : finalTurn("parent done");
  }, { contextWindowTokens: 64_000, maxOutputTokens: 4_000 });
  const childTool = defineTool({ name: "gate", description: "gate", inputSchema: z.strictObject({}), async execute() { await gate; return {}; } });
  const parentRun = testRun("parent");
  const usage = parentRun.usageLog;
  const subAgents = new SubAgentCoordinator({
    provider, tools: [childTool], systemPrompt: "You are a sub agent.",
    authorizedToolExecutor: new AuthorizedToolExecutor({ policy: allowAllToolPermissionPolicy }),
    toolPermissionContext: { workspaceRoot: "/workspace", executionMode: "full_access" },
    eventFactory: parentRun.eventFactory, usageLog: usage, persist: () => {},
  });
  const events: AgentEvent[] = [];
  const run = (async () => {
    for await (const source of mergeAgentEvents({
      parentEvents: streamAgentRun({
      systemPrompt: "parent",
      provider,
      subAgents,
      transcript: [{ role: "user", content: "wait" }],
      toolEnvironment: testToolEnvironment({ tools: createSubAgentTools({ coordinator: subAgents, onSteeringEnqueued: () => () => { } }) }),
      run: parentRun
    }), coordinator: subAgents, eventFactory: parentRun.eventFactory,
    })) events.push(source.event);
  })();
  while (!events.some((event) => event.type === AgentEventType.RunWaiting)) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 3, "the waiting tool must not poll the model");
  assert.equal(events.find((event) => event.type === AgentEventType.RunWaiting)?.step, 2);
  release();
  await run;
  assert.ok(events.some((event) => event.type === AgentEventType.RunCompleted));
});

test("the sixth active child is rejected and stopping keeps its slot", async () => {
  const provider = providerFromTurnFactory(() => new Promise<never>(() => {}), { contextWindowTokens: 64_000, maxOutputTokens: 4_000 });
  const c = coordinator({ provider });
  const children = Array.from({ length: 5 }, (_, i) => c.start({ description: `c${i}`, task: `c${i}`, toolCallId: `call-${i}` }));
  assert.equal(children.length, 5);
  assert.throws(() => c.start({ description: "sixth", task: "sixth", toolCallId: "sixth" }), (error: unknown) => error instanceof ToolExecutionError && error.code === "SUB_AGENT_LIMIT_REACHED");
  const stopping = c.requestStop(children[0]!.runId, "user_request");
  assert.equal(stopping.status, "stopping");
  assert.throws(() => c.start({ description: "still full", task: "still full", toolCallId: "still-full" }), (error: unknown) => error instanceof ToolExecutionError && error.code === "SUB_AGENT_LIMIT_REACHED");
  await c.close("parent_cancelled");
});

test("parent cancellation collects child outcomes and does not deliver a result twice", async () => {
  const provider = providerFromTurnFactory(() => new Promise<never>(() => {}), { contextWindowTokens: 64_000, maxOutputTokens: 4_000 });
  let saves = 0;
  const c = coordinator({ provider, persist: () => { saves += 1; } });
  const child = c.start({ description: "child", task: "child", toolCallId: "call" });
  assert.equal(c.takeReady().length, 0);
  await c.close("parent_cancelled");
  const first = c.takeReady();
  assert.equal(first.length, 1);
  assert.equal(first[0]!.runId, child.runId);
  assert.equal(c.takeReady().length, 0);
  assert.equal(saves, 1);
  assert.equal(first[0]!.status, "cancelled");
});

test("a persistence failure cannot produce a successful child terminal result", async () => {
  const provider = providerFromTurnFactory(() => finalTurn("done"), { contextWindowTokens: 64_000, maxOutputTokens: 4_000 });
  const c = coordinator({ provider, persist: () => { throw new Error("save failed"); } });
  const events: AgentEvent[] = [];
  c.addEventSink((event) => {
    if (event.kind === "child_event") events.push(event.event);
  });
  c.start({ description: "child", task: "child", toolCallId: "call" });
  await assert.rejects(c.waitForReadyOrSteering(() => () => {}), /save failed/);
  assert.equal(c.hasReady(), false);
  assert.ok(!events.some((event) => event.type === AgentEventType.AnswerCompleted || event.type === AgentEventType.RunCompleted));
  assert.ok(events.some((event) => event.type === AgentEventType.RunError && event.data.code === "SUB_AGENT_SAVE_FAILED"));
  assert.throws(() => c.throwIfFailed(), /save failed/);
  await c.close("parent_failed").catch((error) => assert.match(String(error), /save failed/));
});

test("a child approval event is visible while the parent provider is blocked", async () => {
  const broker = new InMemoryInteractionBroker();
  let releaseParent!: () => void;
  const parentGate = new Promise<void>((resolve) => { releaseParent = resolve; });
  const approvalTool = defineTool({
    name: "approval_tool", description: "Requires approval.", inputSchema: z.strictObject({}),
    impact: "Runs an approved test operation.", async execute() { return { approved: true }; },
  });
  let childCalls = 0;
  let parentCalls = 0;
  const provider = providerFromTurnFactory(async (request) => {
    if (userText(request) === "needs approval") {
      childCalls += 1;
      return childCalls === 1 ? toolCallTurn("approval_tool", {}, "approval-call") : finalTurn("approved");
    }
    parentCalls += 1;
    if (parentCalls === 1) return toolCallTurn("agent", { description: "approval", task: "needs approval" }, "delegate");
    await parentGate;
    return finalTurn("parent finished");
  }, { contextWindowTokens: 64_000, maxOutputTokens: 4_000 });
  const executor = new AuthorizedToolExecutor({
    interactionBroker: broker,
    policy: {
      isVisible: () => true,
      evaluate: (tool) => tool.name === "approval_tool"
        ? { effect: "confirm", ruleId: "test-confirm", reason: "Approval required." }
        : { effect: "allow", ruleId: "test-allow" },
    },
  });
  const usage = new RunUsageLog();
  const subAgents = new SubAgentCoordinator({
    provider, tools: [approvalTool], systemPrompt: "You are a sub agent.",
    authorizedToolExecutor: executor,
    toolPermissionContext: { workspaceRoot: "/workspace", executionMode: "full_access", conversationId: "conversation" },
    eventFactory: new AgentEventFactory("parent"), usageLog: usage, persist: () => {},
  });
  const iterator = mergeAgentEvents({
    parentEvents: streamAgentRun({
      systemPrompt: "parent",
      provider,
      subAgents,
      transcript: [{ role: "user", content: "parent" }],
      toolEnvironment: testToolEnvironment({ tools: createSubAgentTools({ coordinator: subAgents, onSteeringEnqueued: () => () => {} }) }),
      run: { ...testRun(), usageLog: usage }
    }),
    coordinator: subAgents, eventFactory: new AgentEventFactory("parent"),
  })[Symbol.asyncIterator]();
  let approval: RunEventSource | undefined;
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    if (next.value.subAgent !== undefined && next.value.event.type === AgentEventType.InteractionRequired) {
      approval = next.value;
      break;
    }
  }
  assert.ok(approval);
  assert.equal(approval.event.type, AgentEventType.InteractionRequired);
  assert.equal(broker.pendingCount, 1);
  const interactionId = approval.event.type === AgentEventType.InteractionRequired
    ? approval.event.interactionId
    : "";
  assert.equal(broker.resolve(interactionId, { decision: "approve" }).status, "accepted");
  releaseParent();
  await iterator.return?.();
  await subAgents.close("parent_cancelled").catch(() => {});
});

test("a parent step limit closes active children before the final step_limit callback", async () => {
  let releaseChild!: () => void;
  const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
  const gate = defineTool({ name: "gate", description: "gate", inputSchema: z.strictObject({}), async execute(_input, context) {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { context.signal?.removeEventListener("abort", abort); reject(context.signal?.reason); };
      context.signal?.addEventListener("abort", abort, { once: true });
      void childGate.then(() => { context.signal?.removeEventListener("abort", abort); resolve(); });
    });
    return {};
  } });
  let childCalls = 0;
  const provider = providerFromTurnFactory((request) => {
    if (userText(request) === "blocked") return childCalls++ === 0 ? toolCallTurn("gate", {}) : finalTurn("child");
    if (request.tools.length === 0) return finalTurn("step limit handoff");
    return toolCallTurn("agent", { description: "blocked", task: "blocked" }, "delegate");
  }, { contextWindowTokens: 64_000, maxOutputTokens: 4_000 });
  const usage = new RunUsageLog();
  let persisted = false;
  const subAgents = new SubAgentCoordinator({
    provider, tools: [gate], systemPrompt: "You are a sub agent.",
    authorizedToolExecutor: new AuthorizedToolExecutor({ policy: allowAllToolPermissionPolicy }),
    toolPermissionContext: { workspaceRoot: "/workspace", executionMode: "full_access" },
    eventFactory: new AgentEventFactory("parent"), usageLog: usage, persist: () => { persisted = true; },
  });
  let callback: { stopReason?: string; active: boolean; persisted: boolean } | undefined;
  const events: AgentEvent[] = [];
  for await (const source of mergeAgentEvents({
    parentEvents: streamAgentRun({
      systemPrompt: "parent",
      provider,
      subAgents,
      maxSteps: 2,
      transcript: [{ role: "user", content: "start" }],
      toolEnvironment: testToolEnvironment({ tools: createSubAgentTools({ coordinator: subAgents, onSteeringEnqueued: () => () => { } }) }),
      run: { ...testRun(), usageLog: usage },
      lifecycle: { beforeCompleted: ({ stopReason }) => { callback = { stopReason, active: subAgents.hasActive(), persisted }; }, beforeFailed: () => { throw new Error("unexpected parent failure"); } }
    }), coordinator: subAgents, eventFactory: new AgentEventFactory("parent"),
  })) events.push(source.event);
  releaseChild();
  assert.equal(callback?.stopReason, "step_limit");
  assert.equal(callback?.active, false);
  assert.equal(callback?.persisted, true);
  assert.equal(events.at(-1)?.type, AgentEventType.RunCompleted);
});

test("without a reserved handoff step, failure still persists and closes children first", async () => {
  const gate = defineTool({ name: "gate", description: "gate", inputSchema: z.strictObject({}), async execute(_input, context) {
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(context.signal?.reason);
      context.signal?.addEventListener("abort", abort, { once: true });
    });
    return {};
  } });
  const provider = providerFromTurnFactory((request) => userText(request) === "blocked"
    ? toolCallTurn("gate", {})
    : toolCallTurn("agent", { description: "blocked", task: "blocked" }, "delegate"), { contextWindowTokens: 64_000, maxOutputTokens: 4_000 });
  const usage = new RunUsageLog();
  let persisted = false;
  let failed: { active: boolean; persisted: boolean } | undefined;
  const subAgents = new SubAgentCoordinator({
    provider, tools: [gate], systemPrompt: "You are a sub agent.",
    authorizedToolExecutor: new AuthorizedToolExecutor({ policy: allowAllToolPermissionPolicy }),
    toolPermissionContext: { workspaceRoot: "/workspace", executionMode: "full_access" },
    eventFactory: new AgentEventFactory("parent"), usageLog: usage, persist: () => { persisted = true; },
  });
  for await (const _event of streamAgentRun({
    systemPrompt: "parent",
    provider,
    subAgents,
    maxSteps: 1,
    transcript: [{ role: "user", content: "start" }],
    toolEnvironment: testToolEnvironment({ tools: createSubAgentTools({ coordinator: subAgents, onSteeringEnqueued: () => () => { } }) }),
    run: { ...testRun(), usageLog: usage },
    lifecycle: { beforeFailed: () => { failed = { active: subAgents.hasActive(), persisted }; } }
  })) { /* consume */ }
  assert.deepEqual(failed, { active: false, persisted: true });
});

test("a mixed wait batch returns an error while the other tool still runs", async () => {
  const effects: string[] = [];
  const independent = defineTool({
    name: "independent", description: "independent", inputSchema: z.strictObject({}),
    async execute() { effects.push("ran"); return { ran: true }; },
  });
  let calls = 0;
  let completedTranscript: readonly import("../src/transcript.js").TranscriptMessage[] | undefined;
  const provider = providerFromTurnFactory((request) => {
    calls += 1;
    if (calls === 1) {
      return {
        type: "tool_calls",
        calls: [
          { callId: "wait", name: WAIT_AGENT_TOOL_NAME, arguments: "{}" },
          { callId: "independent", name: "independent", arguments: "{}" },
        ],
      };
    }
    return finalTurn("done");
  }, { contextWindowTokens: 64_000, maxOutputTokens: 4_000 });
  const subAgents = coordinator({ provider });
  for await (const _event of streamAgentRun({
    systemPrompt: "parent",
    provider,
    subAgents,
    transcript: [{ role: "user", content: "mixed batch" }],
    toolEnvironment: testToolEnvironment({ tools: [...createSubAgentTools({ coordinator: subAgents, onSteeringEnqueued: () => () => { } }), independent] }),
    lifecycle: { beforeCompleted: ({ transcript }) => { completedTranscript = transcript; } }
  })) { /* consume */ }
  assert.deepEqual(effects, ["ran"]);
  assert.equal(calls, 2);
  const toolBatch = completedTranscript?.find((message) => message.role === "tool");
  assert.ok(toolBatch);
  if (toolBatch?.role === "tool") {
    assert.equal(toolBatch.results.length, 2);
    const waitResult = toolBatch.results.find((result) => result.toolCallId === "wait");
    const independentResult = toolBatch.results.find((result) => result.toolCallId === "independent");
    assert.equal(waitResult?.result.status, "error");
    assert.equal(independentResult?.result.status, "success");
  }
  const assistant = completedTranscript?.find((message) => message.role === "assistant");
  assert.ok(assistant?.role === "assistant" && assistant.content === null && assistant.toolCalls.length === 2);
});
