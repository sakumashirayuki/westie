import assert from "node:assert/strict";
import test from "node:test";
import { AgentEventType } from "../src/agent-events.js";
import { ToolExecutionError } from "../src/tools.js";
import { RunRegistry } from "../src/application/run-registry.js";
import type { StartedConversationRun } from "../src/application/conversation-run-service.js";
import type { RunEventSource } from "../src/run-stream.js";

function service() {
  let n = 0;
  const children = new Map<string, { stop: number; status: "running" | "completed" }>();
  return {
    children,
    startRun(command: { signal: AbortSignal }): StartedConversationRun {
      const runId = `parent-${++n}`;
      const childId = `child-${n}`;
      children.set(childId, { stop: 0, status: "running" });
      const handle = {
        runId,
        cancelChild(id: string) {
          if (id !== childId) throw new ToolExecutionError("SUB_AGENT_NOT_FOUND", "missing");
          const child = children.get(id);
          if (child === undefined) throw new ToolExecutionError("SUB_AGENT_NOT_FOUND", "missing");
          if (child.status === "completed") return { runId: id, status: "completed" };
          child.stop++;
          child.status = "completed";
          return { runId: id, status: "stopping" };
        },
        activeChildren: () => [],
        snapshotChildren: () => [...children.entries()].filter(([id]) => id === childId).map(([id, value]) => ({ runId: id, toolCallId: "call", description: "x", status: value.status })),
        hasActiveChildren: () => false,
        finished: () => Promise.resolve(),
      } as unknown as StartedConversationRun["subAgents"];
      return { runId, subAgents: handle, events: (async function* (): AsyncGenerator<RunEventSource> { yield { event: { v: 1, runId, seq: 1, type: AgentEventType.RunStarted, data: {} } }; await new Promise<void>((resolve) => command.signal.addEventListener("abort", () => resolve(), { once: true })); })() };
    },
  };
}

test("child cancellation requires the owning parent run and is idempotent after completion", () => {
  const runService = service();
  const registry = new RunRegistry({ runService });
  registry.start({ conversationId: "c1", input: "one" });
  registry.start({ conversationId: "c2", input: "two" });
  assert.deepEqual(registry.cancelChild("parent-2", "child-1"), "not_found");
  assert.deepEqual(registry.cancelChild("parent-1", "unknown"), "not_found");
  assert.deepEqual(registry.cancelChild("parent-1", "child-1"), { runId: "child-1", status: "stopping" });
  assert.deepEqual(registry.cancelChild("parent-1", "child-1"), { runId: "child-1", status: "completed" });
});
