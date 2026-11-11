import { useEffect, useRef, useState } from "react";

import type { ConversationDetail } from "../run-client";
import {
  availabilityLabel,
  branchLabel,
  projectDisplayName,
  workspaceKindLabel,
} from "../project-groups";
import { AccessModeBadge } from "./AccessModeBadge";
import { surfaceClasses } from "./view-styles";

export function WorkspacePanel({
  conversation,
  openingDisabled,
  opening,
  onOpenProject,
}: {
  conversation: ConversationDetail | null;
  openingDisabled: boolean;
  opening: boolean;
  onOpenProject: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const copyFeedbackTimer = useRef<number | undefined>(undefined);

  useEffect(() => setDetailsOpen(false), [conversation?.id]);
  useEffect(() => () => window.clearTimeout(copyFeedbackTimer.current), []);

  async function copyConversationId(): Promise<void> {
    if (conversation === null) return;

    try {
      await navigator.clipboard.writeText(conversation.id);
      setCopied(true);
      window.clearTimeout(copyFeedbackTimer.current);
      copyFeedbackTimer.current = window.setTimeout(
        () => setCopied(false),
        2_000,
      );
    } catch {
      // The browser owns clipboard permission prompts and failures.
    }
  }

  return (
    <section
      className={`${surfaceClasses} mb-[18px] rounded-[18px] p-[18px] max-[600px]:rounded-[14px]`}
      aria-label="当前项目"
    >
      <div className="flex items-start justify-between gap-4 max-[600px]:flex-col">
        <div className="min-w-0">
          {conversation === null ? (
            <>
              <p className="text-xs font-bold tracking-[0.1em] text-[#6c766f]">WORKSPACE</p>
              <h2 className="mt-1.5 text-lg font-bold">请先打开项目</h2>
              <p className="mt-1 text-sm leading-6 text-[#657068]">
                Agent 只会在你通过 macOS 系统选择器确认的目录中工作。
              </p>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-bold tracking-[0.1em] text-[#6c766f]">当前项目</p>
                <h2 className="truncate text-lg font-bold">{projectDisplayName(conversation)}</h2>
                <span className="rounded-full border border-[#cdd4cd] bg-[#f8faf7] px-2 py-0.5 text-[11px] font-bold text-[#3c4741]">
                  {workspaceKindLabel(conversation.workspaceStatus.kind)}
                </span>
                <span className="rounded-full border border-[#cdd4cd] bg-[#f8faf7] px-2 py-0.5 font-mono text-[11px] text-[#3c4741]">
                  {branchLabel(conversation.workspaceStatus.branch)}
                </span>
                <AccessModeBadge mode={conversation.executionMode} />
              </div>
              <p
                className="mt-2 truncate whitespace-nowrap font-mono text-xs leading-5 text-[#657068]"
                title={conversation.workspace.canonicalPath}
              >
                {conversation.workspace.canonicalPath}
              </p>
              {availabilityLabel(conversation.workspaceStatus.availability) !== null && (
                <p className="mt-2 text-xs text-[#a33d35]" role="alert">
                  {availabilityLabel(conversation.workspaceStatus.availability)}
                  ：仍可查看历史记录，但不能在该目录启动新的 Run。
                </p>
              )}
              {detailsOpen && (
                <div className="mt-3 space-y-2">
                  <p>此会话的工作目录与执行模式不可更改</p>
                  {conversation.project !== null && (
                    <p className="break-all font-mono text-[11px] text-[#858d87]">
                      项目主目录：{conversation.project.root}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-bold text-[#657068]">会话 ID</span>
                    <code className="min-w-0 break-all font-mono text-xs text-[#3f4942]">{conversation.id}</code>
                    <button type="button" className="cursor-pointer rounded-full border border-[#cdd4cd] bg-[#f8faf7] px-3 py-1 text-xs font-bold text-[#275f49] hover:bg-[#eef4ef]" onClick={() => void copyConversationId()}>
                      {copied ? "已复制" : "复制会话 ID"}
                    </button>
                    <span className="sr-only" role="status" aria-live="polite">{copied ? "会话 ID 已复制" : ""}</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        {conversation === null ? (
          <button
            type="button"
            className="shrink-0 cursor-pointer rounded-full border border-[#cdd4cd] bg-[#f8faf7] px-4 py-2 text-sm font-bold text-[#275f49] hover:bg-[#eef4ef] disabled:cursor-not-allowed disabled:opacity-45"
            onClick={onOpenProject}
            disabled={openingDisabled || opening}
          >
            {opening ? "正在打开…" : "打开项目"}
          </button>
        ) : (
          <button type="button" className="shrink-0 cursor-pointer rounded-full border border-[#cdd4cd] bg-[#f8faf7] px-3 py-1.5 text-xs font-bold text-[#275f49] hover:bg-[#eef4ef]" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>
            {detailsOpen ? "收起详情 ▴" : "会话详情 ▾"}
          </button>
        )}
      </div>
    </section>
  );
}
