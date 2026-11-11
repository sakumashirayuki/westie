import assert from "node:assert/strict";
import test from "node:test";
import { AgentEventType, type AgentEvent } from "../src/agent-events.js";
import { RunSnapshotProjection } from "../src/application/run-snapshot.js";
import type { RunEventSource } from "../src/run-stream.js";

const usage = { calls: 1, unmeasuredCalls: 0, inputTokens: 2, cachedInputTokens: 0, outputTokens: 3, reasoningTokens: 0 };
const child = { runId: "child-1", toolCallId: "call-1", description: "inspect", status: "running" as const };

function interaction(runId: string, id: string): AgentEvent {
  return { v: 1, runId, seq: 1, step: 1, type: AgentEventType.InteractionRequired, interactionId: id, kind: "tool_approval", expiresAt: "2030-01-01T00:00:00.000Z", payload: { toolCallId: "tool-1", toolName: "bash", ruleId: "r", argumentsDigest: "d", argumentsSummary: {}, risk: "r", impact: "i", grantOptions: [] }, data: {} };
}
function source(event: AgentEvent, toolCallId?: string): RunEventSource {
  return toolCallId === undefined ? { event } : { event, subAgent: { toolCallId, parentStep: 1 } };
}

test("snapshot keeps child final answer, usage, and stop reason", () => {
  const projection = new RunSnapshotProjection();
  projection.apply(source({ v: 1, runId: "parent", seq: 1, step: 1, type: AgentEventType.ToolStarted, data: { toolCallId: "call-1", name: "agent", arguments: { description: "inspect", task: "inspect" } } }));
  projection.apply(source({ v: 1, runId: "child-1", seq: 1, type: AgentEventType.RunStarted, data: {} }, "call-1"));
  projection.apply(source({ v: 1, runId: "child-1", seq: 2, step: 1, type: AgentEventType.AnswerCompleted, data: { answer: "found it" } }, "call-1"));
  projection.apply(source({ v: 1, runId: "child-1", seq: 3, type: AgentEventType.RunCompleted, data: { steps: 1, stopReason: "final", usage } }, "call-1"));
  const snapshot = projection.snapshot();
  assert.deepEqual(snapshot.children, [{ ...child, status: "completed", answer: "found it", stopReason: "final", usage }]);
});

test("snapshot clears child interaction when it stops and clears waiting at next step", () => {
  const projection = new RunSnapshotProjection();
  projection.apply(source({ v: 1, runId: "parent", seq: 1, step: 1, type: AgentEventType.RunWaiting, data: { reason: "sub_agents" } }));
  projection.apply(source(interaction("child-1", "i-1"), "call-1"));
  projection.apply(source({ v: 1, runId: "parent", seq: 2, step: 2, type: AgentEventType.StepStarted, data: {} }));
  assert.equal(projection.snapshot().waitingForSubAgents, false);
  assert.equal(projection.snapshot().pendingInteractions.length, 1);
  projection.apply(source({ v: 1, runId: "parent", seq: 3, step: 1, type: AgentEventType.SubAgentStopping, data: { runId: "child-1", toolCallId: "call-1", reason: "user_request" } }));
  assert.equal(projection.snapshot().pendingInteractions.length, 0);
});

test("snapshot carries the parent run memory state and ignores child memory", () => {
  const projection = new RunSnapshotProjection();
  projection.apply(source({ v: 1, runId: "parent", seq: 1, type: AgentEventType.RunStarted, data: { memory: { status: "truncated", nextLine: 201 } } }));
  assert.deepEqual(projection.snapshot().memory, { status: "truncated", nextLine: 201 });
  projection.apply(source({ v: 1, runId: "child-1", seq: 1, type: AgentEventType.RunStarted, data: { memory: { status: "ready" } } }, "call-1"));
  assert.deepEqual(projection.snapshot().memory, { status: "truncated", nextLine: 201 });

  const withoutMemory = new RunSnapshotProjection();
  withoutMemory.apply(source({ v: 1, runId: "legacy", seq: 1, type: AgentEventType.RunStarted, data: {} }));
  assert.equal(withoutMemory.snapshot().memory, undefined);
});

test("snapshot retains terminal event and answer", () => {
  const projection = new RunSnapshotProjection();
  projection.apply(source({ v: 1, runId: "parent", seq: 1, step: 1, type: AgentEventType.AnswerCompleted, data: { answer: "done" } }));
  const terminal: AgentEvent = { v: 1, runId: "parent", seq: 2, type: AgentEventType.RunCompleted, data: { steps: 1, stopReason: "final" as const, usage } };
  projection.apply(source(terminal));
  assert.equal(projection.snapshot().status, "completed");
  assert.equal(projection.snapshot().answer, "done");
  assert.deepEqual(projection.snapshot().terminal, terminal);
});
