import {
  validateProviderUsage,
  type ProviderUsage,
} from "./provider-protocol.js";

/** sub_agent：子 Run 里的任何一次模型调用，记入父 Run，不带步号，带子 Run 的 runId。 */
export type ModelCallKind =
  | "step"
  | "context_compaction"
  | "history_summary"
  | "sub_agent";

export interface RunModelCall {
  readonly seq: number;
  readonly kind: ModelCallKind;
  readonly step?: number;
  /** 仅 sub_agent：花掉这次调用的子 Run。 */
  readonly subAgentRunId?: string;
  readonly model: string;
  readonly usage?: ProviderUsage;
  readonly createdAt: string;
}

export interface RunUsageTotals {
  readonly calls: number;
  readonly unmeasuredCalls: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export type SummaryModelCallKind = Exclude<ModelCallKind, "step">;

export interface SummaryUsageRecord {
  readonly kind: SummaryModelCallKind;
  readonly model: string;
  readonly usage?: ProviderUsage;
}

/** 摘要类调用（Run 内压缩、跨 Run 历史摘要）把自己的用量交给记账方。 */
export type RecordSummaryUsage = (record: SummaryUsageRecord) => void;

export interface RunUsageRecord {
  readonly kind: ModelCallKind;
  readonly step?: number;
  readonly subAgentRunId?: string;
  readonly model: string;
  readonly usage?: ProviderUsage;
}

export interface RunUsageOptions {
  readonly onInvalid?: (call: RunUsageRecord) => void;
}

export class RunUsageLog {
  readonly #calls: RunModelCall[] = [];
  readonly #onInvalid?: (call: RunUsageRecord) => void;

  constructor(options?: RunUsageOptions) {
    this.#onInvalid = options?.onInvalid;
  }

  record(call: RunUsageRecord): void {
    if (call.kind === "step") {
      if (
        call.step === undefined ||
        !Number.isSafeInteger(call.step) ||
        call.step < 1
      ) {
        throw new Error("A step model call must include a step number.");
      }
    } else if (call.step !== undefined) {
      throw new Error("A non-step model call must not include a step number.");
    }
    if ((call.kind === "sub_agent") !== (call.subAgentRunId !== undefined)) {
      throw new Error(
        "A sub_agent model call must include the sub agent run id, and only it may.",
      );
    }
    if (call.model.trim() === "") {
      throw new Error("A model call must include a non-empty model name.");
    }
    const normalizedUsage = validateProviderUsage(call.usage);
    if (call.usage !== undefined && normalizedUsage === undefined) {
      this.#onInvalid?.(call);
    }
    this.#calls.push({
      seq: this.#calls.length,
      kind: call.kind,
      ...(call.step === undefined ? {} : { step: call.step }),
      ...(call.subAgentRunId === undefined
        ? {}
        : { subAgentRunId: call.subAgentRunId }),
      model: call.model,
      ...(normalizedUsage === undefined ? {} : { usage: normalizedUsage }),
      createdAt: new Date().toISOString(),
    });
  }

  get calls(): readonly RunModelCall[] {
    return this.#calls.map((call) => ({ ...call }));
  }

  get totals(): RunUsageTotals {
    const measured = this.#calls.filter((call) => call.usage !== undefined);
    return {
      calls: this.#calls.length,
      unmeasuredCalls: this.#calls.length - measured.length,
      inputTokens: sum(measured, (call) => call.usage!.inputTokens),
      cachedInputTokens: sum(
        measured,
        (call) => call.usage!.cachedInputTokens,
      ),
      outputTokens: sum(measured, (call) => call.usage!.outputTokens),
      reasoningTokens: sum(measured, (call) => call.usage!.reasoningTokens),
    };
  }
}

export function emptyRunUsageTotals(): RunUsageTotals {
  return {
    calls: 0,
    unmeasuredCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

export function sumRunUsageTotals(
  totals: Iterable<RunUsageTotals>,
): RunUsageTotals {
  let result = emptyRunUsageTotals();
  for (const one of totals) {
    result = {
      calls: result.calls + one.calls,
      unmeasuredCalls: result.unmeasuredCalls + one.unmeasuredCalls,
      inputTokens: result.inputTokens + one.inputTokens,
      cachedInputTokens: result.cachedInputTokens + one.cachedInputTokens,
      outputTokens: result.outputTokens + one.outputTokens,
      reasoningTokens: result.reasoningTokens + one.reasoningTokens,
    };
  }
  return result;
}

function sum(
  calls: readonly RunModelCall[],
  select: (call: RunModelCall) => number,
): number {
  return calls.reduce((total, call) => total + select(call), 0);
}
