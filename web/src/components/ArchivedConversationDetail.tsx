import { ChevronLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import type { ConversationDetail } from "../run-client";
import { getConversation, HttpRunError } from "../run-client";
import {
  availabilityLabel,
  branchLabel,
  projectDisplayName,
  workspaceKindLabel,
} from "../project-groups";
import { UsageSummary } from "./UsageSummary";
import { surfaceClasses } from "./view-styles";
import { AccessModeBadge } from "./AccessModeBadge";
import { hydrateConversation } from "../conversation-state";
import { RunResult } from "./RunResult";
import { SteeringMessages } from "./SteeringMessages";
import { SubAgentList } from "./SubAgentList";

/**
 * 归档会话只读详情：完整展示历史消息、Run 轨迹、错误、插话与子 Run——与未归档
 * 会话一致——但不渲染输入框，没有重命名与运行控件，顶部提供「返回归档列表」。
 * 恢复历史时借用未归档的 hydrate 逻辑，只读渲染不含运行态交互。
 */
export function ArchivedConversationDetail() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (conversationId === undefined) return;
    const controller = new AbortController();
    setError(undefined);
    setConversation(null);
    void getConversation(conversationId, { signal: controller.signal })
      .then((detail) => setConversation(detail))
      .catch((loadError: unknown) => {
        if (controller.signal.aborted) return;
        const notFound = loadError instanceof HttpRunError &&
          loadError.status === 404;
        setError(notFound ? "该已归档会话不存在或已被删除。" : "加载会话失败，请重试。");
      });
    return () => controller.abort();
  }, [conversationId]);

  const archivedState = conversation === null
    ? undefined
    : hydrateConversation(conversation);

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div
        className={`${surfaceClasses} mb-[18px] rounded-[18px] p-[18px] max-[600px]:rounded-[14px]`}
      >
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1 text-sm font-bold text-[#275f49] hover:text-[#1f5943]"
          onClick={() => navigate("/archived")}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          返回归档列表
        </button>

        {error !== undefined && (
          <p className="mt-4 text-sm text-[#a33d35]" role="alert">
            {error}
          </p>
        )}
        {conversation !== null && (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-[#b3c4ba] bg-[#eaf3ed] px-2 py-0.5 text-[11px] font-bold text-[#204f3d]">
                已归档
              </span>
              <span className="text-sm font-bold text-[#3c4741]">
                当前项目
              </span>
              <h1 className="truncate text-lg font-bold">
                {projectDisplayName(conversation)}
              </h1>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-[#cdd4cd] bg-[#f8faf7] px-2 py-0.5 text-[11px] font-bold text-[#3c4741]">
                {workspaceKindLabel(conversation.workspaceStatus.kind)}
              </span>
              <span className="rounded-full border border-[#cdd4cd] bg-[#f8faf7] px-2 py-0.5 font-mono text-[11px] text-[#3c4741]">
                {branchLabel(conversation.workspaceStatus.branch)}
              </span>
              <AccessModeBadge mode={conversation.executionMode} />
            </div>
            <p className="mt-2 truncate whitespace-nowrap font-mono text-xs leading-5 text-[#657068]">
              {conversation.workspace.canonicalPath}
            </p>
            {availabilityLabel(conversation.workspaceStatus.availability) !== null && (
              <p className="mt-2 text-xs text-[#a33d35]" role="alert">
                {availabilityLabel(conversation.workspaceStatus.availability)}
              </p>
            )}
          </>
        )}
      </div>

      {conversation !== null && archivedState !== undefined && (
        <div className="space-y-[18px]">
          {conversation.usage.calls > 0 && (
            <UsageSummary
              usage={conversation.usage}
              scope="conversation"
              className={`${surfaceClasses} rounded-[18px] px-[18px] py-3 max-[600px]:rounded-[14px]`}
            />
          )}
          {archivedState.turns.map((turn, index) => (
            <section
              key={turn.id}
              className={`${surfaceClasses} overflow-hidden rounded-[18px]`}
            >
              <div className="border-b border-[rgba(20,32,27,0.09)] px-[22px] py-[17px]">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-mono text-xs font-bold tracking-[0.08em] text-[#657068]">
                    TURN {index + 1}
                  </span>
                  <span className="text-xs text-[#69736d]">
                    {turn.run.status}
                  </span>
                </div>
                <p className="leading-[1.65] whitespace-pre-wrap">
                  {turn.userMessage}
                </p>
                <SteeringMessages messages={turn.run.steeringMessages} />
              </div>
              <div className="px-[22px] py-[19px]">
                <RunResult run={turn.run} />
              </div>
              {Object.keys(turn.subAgentRuns).length > 0 && (
                <div className="px-[22px] pb-[19px]">
                  <SubAgentList turn={turn} />
                </div>
              )}
            </section>
          ))}
          <p className="py-4 text-center text-xs text-[#8a938d]">
            该会话已归档，仅保留历史记录。
          </p>
        </div>
      )}
    </div>
  );
}