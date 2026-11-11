import {
  ContextCompactionFailedError,
  ContextLimitExceededError,
  type AgentContextBuilder,
} from "../agent-loop.js";
import type { LlmProvider, ProviderUsage } from "../provider-protocol.js";
import type { RunUsageLog, SummaryUsageRecord } from "../run-usage.js";
import { transcriptBytes, type TranscriptMessage } from "../transcript.js";
import type { Tool } from "../tools.js";
import {
  ContextBudget,
  estimateRequestBytes,
  toolBytes,
  REQUEST_OVERHEAD_TOKENS,
} from "./context-budget.js";
import {
  ContextCompactor,
  openTurnUserIndexes,
  type ContextCompactionCandidate,
} from "./context-compactor.js";
import type { RunContextCompaction } from "./conversation-store.js";
import {
  observeTokenRate,
  type TokenRateState,
} from "./token-rate-calibrator.js";

export interface ContextBuilderOptions {
  readonly provider: LlmProvider;
  readonly bytesPerToken?: number;
  /** 摘要预算占 inputTokenLimit 的比例。 */
  readonly summaryBudgetRatio?: number;
  /** 压缩后近端保留的已闭合工具对数量。 */
  readonly compactionRecentPairs?: number;
  readonly runId?: string;
  /** 该会话已采用的压缩记录，作为 ContextCompactor 的初始 #adopted。 */
  readonly initialCompactions?: readonly RunContextCompaction[];
  readonly onRequestEstimate?: (report: RequestEstimateReport) => void;
  readonly usageLog?: RunUsageLog;
}

/**
 * 每次 Provider 请求的预算估算值。估算按 UTF-8 字节计，而 run_model_calls 记录的是
 * 真实 token 数；两者按 (runId, step) 对账即可核对 bytesPerToken 的校准效果。
 */
export interface RequestEstimateReport {
  readonly runId?: string;
  readonly step?: number;
  readonly estimatedInputTokens: number;
  /** 本步估算使用的字节/token 系数。 */
  readonly bytesPerToken: number;
  readonly inputTokenLimit: number;
  readonly triggerTokens: number;
  readonly compactions: number;
}

/**
 * 组装单次 Provider 请求的输入：对当前会话的 canonical transcript 做压缩投影。
 * 预算算术在 ContextBudget，压缩投影在 ContextCompactor，本类只负责两者之间的
 * 编排与错误映射。
 */
export class ContextBuilder implements AgentContextBuilder {
  #budget: ContextBudget;
  #tokenRate: TokenRateState;
  /** 最近一次 buildContext 返回给 Provider 的请求字节数，供 observeUsage 对账。 */
  #lastRequest?: { readonly step: number; readonly requestBytes: number };
  readonly #compactor: ContextCompactor;
  readonly #usageLog?: RunUsageLog;
  readonly #runId?: string;
  readonly #onRequestEstimate?: (report: RequestEstimateReport) => void;

