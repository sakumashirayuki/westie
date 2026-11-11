import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  AgentEventFactory,
  AgentEventType,
  type AgentEvent,
} from "../src/agent-events.js";
import { mergeAgentEvents } from "../src/agent-event-stream.js";
import type { RunEventSource } from "../src/run-stream.js";
import {
  streamAgentRun as streamAgentRunRaw,
  type SubAgentEndReason,
  type SubAgentRunControl,
  type SubAgentResult,
} from "../src/agent-loop.js";
import { MAX_SUB_AGENT_TASK_BYTES } from "../src/protocol.js";
import { RunUsageLog } from "../src/run-usage.js";
import { SUB_AGENT_MAX_STEPS } from "../src/sub-agent-limits.js";
import { startSubAgent, type RunningSubAgent } from "../src/sub-agent-runner.js";
import {
  allowAllToolPermissionPolicy,
  AuthorizedToolExecutor,
} from "../src/tool-permissions.js";
import { defineTool, ToolRegistry, ToolExecutionError } from "../src/tools.js";
import {
  STOP_AGENT_TOOL_NAME,
  WAIT_AGENT_TOOL_NAME,
  createSubAgentTools,
} from "../src/tools/sub-agents.js";
import type { TranscriptMessage } from "../src/transcript.js";
import { testRunOptions, testToolEnvironment, testRun } from "./support/agent-run-options.js";
import {
  finalTurn,
  providerFromTurnFactory,
  toolCallTurn,
} from "./support/provider.js";

function streamAgentRun(options: Parameters<typeof testRunOptions>[0]) {
  return streamAgentRunRaw(testRunOptions(options));
}

const echoTool = defineTool({
  name: "echo",
  description: "Returns the supplied text.",
  inputSchema: z.strictObject({ text: z.string() }),
  async execute(input) {
    return { text: input.text };
  },
});

const agentTool = defineTool({
  name: "agent",
  description: "Starts a sub agent.",
  inputSchema: z.strictObject({ description: z.string(), task: z.string() }),
  async execute() {
    return { runId: "child-1", status: "started" };
  },
});

function steering(): {
  take(): Promise<readonly { seq: number; content: string }[]>;
  hasPending(): boolean;
  onEnqueued(listener: () => void): () => void;
} {
  return {
    async take() {
      return [];
    },
    hasPending: () => false,
    onEnqueued: () => () => {},
  };
}

/**
 * 受控的协调器替身：测试自己安排子结果的到达时刻、活跃状态和等待唤醒，用来验证
 * 父循环的步骤边界行为。真实协调器另有自己的测试。
 */
