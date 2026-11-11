import { once } from "node:events";
import type { ServerResponse } from "node:http";
import type { Writable } from "node:stream";

import { AgentEventType, type AgentEvent } from "../agent-events.js";
import type { RunStreamRecord } from "../run-stream.js";

export function formatSseEvent(record: RunStreamRecord, parentRunId: string): string {
  const streamSeq = record.streamSeq;
  if ("snapshot" in record) {
    return [
      `id: ${parentRunId}:${streamSeq}`,
      "event: run.snapshot",
      `data: ${JSON.stringify(record)}`,
      "",
      "",
    ].join("\n");
  }
  const event = record.event;
  return [
    `id: ${parentRunId}:${streamSeq}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(record)}`,
    "",
    "",
  ].join("\n");
}

export async function writeSseEvent(
  response: ServerResponse,
  event: RunStreamRecord,
  signal: AbortSignal,
  parentRunId: string,
): Promise<void> {
  await writeWithBackpressure(response, formatSseEvent(event, parentRunId), signal);
}

export async function writeWithBackpressure(
  destination: Writable,
  chunk: string,
  signal: AbortSignal,
): Promise<void> {
  if (!destination.write(chunk)) {
    await once(destination, "drain", { signal });
  }
}

export function isTerminalAgentEvent(event: AgentEvent): boolean {
  return (
    event.type === AgentEventType.RunCompleted ||
    event.type === AgentEventType.RunError ||
    event.type === AgentEventType.RunCancelled
  );
}
