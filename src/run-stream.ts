import type { AgentEvent, RunSnapshotData } from "./agent-events.js";

/** 原始事件及其在当前父 Run 中的关联信息。 */
export interface RunEventSource {
  readonly event: AgentEvent;
  readonly subAgent?: {
    readonly toolCallId: string;
    readonly parentStep: number;
  };
}

/** 订阅流位置独立于每个 Run 自身的事件序号。快照沿用当前游标。 */
export type RunStreamRecord = { readonly streamSeq: number } & (
  | RunEventSource
  | { readonly snapshot: RunSnapshotData }
);
