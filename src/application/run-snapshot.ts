import {
  AgentEventType,
  type AgentEvent,
  type RunMemoryStatus,
  type RunSnapshotData,
  type SubAgentSnapshot,
} from "../agent-events.js";
import type { RunEventSource } from "../run-stream.js";

/** Current state for reconnects whose full event history is unavailable. */
export class RunSnapshotProjection {
  #status: RunSnapshotData["status"] = "running";
  #waitingForSubAgents = false;
  readonly #children = new Map<string, SubAgentSnapshot>();
  readonly #descriptions = new Map<string, string>();
  readonly #pendingInteractions = new Map<string, Extract<AgentEvent, { type: "interaction.required" }>>();
  #terminal: RunSnapshotData["terminal"];
  #answer: string | undefined;
  /** 前端恢复 Run 时，用于展示记忆索引截断或加载失败的提示。 */
  #memory: RunMemoryStatus | undefined;

  /**
   * 根据事件更新前端恢复界面所需的当前状态，包括运行状态、子任务、待审批项和最终回答。
   * 只处理影响快照的事件，其他事件忽略；这里仅更新内存，由 snapshot() 返回整理后的状态。
   * 不执行审批、工具调用或任务调度。
   */
  apply(source: RunEventSource): void {
    const event = source.event;
    if (source.subAgent !== undefined) {
      this.#applyChild(source.subAgent.toolCallId, event);
      return;
    }
    if (
      event.type === AgentEventType.RunStarted && event.data.memory !== undefined
    ) {
      this.#memory = event.data.memory;
    }
    if (event.type === AgentEventType.ToolStarted && event.data.name === "agent") {
      const args = event.data.arguments;
      if (typeof args === "object" && args !== null && !Array.isArray(args) && typeof args.description === "string") {
        this.#descriptions.set(event.data.toolCallId, args.description);
      }
    }
    if (event.type === AgentEventType.SubAgentStopping) {
      const child = this.#child(event.data.runId, event.data.toolCallId);
      this.#children.set(child.runId, { ...child, status: "stopping" });
      this.#clearInteractions(child.runId);
    } else if (event.type === AgentEventType.StepStarted) {
      this.#waitingForSubAgents = false;
    } else if (event.type === AgentEventType.RunWaiting) {
      this.#waitingForSubAgents = true;
    } else if (event.type === AgentEventType.AnswerCompleted) {
      this.#answer = event.data.answer;
    } else if (isTerminal(event)) {
      this.#status = terminalStatus(event);
      this.#terminal = event;
      this.#waitingForSubAgents = false;
      this.#pendingInteractions.clear();
      this.#descriptions.clear();
    }
    this.#applyInteraction(event);
  }

  snapshot(): RunSnapshotData {
    return {
      status: this.#status,
      ...(this.#memory === undefined ? {} : { memory: this.#memory }),
      waitingForSubAgents: this.#waitingForSubAgents,
      children: [...this.#children.values()],
      pendingInteractions: [...this.#pendingInteractions.values()],
      ...(this.#terminal === undefined ? {} : { terminal: this.#terminal }),
      ...(this.#answer === undefined ? {} : { answer: this.#answer }),
    };
  }

  #child(runId: string, toolCallId: string): SubAgentSnapshot {
    return this.#children.get(runId) ?? {
      runId, toolCallId,
      description: this.#descriptions.get(toolCallId) ?? "子任务",
      status: "running",
    };
  }

  #applyChild(toolCallId: string, event: AgentEvent): void {
    let child = this.#child(event.runId, toolCallId);
    if (event.type === AgentEventType.AnswerCompleted) {
      child = { ...child, answer: event.data.answer };
    } else if (isTerminal(event)) {
      child = {
        ...child,
        status: terminalStatus(event),
        ...(event.data.usage === undefined ? {} : { usage: event.data.usage }),
        ...(event.type === AgentEventType.RunCompleted ? { stopReason: event.data.stopReason } : {}),
        ...(event.type === AgentEventType.RunError ? { error: { code: event.data.code, message: event.data.message } } : {}),
        ...(event.type === AgentEventType.RunCancelled && event.data.error !== undefined ? { error: event.data.error } : {}),
      };
      this.#clearInteractions(event.runId);
      this.#descriptions.delete(toolCallId);
    }
    this.#children.set(event.runId, child);
    this.#applyInteraction(event);
  }

  #applyInteraction(event: AgentEvent): void {
    if (event.type === AgentEventType.InteractionRequired) {
      const status = this.#children.get(event.runId)?.status;
      if (this.#status !== "running" || (status !== undefined && status !== "running")) return;
      this.#pendingInteractions.set(`${event.runId}:${event.interactionId}`, event);
    } else if (event.type === AgentEventType.InteractionResolved) {
      this.#pendingInteractions.delete(`${event.runId}:${event.interactionId}`);
    }
  }

  #clearInteractions(runId: string): void {
    for (const [key, event] of this.#pendingInteractions) {
      if (event.runId === runId) this.#pendingInteractions.delete(key);
    }
  }
}

function isTerminal(event: AgentEvent): event is NonNullable<RunSnapshotData["terminal"]> {
  return event.type === AgentEventType.RunCompleted || event.type === AgentEventType.RunError || event.type === AgentEventType.RunCancelled;
}

function terminalStatus(event: NonNullable<RunSnapshotData["terminal"]>): "completed" | "failed" | "cancelled" {
  return event.type === AgentEventType.RunCompleted ? "completed" : event.type === AgentEventType.RunCancelled ? "cancelled" : "failed";
}
