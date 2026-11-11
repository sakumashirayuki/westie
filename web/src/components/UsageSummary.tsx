import type { RunUsageTotals } from "../events";

const labels = {
  run: "本轮",
  conversation: "本会话",
} as const;

export function UsageSummary({
  usage,
  scope,
  className = "",
}: {
  usage: RunUsageTotals;
  scope: keyof typeof labels;
  className?: string;
}) {
  const cacheRatio =
    usage.inputTokens === 0
      ? 0
      : Math.round((usage.cachedInputTokens / usage.inputTokens) * 100);
  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-[#5c6d64] ${className}`}
    >
      <span className="font-sans text-[#69736d]">{labels[scope]}</span>
      <span>输入 {usage.inputTokens.toLocaleString()} token</span>
      <span>（缓存命中 {cacheRatio}%）</span>
      <span>输出 {usage.outputTokens.toLocaleString()} token</span>
      <span>调用 {usage.calls}</span>
      {usage.unmeasuredCalls !== 0 && (
        <span className="text-[#a5650d]">
          未测得 {usage.unmeasuredCalls} 次
        </span>
      )}
    </div>
  );
}
