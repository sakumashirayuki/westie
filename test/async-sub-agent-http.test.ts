import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent, RunSnapshotData } from "../src/agent-events.js";
import type { RunStreamRecord } from "../src/run-stream.js";
import { createAsyncSubAgentFixture } from "./support/async-sub-agent-fixture.js";

type TestEvent = (AgentEvent | { readonly type: "run.snapshot"; readonly data: RunSnapshotData; readonly runId: string; readonly streamSeq: number }) & { readonly streamSeq: number; readonly subAgent?: { readonly toolCallId: string; readonly parentStep: number } };
async function* readSse(response: Response): AsyncGenerator<TestEvent> {
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      buffer += decoder.decode(result.value, { stream: true });
      let split: number;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
        if (data) {
          const record = JSON.parse(data) as RunStreamRecord;
          if ("snapshot" in record) {
            yield { type: "run.snapshot", runId: "snapshot", data: record.snapshot, streamSeq: record.streamSeq } as TestEvent;
          } else {
            yield { ...record.event, streamSeq: record.streamSeq, subAgent: record.subAgent } as TestEvent;
          }
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function until(
  stream: AsyncIterator<TestEvent>,
  predicate: (event: TestEvent) => boolean,
): Promise<TestEvent[]> {
  const events: TestEvent[] = [];
  while (true) {
    const next = await stream.next();
    assert.equal(next.done, false, "Run ended before the expected event.");
    events.push(next.value);
    if (predicate(next.value)) return events;
  }
}

test("HTTP steering, child approval cancellation and snapshot reconnect share one live run", { timeout: 20_000 }, async (t) => {
  const fixture = await createAsyncSubAgentFixture({ eventLogMaxBytes: 512, retentionMs: 20 });
  t.after(() => fixture.close());
  const signal = AbortSignal.timeout(15_000);
  const post = (path: string, body?: unknown) => fetch(fixture.origin + path, {
    method: "POST", signal,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const inspected = await post("/v1/agent/conversations:select-workspace", { action: "inspect" });
  assert.equal(inspected.status, 200);
  const { selectionToken } = await inspected.json() as { selectionToken: string };
  const created = await post("/v1/agent/conversations:open", {
    selectionToken,
    executionMode: "workspace_sandbox",
    workspace: { kind: "selected_directory" },
  });
  assert.equal(created.status, 201);
  const conversation = await created.json() as { id: string };
  const base = `/v1/agent/conversations/${conversation.id}`;
  const response = await post(`${base}/runs:stream`, { input: "并行检查两个子任务" });
  const runId = response.headers.get("x-run-id")!;
  assert.ok(runId);
  const stream = readSse(response);
  const seen: TestEvent[] = [];
  let approval: Extract<TestEvent, { type: "interaction.required" }> | undefined;
  let waiting = false;
  seen.push(...await until(stream, (event) => {
    if (event.type === "interaction.required") approval = event as typeof approval;
    if (event.type === "run.waiting") waiting = true;
    return approval !== undefined && waiting;
  }));
  assert.ok(approval);
  const childId = approval.runId;
  const callsWhileWaiting = fixture.parentCalls();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fixture.parentCalls(), callsWhileWaiting, "Waiting must not poll the model.");
  assert.equal(fixture.registry.get(runId)?.state, "awaiting_interaction");

  // Reconnecting uses the running projection, without starting another run.
  await stream.return(undefined);
  const replay = await fetch(`${fixture.origin}${base}/runs/${runId}/events`, { signal });
  assert.equal(replay.status, 410);
  assert.equal((await replay.json() as { error: { code: string } }).error.code, "RUN_STREAM_NOT_REPLAYABLE");
  const snapshotStream = readSse(await fetch(`${fixture.origin}${base}/runs/${runId}/events?snapshot=1`, { signal }));
  const snapshot = (await snapshotStream.next()).value as TestEvent;
  assert.equal(snapshot.type, "run.snapshot");
  if (snapshot.type !== "run.snapshot") assert.fail("Expected snapshot.");
  assert.equal(snapshot.data.children.length, 2);
  assert.equal(snapshot.data.waitingForSubAgents, true);
  assert.deepEqual(snapshot.data.pendingInteractions.map((entry) => entry.interactionId), [approval.interactionId]);

  const steer = await post(`${base}/runs:steer`, { runId, input: "处理追加要求" });
  assert.equal(steer.status, 202);
  const resumed = await until(snapshotStream, (event) => event.type === "tool.completed" && event.data.name === "probe");
  assert.ok(resumed.some((event) => event.type === "steering.applied"));
  assert.deepEqual(fixture.effects, ["parent"]);
  await until(snapshotStream, (event) => event.type === "run.waiting");

  const other = fixture.store.createConversation(fixture.workspaceRoot, "workspace_sandbox");
  const wrongParent = await post(`/v1/agent/conversations/${other.id}/runs/${runId}/sub-agents/${childId}:cancel`);
  assert.equal(wrongParent.status, 404);
  const unknownChild = await post(`${base}/runs/${runId}/sub-agents/unknown:cancel`);
  assert.equal(unknownChild.status, 404);
  const cancel = await post(`${base}/runs/${runId}/sub-agents/${childId}:cancel`);
  assert.equal(cancel.status, 202);
  const cancelled = await until(snapshotStream, (event) => event.runId === childId && event.type === "run.cancelled");
  assert.ok(cancelled.some((event) => event.type === "subagent.stopping"));
  const lateApproval = await post(`/v1/agent/interactions/${approval.interactionId}:respond`, { response: { decision: "approve" } });
  assert.equal(lateApproval.status, 410);
  assert.equal(fixture.effects.includes("approval"), false);
  assert.equal(fixture.registry.get(runId)?.state, "waiting_sub_agents");
  assert.ok(fixture.store.getConversation(conversation.id).turns[0]!.runs[0]!.subAgentRuns.some((child) => child.id === childId && child.status === "cancelled"));
  const again = await post(`${base}/runs/${runId}/sub-agents/${childId}:cancel`);
  assert.equal(again.status, 200);

  fixture.release();
  const end = await until(snapshotStream, (event) => event.type === "run.completed" && event.subAgent === undefined);
  assert.ok(end.some((event) => event.type === "run.completed" && event.runId === runId));
  assert.equal(end.filter((event) => event.type === "answer.completed" && event.subAgent === undefined).length, 1);
  assert.deepEqual(fixture.effects, ["parent", "slow"]);
  await snapshotStream.return(undefined);
  const history = fixture.store.getConversation(conversation.id).turns[0]!;
  assert.equal(history.status, "completed");
  assert.deepEqual(history.runs[0]!.subAgentRuns.map((child) => child.status).sort(), ["cancelled", "completed"]);
  assert.equal(history.runs[0]!.subAgentRuns.find((child) => child.status === "completed")?.stopReason, "final");
  assert.equal(fixture.registry.get(runId)?.subAgents?.hasActiveChildren(), false);
  const terminalStream = readSse(await fetch(`${fixture.origin}${base}/runs/${runId}/events?snapshot=1`, { signal }));
  const terminal = (await terminalStream.next()).value as TestEvent;
  assert.equal(terminal.type, "run.snapshot");
  if (terminal.type !== "run.snapshot") assert.fail("Expected terminal snapshot.");
  assert.equal(terminal.data.status, "completed");
  assert.equal(terminal.data.pendingInteractions.length, 0);
  assert.ok(terminal.data.children.every((child) => ["completed", "cancelled"].includes(child.status)));
  assert.ok(terminal.data.children.find((child) => child.status === "completed")?.answer?.includes("slow evidence"));
  await terminalStream.return(undefined);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fixture.registry.get(runId), undefined);
  const historicalCancel = await post(`${base}/runs/${runId}/sub-agents/${childId}:cancel`);
  assert.equal(historicalCancel.status, 200);
});
