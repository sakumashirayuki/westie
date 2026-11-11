import type { AgentEvent } from "./agent-events.js";
import type { TranscriptMessage } from "./transcript.js";

/**
 * Stop Hook 的检查端口。Harness 在最终回答被接受之前调用一次；脚本决定放行还是
 * 要求当前 Run 继续补做。事件（`tool.started`、审批交互）经同一返回流交给主循环。
 */
export interface StopHookRequest {
  /** 待检查的最终回答；此时尚未加入 transcript，也尚未展示给用户。 */
  readonly candidateAnswer: string;
  /** 检查开始时主循环持有的完整会话记录快照。 */
  readonly transcript: readonly TranscriptMessage[];
  /** 生成这次待检查回答的模型步骤编号。 */
  readonly step: number;
  /** 本 Run 已实际应用的 Hook 拒绝次数。 */
  readonly continuations: number;
  readonly signal?: AbortSignal;
}

export type StopHookDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "block"; readonly reason: string };

export interface StopHook {
  /** 本轮 Run 的检查命令，写入检查记录供后续 Run 与诊断阅读。 */
  readonly command: string;
  /** 本 Run 允许的补做次数上限，读取自配置快照。 */
  readonly maxContinuations: number;
  check(
    request: StopHookRequest,
  ): AsyncGenerator<AgentEvent, StopHookDecision, void>;
}

/**
 * 检查故障：审批未通过、启动失败、超时、资源错误、输出协议非法或输入超限。
 *
 * `code` 是稳定诊断码：脚本执行沿用工具错误码（`COMMAND_TIMEOUT`、
 * `COMMAND_OUTPUT_TOO_LARGE` 等）；输出不合法、未获批准与输入超限使用
 * `STOP_HOOK_*` 码。`message` 保留脚本 stderr 摘录等具体诊断。
 */
export class StopHookFailedError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StopHookFailedError";
    this.code = code;
  }
}

/** 拒绝次数已达上限，脚本仍要求继续。 */
export class StopHookLimitReachedError extends Error {
  constructor(
    readonly maxContinuations: number,
    readonly reason: string,
  ) {
    super(
      `Stop hook rejected the final answer ${maxContinuations + 1} times; the continuation limit of ${maxContinuations} is reached.`,
    );
    this.name = "StopHookLimitReachedError";
  }
}
