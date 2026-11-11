import type { JsonValue, ToolErrorCode, ToolResult } from "./protocol.js";
import type { ProviderUsage } from "./provider-protocol.js";
import type { RunUsageTotals } from "./run-usage.js";
import type {
  InteractionResolution,
  PendingInteraction,
} from "./application/interaction-broker.js";
import type { ToolGrantScope } from "./tool-grants.js";

export const AgentEventType = {
  RunStarted: "run.started",
  StepStarted: "step.started",
  ModelRetrying: "model.retrying",
  AnswerDelta: "answer.delta",
  StepCompleted: "step.completed",
  InteractionRequired: "interaction.required",
  InteractionResolved: "interaction.resolved",
  ToolStarted: "tool.started",
  ToolCompleted: "tool.completed",
  AnswerCompleted: "answer.completed",
  SteeringApplied: "steering.applied",
  SubAgentStopping: "subagent.stopping",
  RunWaiting: "run.waiting",
  RunCompleted: "run.completed",
  RunError: "run.error",
  RunCancelled: "run.cancelled",
} as const;

export type AgentEventType =
  (typeof AgentEventType)[keyof typeof AgentEventType];

interface RunEventBase {
  readonly v: 1;
  readonly runId: string;
  readonly seq: number;
}

interface StepEventBase extends RunEventBase {
  readonly step: number;
}

export type RunStopReason = "final" | "step_limit";

export interface RunErrorData {
  readonly code: string;
  readonly message: string;
}

export interface SubAgentSnapshot {
  readonly runId: string;
  readonly toolCallId: string;
  readonly description: string;
  readonly status: "running" | "stopping" | "completed" | "failed" | "cancelled";
  readonly stopReason?: RunStopReason;
  readonly answer?: string;
  readonly error?: RunErrorData;
  readonly usage?: RunUsageTotals;
}

/**
 * 父 Run 启动时的项目记忆状态。`truncated` 时 `nextLine` 是索引未加载的第一行；
 * `unavailable` 给稳定类别、不携带绝对路径。旧事件与旧快照没有这个字段。
 */
export type RunMemoryStatus =
  | { readonly status: "ready" }
  | { readonly status: "truncated"; readonly nextLine: number }
  | {
      readonly status: "unavailable";
      readonly reason: "identity" | "read" | "encoding";
    };

export interface RunStartedData {
  readonly memory?: RunMemoryStatus;
}

export interface RunSnapshotData {
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly memory?: RunMemoryStatus;
  readonly waitingForSubAgents: boolean;
  readonly children: readonly SubAgentSnapshot[];
  readonly pendingInteractions: readonly Extract<
    AgentEvent,
    { type: "interaction.required" }
  >[];
  readonly terminal?: Extract<
    AgentEvent,
    { type: "run.completed" | "run.error" | "run.cancelled" }
  >;
  readonly answer?: string;
}

export type AgentEvent =
  | (RunEventBase & {
      readonly type: typeof AgentEventType.RunStarted;
      readonly data: RunStartedData;
    })
  | (StepEventBase & {
      readonly type: typeof AgentEventType.StepStarted;
      readonly data: Record<string, never>;
    })
  | (StepEventBase & {
      readonly type: typeof AgentEventType.ModelRetrying;
      readonly data: {
        readonly attempt: number;
        readonly maxAttempts: number;
        readonly delayMs: number;
        readonly reason: string;
      };
    })
  | (StepEventBase & {
      readonly type: typeof AgentEventType.AnswerDelta;
      readonly data: { readonly text: string };
    })
  | (StepEventBase & {
      readonly type: typeof AgentEventType.StepCompleted;
      readonly data: {
        readonly actionType: "tool" | "final" | "waiting";
        readonly usage?: ProviderUsage;
      };
    })
  | (StepEventBase & {
      readonly type: typeof AgentEventType.InteractionRequired;
      readonly data: Record<string, never>;
      readonly interactionId: string;
      readonly kind: "tool_approval";
      readonly expiresAt: string;
      readonly payload: {
        readonly toolCallId: string;
        readonly toolName: string;
        readonly ruleId: string;
        readonly argumentsDigest: string;
        readonly argumentsSummary: JsonValue;
        readonly risk: string;
        readonly impact: string;
        /** 可授予的作用域，最具体的在前；空数组表示只能允许一次。 */
        readonly grantOptions: readonly ToolGrantScope[];
      };
    })
  | (StepEventBase & {
      readonly type: typeof AgentEventType.InteractionRequired;
      readonly data: Record<string, never>;
      readonly interactionId: string;
      readonly kind: "workspace_grant";
      readonly expiresAt: string;
      readonly payload: {
        readonly reason: "outside_workspace" | "sensitive_workspace_file";
        readonly toolCallId: string;
        readonly toolName: string;
        readonly requestedPath: string;
        readonly access: "read";
        readonly scope: "once";
      };
    })
  | (StepEventBase & {
      readonly type: typeof AgentEventType.InteractionResolved;
      readonly data: Record<string, never>;
      readonly interactionId: string;
      readonly kind: "tool_approval" | "workspace_grant";
      readonly status: "responded" | "expired";
      readonly response?: {
        readonly decision: "approve" | "deny";
        readonly grant?: ToolGrantScope;
      };
    })
  | (StepEventBase & {
      readonly type: typeof AgentEventType.ToolStarted;
      readonly data: {
        readonly toolCallId: string;
        readonly name: string;
        readonly arguments: JsonValue;
      };
    })
  | (StepEventBase & {
      readonly type: typeof AgentEventType.ToolCompleted;
      readonly data:
        | {
            readonly toolCallId: string;
            readonly name: string;
            readonly status: "success";
            readonly result: JsonValue;
            readonly durationMs: number;
          }
        | {
            readonly toolCallId: string;
            readonly name: string;
            readonly status: "error";
            readonly error: Extract<ToolResult, { status: "error" }>["error"];
            readonly durationMs: number;
          };
    })
  | (StepEventBase & {
      readonly type: typeof AgentEventType.AnswerCompleted;
      readonly data: { readonly answer: string };
    })
  | (StepEventBase & {
      readonly type: typeof AgentEventType.SteeringApplied;
      readonly data: { readonly messageSeq: number; readonly content: string };
    })
  | (StepEventBase & {
      readonly type: typeof AgentEventType.SubAgentStopping;
      readonly data: {
        readonly runId: string;
        readonly toolCallId: string;
        readonly reason: string;
      };
    })
  | (StepEventBase & {
      readonly type: typeof AgentEventType.RunWaiting;
      readonly data: { readonly reason: "sub_agents" };
    })
  | (RunEventBase & {
      readonly type: typeof AgentEventType.RunCompleted;
      readonly data: {
        readonly steps: number;
        readonly stopReason: RunStopReason;
        readonly usage: RunUsageTotals;
      };
    })
  | (RunEventBase & {
      readonly type: typeof AgentEventType.RunError;
      readonly step?: number;
      readonly data: RunErrorData & { readonly usage?: RunUsageTotals };
    })
  | (RunEventBase & {
      readonly type: typeof AgentEventType.RunCancelled;
      /** 子 Run 取消时带上已记录的用量与原因；父 Run 取消为空对象。 */
      readonly data: {
        readonly usage?: RunUsageTotals;
        readonly error?: RunErrorData;
      };
    });