class FakeSubAgents implements SubAgentRunControl {
  #ready: SubAgentResult[] = [];
  #active = false;
  #failure: unknown;
  #waiter: (() => void) | undefined;
  #woke = false;
  #pendingWait = false;
  readonly #child = {
    runId: "child-1",
    toolCallId: "call-agent",
    description: "d",
    status: "running" as const,
  };
  #sinks = new Set<(event: AgentEvent) => void>();
  closeReason: SubAgentEndReason | undefined;
  waitCalls = 0;

  addEventSink(sink: (event: AgentEvent) => void): () => void {
    this.#sinks.add(sink);
    return () => this.#sinks.delete(sink);
  }

  setActive(active: boolean): void {
    this.#active = active;
    if (!active) this.wake();
  }

  push(result: SubAgentResult): void {
    this.#ready.push(result);
    this.wake();
  }

  fail(error: unknown): void {
    this.#failure = error;
    this.wake();
  }

  /** 按合流器期望的展示事件形状推一条子事件。 */
  emitChildEvent(event: AgentEvent): void {
    for (const sink of [...this.#sinks]) {
      sink({ kind: "child_event", child: this.#child, event } as never);
    }
  }

  emit(event: AgentEvent): void {
    for (const sink of [...this.#sinks]) sink(event as never);
  }

  markWaiting(_toolCallId: string): void {}

  /**
   * 等到等待方真正挂起或已经收到唤醒。测试据此在确定的时间点推送子结果，
   * 不依赖定时器。
   */
  async nextWait(): Promise<void> {
    while (this.#waiter === undefined && !this.#woke) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.#woke = false;
  }

  takeReady(): readonly SubAgentResult[] {
    const ready = this.#ready;
    this.#ready = [];
    return ready;
  }

  hasActive(): boolean {
    return this.#active;
  }

  hasReady(): boolean {
    return this.#ready.length > 0;
  }

  takePendingWait(): boolean {
    const pending = this.#pendingWait;
    this.#pendingWait = false;
    return pending;
  }

  throwIfFailed(): void {
    if (this.#failure !== undefined) throw this.#failure;
  }

  async waitForReadyOrSteering(
    _subscribeSteering?: (listener: () => void) => () => void,
    signal?: AbortSignal,
  ): Promise<"child_result" | "steering" | "no_active_children"> {
    this.#pendingWait = true;
    for (;;) {
      signal?.throwIfAborted();
      this.waitCalls += 1;
      if (this.#failure !== undefined) throw this.#failure;
      if (this.#ready.length > 0) return "child_result";
      if (!this.#active) return "no_active_children";
      await new Promise<void>((resolve) => {
        this.#waiter = resolve;
        this.#woke = false;
      });
      this.#waiter = undefined;
    }
  }

  async close(reason: SubAgentEndReason): Promise<void> {
    this.closeReason = reason;
    this.#active = false;
    this.wake();
  }

  release(): void {}

  wake(): void {
    this.#woke = true;
    const resume = this.#waiter;
    this.#waiter = undefined;
    resume?.();
  }
}

test("returns a startup confirmation immediately and delivers the child report later", async () => {
  const subAgents = new FakeSubAgents();
  subAgents.setActive(true);
  const requests: TranscriptMessage[][] = [];
  let call = 0;
  const provider = providerFromTurnFactory((request) => {
    requests.push(request.transcript.map((message) => ({ ...message })));
    call += 1;
    if (call === 1) {
      return toolCallTurn("agent", { description: "d", task: "t" }, "call-agent");
    }
    if (call === 2) {
      // 启动确认只能说明子任务已经开始，父 Agent 仍需要在后续步骤继续工作。
      const results = [...request.transcript]
        .reverse()
        .find((message: TranscriptMessage) => message.role === "tool");
      assert.ok(results);
      if (results?.role === "tool") {
        assert.deepEqual(results.results[0]?.result, {
          type: "tool_result",
          tool: "agent",
          status: "success",
          output: { runId: "child-1", status: "started" },
        });
      }
      const report = request.transcript.find(
        (message) => message.role === "user" && "source" in message,
      );
      assert.equal(report, undefined);
      // 子任务仍在运行，候选 final 必须被屏障拦下。
      return finalTurn("premature answer");
    }
    return finalTurn("final answer with child evidence");
  }, { contextWindowTokens: 64_000, maxOutputTokens: 4_000 });

  const events: AgentEvent[] = [];
  const run = (async () => {
    for await (const event of streamAgentRun({
      systemPrompt: "Parent prompt.",
      provider,
      subAgents,
      steeringSource: steering(),
      transcript: [{ role: "user", content: "delegate" }],
      toolEnvironment: testToolEnvironment({ tools: [agentTool] })
    })) {
      events.push(event);
    }
  })();

  // 等到父循环真正进入等待（等价于父 Agent 调用 wait_agent），此时还没有子结果。
  await subAgents.nextWait();
  assert.equal(subAgents.hasReady(), false);
  subAgents.push({
    runId: "child-1",
    toolCallId: "call-agent",
    description: "d",
    status: "completed",
    stopReason: "final",
    answer: "child found src/api.ts:20",
  });
  subAgents.setActive(false);
  await run;

  // 被屏障拦下的候选 final 没有对外发布。
  const answered = events
    .filter(
      (event): event is Extract<AgentEvent, { type: "answer.completed" }> =>
        event.type === AgentEventType.AnswerCompleted,
    )
    .map((event) => event.data.answer);
  assert.deepEqual(answered, ["final answer with child evidence"]);
  // 子报告作为带来源的 user 消息进入下一次请求，且只交付一次。
  const lastRequest = requests.at(-1)!;
  const reports = lastRequest.filter(
    (message) => message.role === "user" && "source" in message,
  );
  assert.equal(reports.length, 1);
  const report = reports[0]!;
  assert.equal(report.role, "user");
  assert.ok("source" in report && report.source === "sub_agent");
  assert.ok("subAgentRunId" in report && report.subAgentRunId === "child-1");
  assert.match(report.content, /child found src\/api\.ts:20/);
  assert.equal(
    events.filter((event) => event.type === AgentEventType.RunCompleted).length,
    1,
  );
});

test("waits inside the tool without new model calls and wakes on a child report", async () => {
  const subAgents = new FakeSubAgents();
  subAgents.setActive(true);
  let providerCalls = 0;
  const provider = providerFromTurnFactory(() => {
    providerCalls += 1;
    return providerCalls === 1
      ? toolCallTurn(WAIT_AGENT_TOOL_NAME, {}, "call-wait")
      : finalTurn("after wait");
  }, { contextWindowTokens: 64_000, maxOutputTokens: 4_000 });

  const events: AgentEvent[] = [];
  const run = (async () => {
    for await (const event of streamAgentRun({
      systemPrompt: "Parent prompt.",
      provider,
      subAgents,
      steeringSource: steering(),
      transcript: [{ role: "user", content: "wait" }],
      toolEnvironment: testToolEnvironment({
        tools: createSubAgentTools({
          coordinator: subAgents as never,
          onSteeringEnqueued: () => () => { },
        })
      })
    })) {
      events.push(event);
    }
  })();

  await subAgents.nextWait();
  assert.equal(subAgents.waitCalls, 1);
  assert.equal(providerCalls, 1, "waiting does not call the model again");
  subAgents.push({
    runId: "child-1",
    toolCallId: "call-agent",
    description: "d",
    status: "completed",
    stopReason: "final",
    answer: "done",
  });
  subAgents.setActive(false);
  await run;

  assert.equal(providerCalls, 2);
  const waitResult = events.find(
    (event): event is Extract<AgentEvent, { type: "tool.completed" }> =>
      event.type === AgentEventType.ToolCompleted &&
      event.data.toolCallId === "call-wait",
  );
  assert.ok(waitResult !== undefined && waitResult.data.status === "success");
  assert.deepEqual(waitResult.data.result, { reason: "child_result" });
});

test("wakes a waiting run on steering and finishes in the next step", async () => {
  const subAgents = new FakeSubAgents();
  subAgents.setActive(true);
  let pending = false;
  let steeringListener: (() => void) | undefined;
  const taken: string[] = [];
  let providerCalls = 0;
  const provider = providerFromTurnFactory(() => {
    providerCalls += 1;
    return providerCalls === 1
      ? toolCallTurn(WAIT_AGENT_TOOL_NAME, {}, "call-wait")
      : finalTurn("answered the new request");
  }, { contextWindowTokens: 64_000, maxOutputTokens: 4_000 });

  const events: AgentEvent[] = [];
  const run = (async () => {
    for await (const event of streamAgentRun({
      systemPrompt: "Parent prompt.",
      provider,
      subAgents,
      steeringSource: {
        async take() {
          const messages = pending
            ? [{ seq: 0, content: "改用另一种做法" }]
            : [];
          pending = false;
          taken.push(...messages.map((message) => message.content));
          return messages;
        },
        hasPending: () => pending,
        onEnqueued: (listener) => {
          steeringListener = listener;
          return () => { };
        },
      },
      transcript: [{ role: "user", content: "wait" }],
      toolEnvironment: testToolEnvironment({
        tools: createSubAgentTools({
          coordinator: subAgents as never,
          onSteeringEnqueued: (listener) => {
            steeringListener = listener;
            return () => { };
          },
        })
      })
    })) {
      events.push(event);
    }
  })();

  // 真实队列：先入队再通知，等待者先注册通知再检查条件。
  await subAgents.nextWait();
  pending = true;
  steeringListener?.();
  // 第二步的模型回答需要它在工具等待被唤醒后产生；等循环真的走到那一步。
  await subAgents.nextWait();
  subAgents.setActive(false);
  await run;

  assert.deepEqual(taken, ["改用另一种做法"]);
  const applied = events.filter(
    (event): event is Extract<AgentEvent, { type: "steering.applied" }> =>
      event.type === AgentEventType.SteeringApplied,
  );
  assert.deepEqual(applied.map((event) => event.data.content), [
    "改用另一种做法",
  ]);
  assert.equal(
    events.some(
      (event) =>
        event.type === AgentEventType.RunCompleted &&
        event.data.stopReason === "final",
    ),
    true,
  );
});

test("keeps child progress identity and sequence separate from the parent stream", async () => {
  const subAgents = new FakeSubAgents();
  subAgents.setActive(true);
  let call = 0;
  const provider = providerFromTurnFactory(() => {
    call += 1;
    return call === 1
      ? toolCallTurn("agent", { description: "d", task: "t" }, "call-agent")
      : finalTurn("done");
  }, { contextWindowTokens: 64_000, maxOutputTokens: 4_000 });

  const sources: RunEventSource[] = [];
  const parentFactory = new AgentEventFactory("parent-run");
  const parentEventsSeen: AgentEvent[] = [];
  const parentEvents = (async function* () {
    for await (const event of streamAgentRun({
      systemPrompt: "Parent prompt.",
      provider,
      subAgents,
      steeringSource: steering(),
      transcript: [{ role: "user", content: "delegate" }],
      toolEnvironment: testToolEnvironment({ tools: [agentTool] }),
      run: { ...testRun("parent-run"), eventFactory: parentFactory }
    })) {
      // mergeAgentEvents 必须只包装 source，不能回写父事件的 seq 或其它字段。
      parentEventsSeen.push(event);
      yield Object.freeze(event);
    }
  })();
  const run = (async () => {
    for await (const source of mergeAgentEvents({
      parentEvents,
      coordinator: subAgents as never,
      eventFactory: parentFactory,
    })) {
      sources.push(source);
    }
  })();

  await subAgents.nextWait();
  const childEvent: AgentEvent = {
    v: 1,
    runId: "child-1",
    seq: 1,
    step: 1,
    type: AgentEventType.StepStarted,
    data: {},
  };
  Object.freeze(childEvent);
  subAgents.emitChildEvent(childEvent);
  await subAgents.nextWait();
  subAgents.setActive(false);
  await run;

  const childSource = sources.find((source) => source.subAgent !== undefined);
  assert.ok(childSource);
  assert.equal(childSource.subAgent?.toolCallId, "call-agent");
  assert.equal(childSource.subAgent?.parentStep, 1);
  assert.equal(childSource.event.runId, "child-1");
  assert.equal(childSource.event.seq, 1);
  assert.equal(childSource.event.type, AgentEventType.StepStarted);
  assert.strictEqual(childSource.event, childEvent);
  const parentSources = sources.filter((source) => source.subAgent === undefined);
  assert.equal(parentSources.at(-1)?.event.type, AgentEventType.RunCompleted);
  assert.ok(parentSources.every((source) => source.event.runId === "parent-run"));
  assert.deepEqual(parentSources.map((source) => source.event), parentEventsSeen);
  assert.deepEqual(parentEventsSeen.map((event) => event.seq), parentEventsSeen.map((_, i) => i + 1));
});

test("closes sub agents with the parent failure reason", async () => {
  const subAgents = new FakeSubAgents();
  subAgents.setActive(true);
  let call = 0;
  const provider = providerFromTurnFactory(() => {
    call += 1;
    return call === 1
      ? toolCallTurn(WAIT_AGENT_TOOL_NAME, {}, "call-wait")
      : finalTurn("never");
  }, { contextWindowTokens: 64_000, maxOutputTokens: 4_000 });

  const run = (async () => {
    for await (const _event of streamAgentRun({
      systemPrompt: "Parent prompt.",
      provider,
      subAgents,
      steeringSource: steering(),
      transcript: [{ role: "user", content: "wait" }],
      toolEnvironment: testToolEnvironment({
        tools: createSubAgentTools({
          coordinator: subAgents as never,
          onSteeringEnqueued: () => () => { },
        })
      })
    })) {
      // consume
    }
  })();

  await subAgents.nextWait();
  // 保存失败发生在等待期间：父 Run 必须在下一个安全边界失败收尾。
  subAgents.fail(new Error("sub agent record save failed"));
  subAgents.setActive(false);
  await run;
});

// ---- 工具边界 ----

test("validates the agent tool input before starting anything", async () => {
  let started = 0;
  const coordinator = {
    start() {
      started += 1;
      return { runId: "child-1", status: "started" as const };
    },
  };
  const registry = new ToolRegistry(
    createSubAgentTools({
      coordinator: coordinator as never,
      onSteeringEnqueued: () => () => {},
    }),
  );

  const emptyDescription = await registry.execute(
    "agent",
    { description: "   ", task: "t" },
    { toolCallId: "call-1" },
  );
  const oversized = await registry.execute(
    "agent",
    { description: "d", task: "字".repeat(MAX_SUB_AGENT_TASK_BYTES / 3 + 1) },
    { toolCallId: "call-2" },
  );
  const missingContext = await registry.execute("agent", {
    description: "d",
    task: "t",
  });

  assert.equal(emptyDescription.status, "error");
  assert.equal(oversized.status, "error");
  assert.equal(missingContext.status, "error");
  assert.equal(started, 0);
});

test("stops one sub agent and maps unknown ids to SUB_AGENT_NOT_FOUND", async () => {
  const coordinator = {
    requestStop(runId: string) {
      if (runId !== "child-1") {
        throw new ToolExecutionError(
          "SUB_AGENT_NOT_FOUND",
          `Sub agent ${runId} does not belong to this run.`,
        );
      }
      return { runId, status: "stopping" as const };
    },
  };
  const registry = new ToolRegistry(
    createSubAgentTools({
      coordinator: coordinator as never,
      onSteeringEnqueued: () => () => {},
    }),
  );

  const stopped = await registry.execute(STOP_AGENT_TOOL_NAME, {
    runId: "child-1",
    reason: "不再需要",
  });
  const unknown = await registry.execute(STOP_AGENT_TOOL_NAME, {
    runId: "child-9",
    reason: "不再需要",
  });
  const oversizedReason = await registry.execute(STOP_AGENT_TOOL_NAME, {
    runId: "child-1",
    reason: "字".repeat(400),
  });

  assert.deepEqual(stopped, {
    type: "tool_result",
    tool: STOP_AGENT_TOOL_NAME,
    status: "success",
    output: { runId: "child-1", status: "stopping" },
  });
  assert.equal(unknown.status, "error");
  if (unknown.status === "error") {
    assert.equal(unknown.error.code, "SUB_AGENT_NOT_FOUND");
  }
  assert.equal(oversizedReason.status, "error");
});

// ---- 子任务执行体 ----

test("hands the finished child run to persist with its stop reason and usage", async () => {
  const provider = providerFromTurnFactory((request) =>
    request.transcript.length === 1
      ? toolCallTurn("echo", { text: "x" }, "child-call")
      : finalTurn("done"), { contextWindowTokens: 64_000, maxOutputTokens: 4_000 }
  );
  const parentUsage = new RunUsageLog();
  const finishes: Array<{ status: string; stopReason?: string }> = [];
  const displayed: AgentEvent[] = [];
  const child: RunningSubAgent = startSubAgent({
    provider,
    tools: [echoTool],
    systemPrompt: "Child prompt.",
    toolCallId: "parent-call",
    description: "collect",
    task: "Echo x.",
    authorizedToolExecutor: new AuthorizedToolExecutor({
      policy: allowAllToolPermissionPolicy,
    }),
    toolPermissionContext: { workspaceRoot: "/workspace" },
    parentUsageLog: parentUsage,
    signal: new AbortController().signal,
    onEvent: (event) => displayed.push(event),
    persist: (finish) => {
      assert.ok(displayed.some((event) => event.type === AgentEventType.ToolCompleted));
      assert.ok(!displayed.some((event) => event.type === AgentEventType.AnswerCompleted || event.type === AgentEventType.RunCompleted));
      finishes.push({
        status: finish.record.status,
        ...(finish.record.stopReason === undefined
          ? {}
          : { stopReason: finish.record.stopReason }),
      });
    },
  });

  const record = await child.finished;
  assert.equal(record.status, "completed");
  assert.equal(record.stopReason, "final");
  assert.equal(record.finalAnswer, "done");
  assert.deepEqual(finishes, [{ status: "completed", stopReason: "final" }]);
  assert.equal(parentUsage.totals.calls, 2);
  assert.equal(
    parentUsage.calls.every(
      (call) => call.kind === "sub_agent" && call.subAgentRunId === child.runId,
    ),
    true,
  );
  assert.equal(
    displayed.some((event) => event.type === AgentEventType.AnswerCompleted),
    true,
  );
});

test("records a child that hits the step limit as completed with step_limit", async () => {
  let calls = 0;
  const provider = providerFromTurnFactory((request) => {
    calls += 1;
    return request.tools.length === 0
      ? finalTurn("handoff note")
      : toolCallTurn("echo", { text: String(calls) }, `call-${calls}`);
  }, { contextWindowTokens: 64_000, maxOutputTokens: 4_000 });
  const finishes: string[] = [];
  const child = startSubAgent({
    provider,
    tools: [echoTool],
    systemPrompt: "Child prompt.",
    toolCallId: "parent-call",
    description: "loop",
    task: "loop forever",
    authorizedToolExecutor: new AuthorizedToolExecutor({
      policy: allowAllToolPermissionPolicy,
    }),
    toolPermissionContext: { workspaceRoot: "/workspace" },
    parentUsageLog: new RunUsageLog(),
    signal: new AbortController().signal,
    onEvent: () => {},
    persist: (finish) =>
      finishes.push(`${finish.record.status}:${finish.record.stopReason}`),
  });

  const record = await child.finished;
  assert.equal(record.status, "completed");
  assert.equal(record.stopReason, "step_limit");
  assert.deepEqual(finishes, ["completed:step_limit"]);
  assert.equal(SUB_AGENT_MAX_STEPS, 128);
});

test("publishes a cancelled terminal event with the recorded usage", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = providerFromTurnFactory(async () => {
    await gate;
    return finalTurn("too late");
  }, { contextWindowTokens: 64_000, maxOutputTokens: 4_000 });
  const terminal: AgentEvent[] = [];
  const child = startSubAgent({
    provider,
    tools: [echoTool],
    systemPrompt: "Child prompt.",
    toolCallId: "parent-call",
    description: "cancel me",
    task: "wait forever",
    authorizedToolExecutor: new AuthorizedToolExecutor({
      policy: allowAllToolPermissionPolicy,
    }),
    toolPermissionContext: { workspaceRoot: "/workspace" },
    parentUsageLog: new RunUsageLog(),
    signal: new AbortController().signal,
    onEvent: (event) => {
      if (event.type === AgentEventType.RunCancelled || event.type === AgentEventType.RunCompleted || event.type === AgentEventType.RunError) terminal.push(event);
    },
    persist: () => {},
  });

  child.requestStop("no_longer_needed");
  release();
  const record = await child.finished;

  assert.equal(child.status, "stopping");
  assert.equal(record.status, "cancelled");
  assert.equal(record.stopReason, undefined);
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]!.type, AgentEventType.RunCancelled);
  if (terminal[0]!.type === AgentEventType.RunCancelled) {
    assert.equal(terminal[0]!.data.usage?.calls, 0);
  }
});
