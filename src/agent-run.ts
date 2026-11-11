import { randomUUID } from "node:crypto";

import { AgentEventFactory } from "./agent-events.js";
import { RunUsageLog, type RunUsageOptions } from "./run-usage.js";

/** 同一次 Run 共享的身份、事件编号与用量记录。 */
export interface AgentRun {
  readonly runId: string;
  readonly eventFactory: AgentEventFactory;
  readonly usageLog: RunUsageLog;
}

export function createAgentRun(options: {
  readonly runId?: string;
  readonly usageOptions?: RunUsageOptions;
} = {}): AgentRun {
  const runId = options.runId ?? randomUUID();
  if (runId.trim() === "") throw new Error("runId must not be empty.");
  return {
    runId,
    eventFactory: new AgentEventFactory(runId),
    usageLog: new RunUsageLog(options.usageOptions),
  };
}
