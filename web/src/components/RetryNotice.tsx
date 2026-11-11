import { useEffect, useState } from "react";

import type { ModelRetryReason } from "../events";
import type { StepRetryTrace } from "../run-state";

const COUNTDOWN_TICK_MS = 1_000;

const reasonLabels: Record<ModelRetryReason, string> = {
  rate_limited: "模型服务限流",
  server_error: "模型服务出错",
  overloaded: "模型服务繁忙",
  timeout: "模型响应超时",
  connection: "与模型服务的连接中断",
};

/** 模型调用失败后等待重试的状态行。倒计时从收到事件（组件挂载）时开始。 */
export function RetryNotice({ retry }: { retry: StepRetryTrace }) {
  // 每次新的重试都重新挂载，倒计时从头开始。
  return <RetryCountdown key={retry.attempt} retry={retry} />;
}

function RetryCountdown({ retry }: { retry: StepRetryTrace }) {
  const [remainingMs, setRemainingMs] = useState(retry.delayMs);

  useEffect(() => {
    const retryAt = Date.now() + retry.delayMs;
    const timer = setInterval(() => {
      const remaining = Math.max(0, retryAt - Date.now());
      setRemainingMs(remaining);
      if (remaining === 0) clearInterval(timer);
    }, COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [retry.delayMs]);

  const seconds = Math.ceil(remainingMs / 1_000);
  const progress = `（${retry.attempt}/${retry.maxAttempts}）`;
  return (
    <p
      className="mt-2 flex items-center gap-2 text-sm text-[#a5650d]"
      role="status"
    >
      <span
        className="inline-block size-1.5 animate-pulse rounded-full bg-[#a5650d] motion-reduce:animate-none"
        aria-hidden="true"
      />
      {reasonLabels[retry.reason]}，
      {seconds > 0 ? `${seconds} 秒后重试` : "正在重试"}
      {progress}
    </p>
  );
}
