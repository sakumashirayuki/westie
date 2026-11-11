import assert from "node:assert/strict";
import test from "node:test";
import { AgentEventFactory } from "../src/agent-events.js";
import { RunEventLog } from "../src/application/run-event-log.js";
import { RunRegistry } from "../src/application/run-registry.js";
import { emptyRunUsageTotals } from "../src/run-usage.js";
import { formatSseEvent } from "../src/http/sse.js";
import type { RunStreamRecord } from "../src/run-stream.js";

test("transport replay uses stream positions when parent and child event numbers overlap", async () => {
  const parent = new AgentEventFactory("parent");
  const child = new AgentEventFactory("child");
  const parentStarted = Object.freeze(parent.runStarted());
  const childStarted = Object.freeze(child.runStarted());
  const childAnswer = Object.freeze(child.answerCompleted(1, "child result"));
  const parentAnswer = Object.freeze(parent.answerCompleted(1, "parent result"));
  const relation = { toolCallId: "delegate", parentStep: 1 };
  const log = new RunEventLog();
  log.append({ event: parentStarted });
  log.append({ event: childStarted, subAgent: relation });
  log.append({ event: childAnswer, subAgent: relation });
  log.append({ event: parentAnswer });
  log.close();

  const replay: RunStreamRecord[] = [];
  for await (const record of log.subscribe(2, new AbortController().signal)) replay.push(record);
  assert.deepEqual(replay.map(record => record.streamSeq), [3, 4]);
  assert.ok("event" in replay[0]! && "event" in replay[1]!);
  assert.strictEqual(replay[0].event, childAnswer);
  assert.strictEqual(replay[1].event, parentAnswer);
  assert.equal(replay[0].event.seq, 2);
  assert.equal(replay[1].event.seq, 2);
  const frame = formatSseEvent(replay[0], "parent");
  assert.match(frame, /^id: parent:3\nevent: answer.completed\n/);
  const payload = JSON.parse(frame.split("\n").find(line => line.startsWith("data: "))!.slice(6));
  assert.deepEqual(payload, { streamSeq: 3, event: childAnswer, subAgent: relation });
  assert.equal(payload.event.runId, "child");
});

test("a zero-position snapshot has a transport cursor and no fabricated agent event", () => {
  const record: RunStreamRecord = {
    streamSeq: 0,
    snapshot: { status: "running", waitingForSubAgents: false, children: [], pendingInteractions: [] },
  };
  const frame = formatSseEvent(record, "parent");
  assert.match(frame, /^id: parent:0\nevent: run.snapshot\n/);
  const payload = JSON.parse(frame.split("\n").find(line => line.startsWith("data: "))!.slice(6));
  assert.deepEqual(payload, record);
  assert.equal("event" in payload, false);
});

test("child completion leaves the parent running and does not change its fallback error number", async () => {
  const parent = new AgentEventFactory("parent");
  const child = new AgentEventFactory("child");
  let failParent!: () => void;
  const gate = new Promise<void>(resolve => { failParent = resolve; });
  const registry = new RunRegistry({
    runService: {
      startRun() {
        return {
          runId: "parent",
          events: (async function* () {
            yield { event: parent.runStarted() };
            yield {
              event: { ...child.runCompleted(1, "final", emptyRunUsageTotals()), seq: 99 },
              subAgent: { toolCallId: "delegate", parentStep: 1 },
            };
            await gate;
            throw new Error("parent provider failed");
          })(),
        };
      },
    },
  });
  registry.start({ conversationId: "conversation", input: "task" });
  const iterator = registry.subscribe("parent", 0, new AbortController().signal)[Symbol.asyncIterator]();
  await iterator.next();
  const completedChild = (await iterator.next()).value as RunStreamRecord;
  assert.equal(completedChild.streamSeq, 2);
  assert.ok("event" in completedChild);
  assert.equal(completedChild.event.runId, "child");
  assert.equal(registry.get("parent")?.state, "running");
  failParent();
  const failedParent = (await iterator.next()).value as RunStreamRecord;
  assert.equal(failedParent.streamSeq, 3);
  assert.ok("event" in failedParent);
  assert.equal(failedParent.event.runId, "parent");
  assert.equal(failedParent.event.type, "run.error");
  assert.equal(failedParent.event.seq, 2);
  assert.equal((await iterator.next()).done, true);
});
