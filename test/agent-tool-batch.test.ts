import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  executeAgentToolBatch,
  ToolBatchInterruptedError,
  type AgentToolBatchResult,
} from "../src/agent-tool-batch.js";
import { AgentEventFactory } from "../src/agent-events.js";
import type { NativeToolCall } from "../src/provider-protocol.js";
import { InMemoryInteractionBroker } from "../src/application/interaction-broker.js";
import {
  allowAllToolPermissionPolicy,
  AuthorizedToolExecutor,
  FixedToolPermissionPolicy,
} from "../src/tool-permissions.js";
import { defineTool, ToolRegistry, type Tool } from "../src/tools.js";

const factory = new AgentEventFactory("batch-run");

function toolCall(name: string, callId: string): NativeToolCall {
  return { callId, name, arguments: "{}" };
}

function resultCode(result: AgentToolBatchResult): string {
  return result.result.status === "error"
    ? result.result.error.code
    : "success";
}

function resultMessage(result: AgentToolBatchResult): string {
  return result.result.status === "error" ? result.result.error.message : "";
}

test("interrupted batch keeps real, running, and not_started results in call order", async () => {
  // Force serial execution with non-parallel-safe names so only one call runs at
  // a time: "first" completes (real result), "second" is gated (running at cancel),
  // "third" stays queued (not_started).
  let secondStarted!: () => void;
  const secondStartedP = new Promise<void>((resolve) => (secondStarted = resolve));
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));

  const first = defineTool({
    name: "first",
    description: "Completes immediately.",
    inputSchema: z.strictObject({}),
    execute() {
      return Promise.resolve("first-result");
    },
  });
  const second = defineTool({
    name: "second",
    description: "Runs until released.",
    inputSchema: z.strictObject({}),
    async execute(_input, context) {
      secondStarted();
      await new Promise<void>((resolve, reject) => {
        context.signal?.addEventListener("abort", () =>
          reject(context.signal?.reason ?? new Error("aborted"))
        );
        secondGate.then(resolve);
      });
      return "second-result";
    },
  });
  const third = defineTool({
    name: "third",
    description: "Never reached because it stays queued.",
    inputSchema: z.strictObject({}),
    execute() {
      return Promise.resolve("third-result");
    },
  });

  const calls = [
    toolCall("first", "call-first"),
    toolCall("second", "call-second"),
    toolCall("third", "call-third"),
  ];
  const controller = new AbortController();

  const iterator = executeAgentToolBatch({
    calls,
    stepNumber: 1,
    registry: new ToolRegistry([first, second, third]),
    eventFactory: factory,
    signal: controller.signal,
    authorizedToolExecutor: new AuthorizedToolExecutor({
      policy: allowAllToolPermissionPolicy,
    }),
    toolPermissionContext: { workspaceRoot: "/workspace", runId: "batch-run" },
  })[Symbol.asyncIterator]();

  // Drive the generator in the background; it blocks once the second tool is running.
  const drive = (async () => {
    try {
      for (;;) await iterator.next();
    } catch (error) {
      return error;
    }
  })();

  await secondStartedP;
  controller.abort(new Error("cancelled"));
  releaseSecond();

  const error = await drive;
  assert.ok(error instanceof ToolBatchInterruptedError, String(error));
  const results = (error as ToolBatchInterruptedError).results;
  assert.equal(results.length, 3);
  assert.equal(results[0]!.toolCallId, "call-first");
  assert.equal(resultCode(results[0]!), "success");
  assert.equal(results[1]!.toolCallId, "call-second");
  assert.equal(resultCode(results[1]!), "TOOL_INTERRUPTED");
  assert.match(resultMessage(results[1]!), /执行期间被用户取消/);
  assert.equal(results[2]!.toolCallId, "call-third");
  assert.equal(resultCode(results[2]!), "TOOL_INTERRUPTED");
  assert.match(resultMessage(results[2]!), /执行这个工具之前被用户取消/);
});

test("in-flight call that finished just before cancel keeps its real result", async () => {
  let secondStarted!: () => void;
  const secondStartedP = new Promise<void>((resolve) => (secondStarted = resolve));

  const completed = defineTool({
    name: "read",
    description: "Finishes immediately.",
    inputSchema: z.strictObject({}),
    execute() {
      return Promise.resolve("done");
    },
  });
  const pending = defineTool({
    name: "grep",
    description: "Runs until aborted.",
    inputSchema: z.strictObject({}),
    execute(_input, context) {
      secondStarted();
      return new Promise<never>((_resolve, reject) => {
        context.signal?.addEventListener("abort", () =>
          reject(context.signal?.reason ?? new Error("aborted"))
        );
      });
    },
  });

  const controller = new AbortController();
  const iterator = executeAgentToolBatch({
    calls: [toolCall("read", "call-a"), toolCall("grep", "call-b")],
    stepNumber: 1,
    registry: new ToolRegistry([completed, pending]),
    eventFactory: factory,
    signal: controller.signal,
    authorizedToolExecutor: new AuthorizedToolExecutor({
      policy: allowAllToolPermissionPolicy,
    }),
    toolPermissionContext: { workspaceRoot: "/workspace", runId: "batch-run" },
  })[Symbol.asyncIterator]();

  const drive = (async () => {
    try {
      for (;;) await iterator.next();
    } catch (error) {
      return error;
    }
  })();

  // Wait until the second (last of the two) has launched; the first has already
  // finished and its completion has been processed by the batch loop.
  await secondStartedP;
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("cancelled"));

  const error = await drive;
  assert.ok(error instanceof ToolBatchInterruptedError, String(error));
  const results = (error as ToolBatchInterruptedError).results;
  assert.equal(results.length, 2);
  assert.equal(resultCode(results[0]!), "success");
  assert.deepEqual(
    results[0]!.result.status === "success" ? results[0]!.result.output : null,
    "done",
  );
  assert.equal(resultCode(results[1]!), "TOOL_INTERRUPTED");
});