  constructor(options: ContextBuilderOptions) {
    const initialCompactions = options.initialCompactions ?? [];
    const latestCompaction = initialCompactions.at(-1);
    this.#budget = new ContextBudget({
      contextWindowTokens: options.provider.contextWindowTokens,
      maxOutputTokens: options.provider.maxOutputTokens,
      ...(options.bytesPerToken === undefined
        ? {}
        : { bytesPerToken: options.bytesPerToken }),
      ...(options.summaryBudgetRatio === undefined
        ? {}
        : { summaryBudgetRatio: options.summaryBudgetRatio }),
    });
    this.#tokenRate = {
      bytesPerToken: this.#budget.bytesPerToken,
      observations: 0,
    };
    this.#usageLog = options.usageLog;
    if (options.runId !== undefined) this.#runId = options.runId;
    if (options.onRequestEstimate !== undefined) {
      this.#onRequestEstimate = options.onRequestEstimate;
    }
    this.#compactor = new ContextCompactor({
      provider: options.provider,
      recordUsage: (record) => {
        this.#recordSummaryCall(record);
      },
      summaryBudget: {
        outputTokens: this.#budget.summaryOutputTokens,
        maxBytes: this.#budget.summaryMaxBytes,
      },
      ...(options.compactionRecentPairs === undefined
        ? {}
        : { recentPairs: options.compactionRecentPairs }),
      ...(latestCompaction === undefined
        ? {}
        : { initialAdopted: latestCompaction }),
    });
  }

  get compactions(): readonly RunContextCompaction[] {
    return this.#compactor.compactions;
  }

  #recordSummaryCall(record: SummaryUsageRecord): void {
    this.#usageLog?.record(record);
  }

  async buildContext(
    request: {
      readonly systemPrompt: string;
      readonly currentTranscript: readonly TranscriptMessage[];
      readonly tools: readonly Tool[];
      readonly step?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<{ readonly transcript: readonly TranscriptMessage[] }> {
    request.signal?.throwIfAborted();
    const estimate = (transcript: readonly TranscriptMessage[]) =>
      this.#budget.estimateTokens({
        systemPrompt: request.systemPrompt,
        transcript,
        tools: request.tools,
      });

    const transcript = await this.#compactCurrentRun(request, estimate);
    const estimatedInputTokens = estimate(transcript);
    if (estimatedInputTokens >= this.#budget.inputTokenLimit) {
      throw new ContextLimitExceededError();
    }
    this.#lastRequest = request.step === undefined ? undefined : {
      step: request.step,
      requestBytes: estimateRequestBytes({
        systemPrompt: request.systemPrompt,
        transcript,
        tools: request.tools,
      }),
    };
    this.#onRequestEstimate?.({
      ...(this.#runId === undefined ? {} : { runId: this.#runId }),
      ...(request.step === undefined ? {} : { step: request.step }),
      estimatedInputTokens,
      bytesPerToken: this.#budget.bytesPerToken,
      inputTokenLimit: this.#budget.inputTokenLimit,
      triggerTokens: this.#budget.triggerTokens,
      compactions: this.#compactor.compactions.length,
    });
    return { transcript };
  }

  /** 用上一步的真实 usage 校准字节/token 系数，供之后的估算使用。 */
  observeUsage(report: {
    readonly step: number;
    readonly usage: ProviderUsage;
  }): void {
    const last = this.#lastRequest;
    if (last === undefined || last.step !== report.step) return;
    const next = observeTokenRate(this.#tokenRate, {
      requestBytes: last.requestBytes,
      inputTokens: report.usage.inputTokens,
    });
    if (next === this.#tokenRate) return;
    this.#tokenRate = next;
    this.#budget = this.#budget.withBytesPerToken(next.bytesPerToken);
  }

  /**
   * 当前会话 transcript 达到触发水位时压缩它，并返回用于 Provider 输入的投影；
   * 未达到水位时原样返回。
   */
  async #compactCurrentRun(
    request: {
      readonly systemPrompt: string;
      readonly currentTranscript: readonly TranscriptMessage[];
      readonly tools: readonly Tool[];
      readonly signal?: AbortSignal;
    },
    estimate: (transcript: readonly TranscriptMessage[]) => number,
  ): Promise<readonly TranscriptMessage[]> {
    const projected = this.#compactor.currentTranscript(
      request.currentTranscript,
    );
    const originalRequestTokens = estimate(projected);
    if (originalRequestTokens < this.#budget.triggerTokens) return projected;

    const floor = this.#protectedFloor(request);
    if (floor.total >= this.#budget.inputTokenLimit) {
      throw new ContextLimitExceededError(describeProtectedFloor(
        floor,
        this.#budget.inputTokenLimit,
      ));
    }
    const forcedInitialCompaction =
      originalRequestTokens >= this.#budget.inputTokenLimit;

    let candidate = await this.#createCompaction(
      request,
      forcedInitialCompaction,
      { rethrow: forcedInitialCompaction },
    );
    if (candidate === undefined) {
      if (forcedInitialCompaction) throw new ContextLimitExceededError();
      return projected;
    }

    let candidateTokens = estimate(candidate.transcript);
    if (
      candidateTokens >= this.#budget.inputTokenLimit &&
      !forcedInitialCompaction
    ) {
      candidate = await this.#createCompaction(
        request,
        true,
        { rethrow: true },
      );
      candidateTokens = candidate === undefined
        ? originalRequestTokens
        : estimate(candidate.transcript);
    }
    if (
      candidate === undefined ||
      candidateTokens >= this.#budget.inputTokenLimit
    ) {
      throw new ContextLimitExceededError();
    }
    this.#compactor.adopt(candidate);
    return candidate.transcript;
  }

  async #createCompaction(
    request: {
      readonly currentTranscript: readonly TranscriptMessage[];
      readonly signal?: AbortSignal;
    },
    forceMaximumCoverage: boolean,
    options: { readonly rethrow: boolean },
  ): Promise<ContextCompactionCandidate | undefined> {
    try {
      return await this.#compactor.createCompaction({
        canonicalTranscript: request.currentTranscript,
        forceMaximumCoverage,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason ?? error;
      // 非强制路径会咽下失败继续跑，这里是唯一知道原因的地方。
      process.stderr.write(`${JSON.stringify({
        event: "context.compaction_failed",
        ...(this.#runId === undefined ? {} : { runId: this.#runId }),
        forceMaximumCoverage,
        rethrow: options.rethrow,
        reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      })}\n`);
      if (options.rethrow) {
        throw new ContextCompactionFailedError({ cause: error });
      }
      return undefined;
    }
  }

  /** 无法压缩的固定占用：低于它就没有任何可回收空间。 */
  #protectedFloor(request: {
    readonly systemPrompt: string;
    readonly currentTranscript: readonly TranscriptMessage[];
    readonly tools: readonly Tool[];
  }): ProtectedFloor {
    const toTokens = (bytes: number) => this.#budget.tokensFromBytes(bytes);
    const requestOverhead = REQUEST_OVERHEAD_TOKENS;
    const systemPrompt = toTokens(
      Buffer.byteLength(request.systemPrompt, "utf8"),
    );
    const toolSchemas = toTokens(toolBytes(request.tools));
    const openTurnIndexes = openTurnUserIndexes(
      request.currentTranscript,
      request.currentTranscript.length - 1,
    );
    const currentUserInput = toTokens(transcriptBytes(
      openTurnIndexes
        .map((index) => request.currentTranscript[index])
        .filter((message): message is TranscriptMessage =>
          message !== undefined
        ),
    ));
    const protectedSkillGroups = toTokens(transcriptBytes(
      this.#compactor.protectedSkillGroups(request.currentTranscript),
    ));
    const summaryReservation = toTokens(this.#budget.summaryMaxBytes);
    return {
      requestOverhead,
      systemPrompt,
      toolSchemas,
      currentUserInput,
      protectedSkillGroups,
      summaryReservation,
      total:
        requestOverhead +
        systemPrompt +
        toolSchemas +
        currentUserInput +
        protectedSkillGroups +
        summaryReservation,
    };
  }
}

interface ProtectedFloor {
  readonly requestOverhead: number;
  readonly systemPrompt: number;
  readonly toolSchemas: number;
  readonly currentUserInput: number;
  readonly protectedSkillGroups: number;
  readonly summaryReservation: number;
  readonly total: number;
}

function describeProtectedFloor(
  floor: ProtectedFloor,
  inputTokenLimit: number,
): string {
  return `Protected context requires ${floor.total} estimated tokens ` +
    `but the hard input limit is ${inputTokenLimit}. ` +
    `(request overhead ${floor.requestOverhead}, system prompt ` +
    `${floor.systemPrompt}, tool schemas ${floor.toolSchemas}, ` +
    `open turn user messages ${floor.currentUserInput}, protected skill groups ` +
    `${floor.protectedSkillGroups}, summary reservation ` +
    `${floor.summaryReservation})`;
}
