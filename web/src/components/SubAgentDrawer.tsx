import { useEffect } from "react";

import type {
  InteractionRequestMap,
  InteractionResponder,
  WorkspaceGrantSelector,
} from "../interaction-ui";
import type { RunState } from "../run-state";
import { RunResult } from "./RunResult";
import { RunTrace } from "./RunTrace";
import { statusLabels } from "./view-styles";

export interface SubAgentDrawerProps {
  description: string;
  run: RunState;
  canRespond: boolean;
  interactionRequests: InteractionRequestMap;
  onRespond: InteractionResponder;
  onSelectFile: WorkspaceGrantSelector;
  onClose: () => void;
  onStop?: () => void;
}

/**
 * 子 Run 的只读抽屉：从右侧滑出，正文复用父 Run 的轨迹与回答组件。
 * 没有输入框，子 Run 不接收插话；审批仍在输入框上方的 Dock 里处理。
 * 历史会话恢复的子 Run 没有步骤列表，只显示回答与用量。
 */
export function SubAgentDrawer({
  description,
  run,
  canRespond,
  interactionRequests,
  onRespond,
  onSelectFile,
  onClose,
  onStop,
}: SubAgentDrawerProps) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="关闭子 Run 视图"
        className="flex-1 cursor-default bg-[rgba(20,32,27,0.28)]"
        onClick={onClose}
      />
      <aside
        className="flex h-full w-full max-w-[720px] flex-col border-l border-[rgba(20,32,27,0.12)] bg-[#f7f5ee] shadow-[-18px_0_60px_rgba(50,57,48,0.18)]"
        role="dialog"
        aria-modal="true"
        aria-label={`子 Run · ${description}`}
      >
        <header className="flex items-start gap-3 border-b border-[rgba(20,32,27,0.09)] px-[22px] py-[17px]">
          <div className="min-w-0 flex-1">
            <span className="font-mono text-xs font-bold tracking-[0.08em] text-[#657068]">
              SUB AGENT
            </span>
            <h2 className="mt-1 truncate text-base font-bold text-[#14201b]">
              {description}
            </h2>
            <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-[#69736d]">
              <span>{statusLabels[run.status]}</span>
              {run.steps.length > 0 && <span>{run.steps.length} steps</span>}
              {run.usage !== undefined && (
                <span>
                  {run.usage.inputTokens + run.usage.outputTokens} tokens
                </span>
              )}
            </p>
          </div>
          <button
            type="button"
            className="rounded-[9px] border border-[#d8dbd4] bg-white px-3 py-1.5 text-xs text-[#405048] hover:bg-[#eff0eb]"
            onClick={onClose}
          >
            关闭
          </button>
          {onStop !== undefined && (run.status === "running" || run.status === "stopping") && (
            <button type="button" className="rounded-[9px] border border-[#e1b9b4] bg-white px-3 py-1.5 text-xs text-[#a33d35] disabled:opacity-50" disabled={run.status === "stopping"} onClick={onStop}>
              {run.status === "stopping" ? "正在停止…" : "停止"}
            </button>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-[22px] py-[19px]">
          <RunResult run={run} />
          {run.steps.length > 0 && (
            <RunTrace
              steps={run.steps}
              canRespond={canRespond}
              interactionRequests={interactionRequests}
              onRespond={onRespond}
              onSelectFile={onSelectFile}
            />
          )}
        </div>
      </aside>
    </div>
  );
}
