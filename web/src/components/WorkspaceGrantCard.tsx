import type {
  InteractionRequestState,
  InteractionResponder,
  WorkspaceGrantSelector,
} from "../interaction-ui";
import type { WorkspaceGrantTrace } from "../run-state";

export function WorkspaceGrantCard({
  grant,
  canRespond,
  request,
  onRespond,
  onSelectFile,
  layoutClassName = "mt-2.5 rounded-[10px] p-4",
}: {
  grant: WorkspaceGrantTrace;
  canRespond: boolean;
  request: InteractionRequestState | undefined;
  onRespond: InteractionResponder;
  onSelectFile: WorkspaceGrantSelector;
  /** 卡片脱离工具轨迹渲染时由调用方给出外边距与圆角。 */
  layoutClassName?: string;
}) {
  const pending = grant.status === "pending";
  const submitting =
    request?.status === "submitting" || request?.status === "submitted";
  const disabled = !canRespond || !pending || submitting;
  const isSensitive = grant.reason === "sensitive_workspace_file";

  return (
    <section
      className={`border border-[#e7c98d] bg-[#fff9eb] ${layoutClassName}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <strong className="text-sm text-[#75500f]">
            {workspaceGrantStatusLabel(grant)}
          </strong>
          <p className="mt-1.5 text-sm leading-[1.55] text-[#725b31]">
            {isSensitive
              ? "Agent 请求读取项目内的敏感文件。"
              : "Agent 请求读取项目外的一个文件。"}
          </p>
        </div>
        <span className="rounded-full border border-[#dfc485] bg-white px-2.5 py-1 text-[11px] font-bold text-[#79581a]">
          只读 · 单文件 · 一次
        </span>
      </div>

      <code className="mt-3 block break-all rounded-[7px] bg-[#f4ead3] px-3 py-2.5 text-xs leading-[1.55] text-[#5f4a24]">
        {grant.requestedPath}
      </code>
      <p className="mt-2.5 text-xs leading-[1.5] text-[#806f4f]">
        {isSensitive
          ? "此文件可能包含密钥或凭据。允许后，内容可能发送给当前模型服务；此次授权仅对当前读取生效。"
          : "系统文件选择器会要求你确认这个文件；网页不会提交你在选择器中选中的路径。"}
      </p>

      {pending && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="cursor-pointer rounded-full border border-[#d3b575] bg-white px-3.5 py-2 text-xs font-bold text-[#79581a] hover:bg-[#fff4d7] disabled:cursor-not-allowed disabled:opacity-45"
            disabled={disabled}
            onClick={() => onRespond(grant.interactionId, "deny")}
          >
            {submitting && request?.action === "respond" ? "拒绝中…" : "拒绝"}
          </button>
          <button
            type="button"
            className="cursor-pointer rounded-full bg-[#9a6817] px-3.5 py-2 text-xs font-bold text-white hover:bg-[#7f5310] disabled:cursor-not-allowed disabled:opacity-45"
            disabled={disabled}
            onClick={() =>
              isSensitive
                ? onRespond(grant.interactionId, "approve")
                : onSelectFile(grant.interactionId)}
          >
            {isSensitive
              ? submitting && request?.action === "respond"
                ? "授权中…"
                : "允许读取一次"
              : submitting && request?.action === "select_file"
                ? "等待系统选择器…"
                : "选择文件并允许一次"}
          </button>
          {request?.status === "error" && (
            <p className="basis-full text-xs leading-[1.5] text-[#a9362e]" role="alert">
              {request.error}{" "}
              {isSensitive
                ? "你可以重试，或保持阻止。"
                : "你可以重新选择，或拒绝此次请求。"}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function workspaceGrantStatusLabel(grant: WorkspaceGrantTrace): string {
  if (grant.status === "expired") return "文件授权已过期";
  if (grant.status === "responded") {
    return grant.decision === "approve" ? "已允许读取一次" : "已拒绝文件授权";
  }
  return grant.reason === "sensitive_workspace_file"
    ? "Agent 请求读取敏感文件"
    : "需要项目外文件授权";
}
