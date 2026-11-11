import type { ConversationTurnState } from "./conversation-state";
import type {
  StepTrace,
  ToolTrace,
  WorkspaceGrantTrace,
} from "./run-state";

/** 待审批来自哪个子 Run：父 Run 里那次 agent 调用与它的短标题。 */
export interface PendingInteractionSource {
  toolCallId: string;
  description: string;
}

export type PendingInteraction =
  | {
      kind: "tool_approval";
      interactionId: string;
      step: number;
      tool: ToolTrace;
      source?: PendingInteractionSource;
    }
  | {
      kind: "workspace_grant";
      interactionId: string;
      step: number;
      grant: WorkspaceGrantTrace;
      source?: PendingInteractionSource;
    };

/**
 * 待处理审批固定渲染在输入框上方，因此需要一个跨 step 的收集口径。
 * 只有正在运行的 Turn 才可能响应交互；Run 结束后 Broker 侧已不可解析。
 * 子 Run 的待审批与父 Run 的一样收集，并标注来源。
 */
export function selectPendingInteractions(
  turn: ConversationTurnState | undefined,
): PendingInteraction[] {
  if (turn === undefined || turn.run.status !== "running") return [];

  const pending = collectPending(turn.run.steps);
  for (const [toolCallId, run] of Object.entries(turn.subAgentRuns)) {
    if (run.status !== "running") continue;
      const source = {
        toolCallId,
      description: turn.subAgentDescriptions[toolCallId] ?? describeSubAgent(turn.run.steps, toolCallId),
      };
    pending.push(
      ...collectPending(run.steps).map((item) => ({ ...item, source })),
    );
  }
  return pending;
}

function collectPending(steps: readonly StepTrace[]): PendingInteraction[] {
  const pending: PendingInteraction[] = [];
  for (const step of steps) {
    for (const grant of step.workspaceGrants) {
      if (grant.status !== "pending") continue;
      pending.push({
        kind: "workspace_grant",
        interactionId: grant.interactionId,
        step: step.number,
        grant,
      });
    }
    for (const tool of step.tools) {
      if (tool.approval?.status !== "pending") continue;
      pending.push({
        kind: "tool_approval",
        interactionId: tool.approval.interactionId,
        step: step.number,
        tool,
      });
    }
  }
  return pending;
}

/** agent 调用的 description 参数；拿不到时退回 toolCallId。 */
export function describeSubAgent(
  steps: readonly StepTrace[],
  toolCallId: string,
): string {
  for (const step of steps) {
    const tool = step.tools.find((candidate) => candidate.id === toolCallId);
    if (tool === undefined) continue;
    const args = tool.arguments;
    if (
      typeof args === "object" &&
      args !== null &&
      !Array.isArray(args) &&
      typeof args.description === "string" &&
      args.description.trim() !== ""
    ) {
      return args.description;
    }
  }
  return toolCallId;
}
