import { transcriptBytes, type TranscriptMessage } from "../transcript.js";
import type { Tool } from "../tools.js";
import { z } from "zod";
import { MAX_CONTEXT_SUMMARY_BYTES } from "./conversation-store.js";

const MIN_SAFETY_MARGIN_TOKENS = 2_048;
const SAFETY_MARGIN_RATIO = 0.05;
const REQUEST_OVERHEAD_TOKENS = 1_024;
const COMPACTION_TRIGGER_RATIO = 0.8;

// 摘要预算按 inputTokenLimit 的比例推导，写死绝对值会让同一个取值在不同窗口下
// 的分量差出一个数量级。下限保证摘要写得完：低于 4,096 时摘要会在输出上限处被
// 截断、整份作废。
const DEFAULT_SUMMARY_BUDGET_RATIO = 0.01;
const MIN_SUMMARY_OUTPUT_TOKENS = 4_096;
const MAX_SUMMARY_OUTPUT_TOKENS = 8_192;

/**
 * 字节数换算 token 数的除数。UTF-8 字节数与 token 数不是同一个量纲，把字节数
 * 直接当 token 数会把窗口按最坏比例低估几倍。实测一次中文与代码混排的编码
 * 任务，同一步的估算 588,416 字节对应真实 164,098 token，比值 3.59；默认值
 * 取 2.5 保留余量，可按 Provider 与语言混比配置。
 */
const DEFAULT_BYTES_PER_TOKEN = 2.5;

export {
  REQUEST_OVERHEAD_TOKENS,
  DEFAULT_BYTES_PER_TOKEN,
  DEFAULT_SUMMARY_BUDGET_RATIO,
};

export interface ContextBudgetOptions {
  readonly contextWindowTokens: number | undefined;
  readonly maxOutputTokens: number | undefined;
  readonly bytesPerToken?: number;
  /** 摘要预算占 inputTokenLimit 的比例，缺省 0.01。 */
  readonly summaryBudgetRatio?: number;
}

/**
 * 从 Provider 容量推导本次请求的输入预算，并判定某个候选投影是否装得下。
 * 所有比较统一在 token 量纲上进行；字节数一律经 tokensFromBytes 换算。
 */
export class ContextBudget {
  /** 输入的硬上限：上下文窗口扣掉输出预留和安全余量。 */
  readonly inputTokenLimit: number;
  /** 达到该水位触发 Run 内压缩。 */
  readonly triggerTokens: number;
  /** 一次摘要调用允许的输出 token 数。 */
  readonly summaryOutputTokens: number;
  /** 摘要文本允许的字节数，同时用作压缩投影里的占位预留。 */
  readonly summaryMaxBytes: number;
  /** 当前使用的字节/token 系数；Run 内可由真实 usage 校准后派生新实例。 */
  readonly bytesPerToken: number;
  readonly #summaryBudgetRatio: number;
  readonly #contextWindowTokens: number;
  readonly #maxOutputTokens: number;

  constructor(options: ContextBudgetOptions) {
    const contextWindowTokens = positiveInteger(
      options.contextWindowTokens,
      "provider.contextWindowTokens",
    );
    const maxOutputTokens = positiveInteger(
      options.maxOutputTokens,
      "provider.maxOutputTokens",
    );
    const safetyMargin = Math.max(
      MIN_SAFETY_MARGIN_TOKENS,
      Math.ceil(contextWindowTokens * SAFETY_MARGIN_RATIO),
    );
    const inputTokenLimit =
      contextWindowTokens - maxOutputTokens - safetyMargin;
    if (inputTokenLimit <= 0) {
      throw new Error(
        "Provider output reserve and safety margin leave no input capacity.",
      );
    }
    const bytesPerToken = options.bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN;
    if (!Number.isFinite(bytesPerToken) || bytesPerToken <= 0) {
      throw new Error("bytesPerToken must be a positive number.");
    }

    const summaryBudgetRatio = ratio(
      options.summaryBudgetRatio,
      DEFAULT_SUMMARY_BUDGET_RATIO,
      "summaryBudgetRatio",
    );

    this.inputTokenLimit = inputTokenLimit;
    this.triggerTokens = Math.floor(inputTokenLimit * COMPACTION_TRIGGER_RATIO);
    this.summaryOutputTokens = Math.min(
      MAX_SUMMARY_OUTPUT_TOKENS,
      Math.max(
        MIN_SUMMARY_OUTPUT_TOKENS,
        Math.floor(inputTokenLimit * summaryBudgetRatio),
      ),
    );
    this.summaryMaxBytes = Math.min(
      MAX_CONTEXT_SUMMARY_BYTES,
      Math.ceil(this.summaryOutputTokens * bytesPerToken),
    );
    this.bytesPerToken = bytesPerToken;
    this.#summaryBudgetRatio = summaryBudgetRatio;
    this.#contextWindowTokens = contextWindowTokens;
    this.#maxOutputTokens = maxOutputTokens;
  }

  /** 只换系数的新预算；窗口、输出预留与摘要比例沿用本实例。 */
  withBytesPerToken(bytesPerToken: number): ContextBudget {
    return new ContextBudget({
      contextWindowTokens: this.#contextWindowTokens,
      maxOutputTokens: this.#maxOutputTokens,
      bytesPerToken,
      summaryBudgetRatio: this.#summaryBudgetRatio,
    });
  }

  /** 字节数换算成估算 token 数。所有字节口径进入预算比较前都要过这一步。 */
  tokensFromBytes(bytes: number): number {
    return Math.ceil(bytes / this.bytesPerToken);
  }

  /** 一次 Provider 请求的估算输入 token 数。 */
  estimateTokens(request: {
    readonly systemPrompt: string;
    readonly transcript: readonly TranscriptMessage[];
    readonly tools: readonly Tool[];
  }): number {
    return REQUEST_OVERHEAD_TOKENS +
      this.tokensFromBytes(estimateRequestBytes(request));
  }
}

/** 一次请求的 UTF-8 字节数。换算 token 由 ContextBudget 负责。 */
export function estimateRequestBytes(request: {
  readonly systemPrompt: string;
  readonly transcript: readonly TranscriptMessage[];
  readonly tools: readonly Tool[];
}): number {
  return Buffer.byteLength(request.systemPrompt, "utf8") +
    transcriptBytes(request.transcript) +
    toolBytes(request.tools);
}

export function toolBytes(tools: readonly Tool[]): number {
  return tools.reduce(
    (total, tool) =>
      total +
      Buffer.byteLength(tool.name, "utf8") +
      Buffer.byteLength(tool.description, "utf8") +
      Buffer.byteLength(
        JSON.stringify(z.toJSONSchema(tool.inputSchema)),
        "utf8",
      ),
    0,
  );
}

/** 比例参数必须落在 (0, 1]，缺省时回落到给定默认值。 */
function ratio(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} must be a number in (0, 1].`);
  }
  return value;
}

function positiveInteger(value: number | undefined, name: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}
