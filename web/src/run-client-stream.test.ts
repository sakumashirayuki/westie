import { describe, expect, it, vi } from "vitest";

import { emptyRunUsageTotals, type RunSnapshotData } from "./events";
import {
  cancelConversationRun,
  HttpRunError,
  subscribeConversationRun,
  parseRunStreamRecord,
} from "./run-client";

const encoder = new TextEncoder();

function sseResponse(
  frames: string[],
  headers: Record<string, string> = {},
): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream; charset=utf-8", ...headers } },
  );
}

function event(type: string, seq: number, data: object, step?: number) {
  return { v: 1, runId: "run-1", seq, type, ...(step === undefined ? {} : { step }), data };
}

function record(eventValue: ReturnType<typeof event>, streamSeq = eventValue.seq) {
  return { streamSeq, event: eventValue };
}

const usage = emptyRunUsageTotals();

describe("subscribeConversationRun", () => {
  it("uses streamSeq for parent and child events even when their event seq matches", async () => {
    const parent = event("run.started", 1, {});
    const child = { ...event("run.started", 1, {}), runId: "child-1" };
    const seen: Array<{ runId: string; source?: string }> = [];
    const parentRecord = parseRunStreamRecord({ streamSeq: 1, event: parent });
    const childRecord = parseRunStreamRecord({ streamSeq: 2, event: child, subAgent: { toolCallId: "call-1", parentStep: 1 } });
    const terminalRecord = parseRunStreamRecord({ streamSeq: 3, event: event("run.completed", 2, { steps: 1, stopReason: "final", usage }) });
    for (const record of [parentRecord, childRecord, terminalRecord]) {
      if ("event" in record) seen.push({ runId: record.event.runId, source: record.subAgent?.toolCallId });
    }
    expect(seen).toEqual([
      { runId: "run-1", source: undefined },
      { runId: "child-1", source: "call-1" },
      { runId: "run-1", source: undefined },
    ]);
  });

  it("deduplicates transport positions while preserving overlapping native event numbers", async () => {
    const records = [
      record(event("run.started", 1, {}), 2),
      { streamSeq: 3, event: { ...event("run.started", 1, {}), runId: "child" }, subAgent: { toolCallId: "child-call", parentStep: 1 } },
      record(event("run.completed", 2, { steps: 1, stopReason: "final", usage }), 4),
    ];
    const onEvent = vi.fn();
    await subscribeConversationRun("c1", "run-1", {
      signal: new AbortController().signal, after: 2, onEvent,
      fetch: vi.fn(async () => sseResponse([records[0], records[1], records[1], records[2]].map(value => `data: ${JSON.stringify(value)}\n\n`))),
    });
    expect(onEvent.mock.calls.map(([event]) => [event.runId, event.seq])).toEqual([["child", 1], ["run-1", 2]]);
  });

  it("resumes live events after a snapshot jumps beyond the old cursor", async () => {
    const snapshot = { status: "running", waitingForSubAgents: false, children: [], pendingInteractions: [] };
    const onSnapshot = vi.fn();
    const onEvent = vi.fn();
    const onStreamSeq = vi.fn();
    await subscribeConversationRun("c1", "run-1", {
      signal: new AbortController().signal, after: 2, snapshot: true, onSnapshot, onEvent, onStreamSeq,
      fetch: vi.fn(async () => sseResponse([
        `data: ${JSON.stringify({ streamSeq: 20, snapshot })}\n\n`,
        `data: ${JSON.stringify(record(event("run.completed", 8, { steps: 1, stopReason: "final", usage }), 21))}\n\n`,
      ])),
    });
    expect(onSnapshot).toHaveBeenCalledWith(snapshot);
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onStreamSeq.mock.calls).toEqual([[20], [21]]);
  });

  it("accepts a zero-position snapshot but rejects a zero-position event", () => {
    const snapshot = { status: "running", waitingForSubAgents: false, children: [], pendingInteractions: [] };
    expect(parseRunStreamRecord({ streamSeq: 0, snapshot })).toEqual({ streamSeq: 0, snapshot });
    expect(() => parseRunStreamRecord(record(event("run.started", 1, {}), 0))).toThrow();
  });

  it("sends after and parses 410 into HttpRunError", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          error: { code: "RUN_STREAM_NOT_REPLAYABLE", message: "gone" },
        }),
        { status: 410, headers: { "Content-Type": "application/json" } }
      )
    );
    await expect(subscribeConversationRun("c1", "run-1", {
      signal: new AbortController().signal,
      after: 3,
      onEvent: vi.fn(),
      fetch: fetcher,
    })).rejects.toMatchObject({
      name: "HttpRunError",
      status: 410,
      code: "RUN_STREAM_NOT_REPLAYABLE",
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("/runs/run-1/events?after=3");
  });

  it("replays events and reports runId", async () => {
    const frames = [
      event("run.started", 1, {}),
      event("run.completed", 2, { steps: 1, stopReason: "final", usage }),
    ].map((value) => `event: ${value.type}\ndata: ${JSON.stringify(record(value))}\n\n`);
    const seen: string[] = [];
    await subscribeConversationRun("c1", "run-1", {
      signal: new AbortController().signal,
      onEvent: (value) => seen.push(value.type),
      fetch: vi.fn(async () => sseResponse(frames)),
    });
    expect(seen).toEqual(["run.started", "run.completed"]);
  });

  it("requests a snapshot without requiring seq greater than the cursor", async () => {
    const snapshot = {
      status: "running", waitingForSubAgents: true, children: [], pendingInteractions: [],
    };
    const seen: string[] = [];
    await subscribeConversationRun("c1", "run-1", {
      signal: new AbortController().signal,
      after: 2,
      snapshot: true,
      onEvent: vi.fn(),
      onSnapshot: () => seen.push("snapshot"),
      fetch: vi.fn(async (url) => {
        expect(String(url)).toContain("/runs/run-1/events?snapshot=1");
        return sseResponse([`event: run.snapshot\ndata: ${JSON.stringify({ streamSeq: 2, snapshot })}\n\n`]);
      }),
    });
    expect(seen).toEqual(["snapshot"]);
  });

  it("consumes a terminal snapshot and completes at EOF", async () => {
    const terminal = event("run.completed", 3, {
      steps: 1,
      stopReason: "step_limit",
      usage,
    });
    const snapshot = {
      status: "completed",
      waitingForSubAgents: false,
      children: [],
      pendingInteractions: [],
      terminal,
      answer: "partial",
    };
    const seen: RunSnapshotData[] = [];
    await subscribeConversationRun("c1", "run-1", {
      signal: new AbortController().signal,
      after: 3,
      snapshot: true,
      onEvent: vi.fn(),
      onSnapshot: (snapshot) => seen.push(snapshot),
      fetch: vi.fn(async () => sseResponse([`event: run.snapshot\ndata: ${JSON.stringify({ streamSeq: 3, snapshot })}\n\n`])),
    });
    expect(seen).toEqual([snapshot]);
  });
});

describe("cancelConversationRun", () => {
  it("returns parsed response", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ runId: "run-1", status: "cancelling" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      })
    );
    await expect(cancelConversationRun("c1", "run-1", { fetch: fetcher }))
      .resolves.toEqual({ runId: "run-1", status: "cancelling" });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("/runs/run-1:cancel");
  });

  it("rejects 409 RUN_NOT_ACTIVE as HttpRunError", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ error: { code: "RUN_NOT_ACTIVE", message: "done" } }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      )
    );
    await expect(cancelConversationRun("c1", "run-1", { fetch: fetcher }))
      .rejects.toMatchObject({
        name: "HttpRunError",
        status: 409,
        code: "RUN_NOT_ACTIVE",
      });
  });
});