export class AgentEventFactory {
  readonly #runId: string;
  #seq = 0;
  #activeStep: number | undefined;

  constructor(runId: string) {
    this.#runId = runId;
  }

  runStarted(
    data: RunStartedData = {},
  ): Extract<
    AgentEvent,
    { type: typeof AgentEventType.RunStarted }
  > {
    return {
      ...this.#nextBase(),
      type: AgentEventType.RunStarted,
      data,
    };
  }

  stepStarted(
    step: number,
  ): Extract<AgentEvent, { type: typeof AgentEventType.StepStarted }> {
    this.#activeStep = step;
    return {
      ...this.#nextBase(),
      type: AgentEventType.StepStarted,
      step,
      data: {},
    };
  }

  modelRetrying(
    step: number,
    attempt: number,
    maxAttempts: number,
    delayMs: number,
    reason: string,
  ): Extract<AgentEvent, { type: typeof AgentEventType.ModelRetrying }> {
    return {
      ...this.#nextBase(),
      type: AgentEventType.ModelRetrying,
      step,
      data: { attempt, maxAttempts, delayMs, reason },
    };
  }

  answerDelta(
    step: number,
    text: string,
  ): Extract<AgentEvent, { type: typeof AgentEventType.AnswerDelta }> {
    return {
      ...this.#nextBase(),
      type: AgentEventType.AnswerDelta,
      step,
      data: { text },
    };
  }

  stepCompleted(
    step: number,
    actionType: "tool" | "final" | "waiting",
    usage?: ProviderUsage,
  ): Extract<AgentEvent, { type: typeof AgentEventType.StepCompleted }> {
    return {
      ...this.#nextBase(),
      type: AgentEventType.StepCompleted,
      step,
      data: {
        actionType,
        ...(usage === undefined ? {} : { usage }),
      },
    };
  }

  interactionRequired(
    pending: PendingInteraction,
  ): Extract<AgentEvent, { type: typeof AgentEventType.InteractionRequired }> {
    const interaction = pending.interaction;
    if (interaction.kind === "workspace_grant") {
      return {
        ...this.#nextBase(),
        type: AgentEventType.InteractionRequired,
        data: {},
        step: interaction.step,
        interactionId: pending.interactionId,
        kind: interaction.kind,
        expiresAt: pending.expiresAt,
        payload: {
          reason: interaction.reason,
          toolCallId: interaction.toolCallId,
          toolName: interaction.toolName,
          requestedPath: interaction.requestedPath,
          access: interaction.access,
          scope: interaction.scope,
        },
      };
    }
    return {
      ...this.#nextBase(),
      type: AgentEventType.InteractionRequired,
      data: {},
      step: interaction.step,
      interactionId: pending.interactionId,
      kind: interaction.kind,
      expiresAt: pending.expiresAt,
      payload: {
        toolCallId: interaction.toolCallId,
        toolName: interaction.toolName,
        ruleId: interaction.ruleId,
        argumentsDigest: interaction.argumentsDigest,
        argumentsSummary: toPublicJson(interaction.argumentsSummary),
        risk: interaction.risk,
        impact: interaction.impact,
        grantOptions: interaction.grantOptions,
      },
    };
  }