test("an in-flight tool that ignores the signal keeps its result after cancel", async () => {
  let started!: () => void;
  const startedP = new Promise<void>((resolve) => (started = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));

  // 不理会 context.signal：取消后照常返回结果，而不是 reject。
  const stubborn = defineTool({
    name: "read",
    description: "Ignores the abort signal.",
    inputSchema: z.strictObject({}),
    async execute() {
      started();
      await gate;
      return "stubborn-result";
    },
  });

  const controller = new AbortController();
  const iterator = executeAgentToolBatch({
    calls: [toolCall("read", "call-a")],
    stepNumber: 1,
    registry: new ToolRegistry([stubborn]),
    eventFactory: factory,
    signal: controller.signal,
    authorizedToolExecutor: new AuthorizedToolExecutor({
      policy: allowAllToolPermissionPolicy,
    }),
    toolPermissionContext: { workspaceRoot: "/workspace", runId: "batch-run" },
  })[Symbol.asyncIterator]();

  const drive = (async () => {
    try {
      for (;;) await iterator.next();
    } catch (error) {
      return error;
    }
  })();

  await startedP;
  controller.abort(new Error("cancelled"));
  release(); // 工具在取消窗口内返回真实结果。

  const error = await drive;
  assert.ok(error instanceof ToolBatchInterruptedError, String(error));
  const results = (error as ToolBatchInterruptedError).results;
  assert.equal(resultCode(results[0]!), "success");
  assert.deepEqual(
    results[0]!.result.status === "success" ? results[0]!.result.output : null,
    "stubborn-result",
  );
});

test("cancelling during approval marks the call not_started and cancelled", async () => {
  const controller = new AbortController();
  const broker = new InMemoryInteractionBroker();
  const authorizedToolExecutor = new AuthorizedToolExecutor({
    policy: new FixedToolPermissionPolicy({
      gated: { effect: "confirm", ruleId: "test:confirm" },
    }),
    interactionBroker: broker,
  });

  const gated = defineTool({
    name: "gated",
    description: "Needs approval.",
    inputSchema: z.strictObject({}),
    execute() {
      return Promise.resolve("ran");
    },
  });

  const iterator = executeAgentToolBatch({
    calls: [toolCall("gated", "call-a")],
    stepNumber: 1,
    registry: new ToolRegistry([gated]),
    eventFactory: factory,
    signal: controller.signal,
    authorizedToolExecutor,
    toolPermissionContext: { workspaceRoot: "/workspace", runId: "batch-run" },
  })[Symbol.asyncIterator]();

  // Drive until it's waiting for approval, then cancel.
  const drive = (async () => {
    try {
      for (;;) await iterator.next();
    } catch (error) {
      return error;
    }
  })();

  while (broker.pendingCount === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  controller.abort(new Error("cancelled"));

  const error = await drive;
  assert.ok(error instanceof ToolBatchInterruptedError, String(error));
  const results = (error as ToolBatchInterruptedError).results;
  assert.equal(resultCode(results[0]!), "TOOL_INTERRUPTED");
  assert.match(resultMessage(results[0]!), /执行这个工具之前被用户取消/);
});

test("an unexpected batch error produces failed reasoning with the original cause", async () => {
  const boom = new Error("boom");
  // preflight throwing is the one genuinely non-cancel error that escapes the
  // tool's execute wrapper and reaches the batch's error path.
  const failing = defineTool({
    name: "read",
    description: "Throws during preflight.",
    inputSchema: z.strictObject({}),
    async preflight() {
      throw boom;
    },
    execute() {
      return Promise.resolve("never");
    },
  });

  await assert.rejects(
    () =>
      executeAgentToolBatch({
        calls: [toolCall("read", "call-a")],
        stepNumber: 1,
        registry: new ToolRegistry([failing]),
        eventFactory: factory,
        authorizedToolExecutor: new AuthorizedToolExecutor({
          policy: allowAllToolPermissionPolicy,
        }),
        toolPermissionContext: { workspaceRoot: "/workspace", runId: "batch-run" },
      })[Symbol.asyncIterator]().next(),
    (error: unknown) => {
      assert.ok(error instanceof ToolBatchInterruptedError, String(error));
      const wrapped = error as ToolBatchInterruptedError;
      assert.equal(wrapped.cause, boom);
      assert.equal(resultCode(wrapped.results[0]!), "TOOL_INTERRUPTED");
      // Not started: the call never reached tool.started.
      assert.match(resultMessage(wrapped.results[0]!), /执行这个工具之前出错结束/);
      return true;
    },
  );
});
