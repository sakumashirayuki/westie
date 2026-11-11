import {
  grantScopeLabel,
  type InteractionRequestState,
  type InteractionResponder,
} from "../interaction-ui";
import type { ToolTrace } from "../run-state";

export function ToolApprovalCard({
  tool,
  canRespond,
  request,
  onRespond,
  layoutClassName = "mx-[13px] mb-3 rounded-[9px] p-3.5",
  showArguments = false,
}: {
  tool: ToolTrace;
  canRespond: boolean;
  request: InteractionRequestState | undefined;
  onRespond: InteractionResponder;
  /** 卡片脱离工具轨迹渲染时由调用方给出外边距与圆角。 */
  layoutClassName?: string;
  /** 轨迹外渲染时相邻位置没有参数块，必须由卡片自己展示待执行的参数。 */
  showArguments?: boolean;
}) {
  const approval = tool.approval!;
  const pending = approval.status === "pending";
  const submitting =
    request?.status === "submitting" || request?.status === "submitted";
  const disabled = !canRespond || !pending || submitting;

  return (
    <section
      className={`border border-[#e7c98d] bg-[#fff9eb] ${layoutClassName}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <strong className="text-sm text-[#75500f]">
            {approvalStatusLabel(approval, tool.name)}
          </strong>
          <p className="mt-1.5 text-sm leading-[1.55] text-[#725b31]">
            {approval.risk}
          </p>
          <p className="mt-1 text-xs leading-[1.5] text-[#806f4f]">
            {approval.impact}
          </p>
        </div>
      </div>
      {showArguments && (
        <div className="mt-3">
          <span className="text-[11px] text-[#806f4f]">待执行参数</span>
          <pre className="mt-[5px] max-h-52 overflow-auto rounded-[7px] bg-[#f4ead3] p-2.5 font-mono text-xs leading-[1.55] break-all whitespace-pre-wrap text-[#5f4a24]">
            {JSON.stringify(tool.arguments, null, 2)}
          </pre>
        </div>
      )}
      <p className="mt-2.5 text-[11px] text-[#927e56]">
        确认有效期至 {formatExpiry(approval.expiresAt)}
      </p>
      {pending && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="cursor-pointer rounded-full border border-[#d3b575] bg-white px-3.5 py-2 text-xs font-bold text-[#79581a] hover:bg-[#fff4d7] disabled:cursor-not-allowed disabled:opacity-45"
            disabled={disabled}
            onClick={() => onRespond(approval.interactionId, "deny")}
          >
            拒绝
          </button>
          <button
            type="button"
            className="cursor-pointer rounded-full bg-[#9a6817] px-3.5 py-2 text-xs font-bold text-white hover:bg-[#7f5310] disabled:cursor-not-allowed disabled:opacity-45"
            disabled={disabled}
            onClick={() => onRespond(approval.interactionId, "approve")}
          >
            {submitting ? "提交中…" : "允许一次"}
          </button>
          {approval.grantOptions.map((scope) => (
            <button
              key={scope.kind === "tool" ? "tool" : `prefix:${scope.value}`}
              type="button"
              className="cursor-pointer rounded-full border border-[#9a6817] bg-white px-3.5 py-2 text-xs font-bold text-[#79581a] hover:bg-[#fff4d7] disabled:cursor-not-allowed disabled:opacity-45"
              disabled={disabled}
              onClick={() =>
                onRespond(approval.interactionId, "approve", scope)}
            >
              {grantScopeLabel(scope, tool.name)}
            </button>
          ))}
          {request?.status === "error" && (
            <span className="basis-full text-xs text-[#a9362e]" role="alert">
              {request.error}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function approvalStatusLabel(
  approval: NonNullable<ToolTrace["approval"]>,
  toolName: string,
): string {
  if (approval.status === "expired") return "确认已过期";
  if (approval.status === "responded") {
    if (approval.decision !== "approve") return "已拒绝";
    return approval.grant === undefined
      ? "已允许一次"
      : `已${grantScopeLabel(approval.grant, toolName)}`;
  }
  return "需要你的确认";
}

function formatExpiry(expiresAt: string): string {
  const date = new Date(expiresAt);
  return Number.isNaN(date.getTime())
    ? expiresAt
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