  interactionResolved(
    pending: PendingInteraction,
    resolution: InteractionResolution,
  ): Extract<AgentEvent, { type: typeof AgentEventType.InteractionResolved }> {
    return {
      ...this.#nextBase(),
      type: AgentEventType.InteractionResolved,
      data: {},
      step: pending.interaction.step,
      interactionId: pending.interactionId,
      kind: pending.interaction.kind,
      status: resolution.status,
      ...(resolution.status === "responded"
        ? {
            response: {
              decision: resolution.response.decision,
              ...("grant" in resolution.response &&
                  resolution.response.grant !== undefined
                ? { grant: resolution.response.grant }
                : {}),
            },
          }
        : {}),
    };
  }

  toolStarted(
    step: number,
    toolCallId: string,
    name: string,
    input: unknown,
  ): Extract<AgentEvent, { type: typeof AgentEventType.ToolStarted }> {
    return {
      ...this.#nextBase(),
      type: AgentEventType.ToolStarted,
      step,
      data: {
        toolCallId,
        name,
        arguments: toPublicJson(input),
      },
    };
  }

  toolCompleted(
    step: number,
    toolCallId: string,
    result: ToolResult,
    durationMs: number,
  ): Extract<AgentEvent, { type: typeof AgentEventType.ToolCompleted }> {
    const common = {
      ...this.#nextBase(),
      type: AgentEventType.ToolCompleted,
      step,
      data: {
        toolCallId,
        name: result.tool,
        durationMs,
      },
    } as const;
    return result.status === "success"
      ? {
          ...common,
          data: {
            ...common.data,
            status: "success",
            result: toPublicJson(result.output),
          },
        }
      : {
          ...common,
          data: { ...common.data, status: "error", error: result.error },
        };
  }

  /**
   * Harness 内部完成检查失败、检查本身没来得及发布完成事件时补发一条，
   * 让工具轨迹以失败状态收尾而不是停在“执行中”。
   */
  stopHookFailed(
    step: number,
    toolCallId: string,
    code: string,
    message: string,
  ): Extract<AgentEvent, { type: typeof AgentEventType.ToolCompleted }> {
    return {
      ...this.#nextBase(),
      type: AgentEventType.ToolCompleted,
      step,
      data: {
        toolCallId,
        name: "stop_hook",
        status: "error",
        error: { code: code as ToolErrorCode, message },
        durationMs: 0,
      },
    };
  }

  answerCompleted(
    step: number,
    answer: string,
  ): Extract<AgentEvent, { type: typeof AgentEventType.AnswerCompleted }> {
    return {
      ...this.#nextBase(),
      type: AgentEventType.AnswerCompleted,
      step,
      data: { answer },
    };
  }

  steeringApplied(
    step: number,
    messageSeq: number,
    content: string,
  ): Extract<AgentEvent, { type: typeof AgentEventType.SteeringApplied }> {
    return {
      ...this.#nextBase(),
      type: AgentEventType.SteeringApplied,
      step,
      data: { messageSeq, content },
    };
  }

  subAgentStopping(
    step: number,
    runId: string,
    toolCallId: string,
    reason: string,
  ): Extract<AgentEvent, { type: typeof AgentEventType.SubAgentStopping }> {
    return {
      ...this.#nextBase(),
      type: AgentEventType.SubAgentStopping,
      step,
      data: { runId, toolCallId, reason },
    };
  }

  runWaiting(
    step: number,
  ): Extract<AgentEvent, { type: typeof AgentEventType.RunWaiting }> {
    return {
      ...this.#nextBase(),
      type: AgentEventType.RunWaiting,
      step,
      data: { reason: "sub_agents" },
    };
  }

  runCompleted(
    steps: number,
    stopReason: RunStopReason = "final",
    usage: RunUsageTotals,
  ): Extract<AgentEvent, { type: typeof AgentEventType.RunCompleted }> {
    return {
      ...this.#nextBase(),
      type: AgentEventType.RunCompleted,
      data: { steps, stopReason, usage },
    };
  }

  runError(
    data: RunErrorData,
    usage?: RunUsageTotals,
  ): Extract<AgentEvent, { type: typeof AgentEventType.RunError }> {
    return {
      ...this.#nextBase(),
      type: AgentEventType.RunError,
      ...(this.#activeStep === undefined ? {} : { step: this.#activeStep }),
      data: { ...data, ...(usage === undefined ? {} : { usage }) },
    };
  }

  #nextBase(): RunEventBase {
    this.#seq += 1;
    return { v: 1, runId: this.#runId, seq: this.#seq };
  }
}

const sensitiveKey = /^(?:authorization|password|secret|token|api[_-]?key)$/i;

function toPublicJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) {
    return value.map(toPublicJson);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        sensitiveKey.test(key) ? "[REDACTED]" : toPublicJson(child),
      ]),
    );
  }
  return String(value);
}
