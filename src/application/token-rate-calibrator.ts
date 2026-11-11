import { REQUEST_OVERHEAD_TOKENS } from "./context-budget.js";

/**
 * 字节/token 系数的在线校准。估算按 UTF-8 字节除以系数得到 token 数，而 Provider
 * 每步都返回真实输入 token；两者相除就是这类对话的真实系数。
 */
export interface TokenRateState {
  readonly bytesPerToken: number;
  /** 已并入的有效观测次数。 */
  readonly observations: number;
}

export interface TokenRateSample {
  /** 发给 Provider 的那份请求的 UTF-8 字节数（不含固定开销）。 */
  readonly requestBytes: number;
  /** Provider 返回的本次请求输入 token 总数。 */
  readonly inputTokens: number;
}

// 一个 Run 通常几十步：0.5 让系数在五步内追上真实值，同时把单步异常样本的
// 影响在两步内衰减掉。
export const TOKEN_RATE_SMOOTHING = 0.5;
export const MIN_BYTES_PER_TOKEN = 1;
export const MAX_BYTES_PER_TOKEN = 8;
// 请求很小时固定开销的误差占主导：实测第 1 步真实 1,726 token 扣掉 1,024 开销只剩
// 702，一个样本就把系数顶到上限。有效 token 不足两倍开销的样本不拿来校准。
export const MIN_SAMPLE_TOKENS = 2 * REQUEST_OVERHEAD_TOKENS;

/** 把一次真实 usage 并入系数，返回新状态；无效样本原样返回。 */
export function observeTokenRate(
  state: TokenRateState,
  sample: TokenRateSample,
): TokenRateState {
  const effectiveTokens = sample.inputTokens - REQUEST_OVERHEAD_TOKENS;
  if (sample.requestBytes <= 0 || effectiveTokens < MIN_SAMPLE_TOKENS) {
    return state;
  }

  const observed = clamp(
    sample.requestBytes / effectiveTokens,
    MIN_BYTES_PER_TOKEN,
    MAX_BYTES_PER_TOKEN,
  );
  const bytesPerToken = state.observations === 0
    ? observed
    : state.bytesPerToken * (1 - TOKEN_RATE_SMOOTHING) +
      observed * TOKEN_RATE_SMOOTHING;
  return { bytesPerToken, observations: state.observations + 1 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
