import type { ConversationSummary } from "../run-client";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "./ui/dialog";
import { dangerButtonClasses, secondaryButtonClasses } from "./view-styles";

export interface ArchiveConversationDialogState {
  conversation: ConversationSummary;
  status: "confirming" | "submitting" | "error";
  error?: string;
}

export function ArchiveConversationDialog({
  state,
  onCancel,
  onSubmit,
}: {
  state: ArchiveConversationDialogState | null;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const submitting = state?.status === "submitting";
  return (
    <Dialog open={state !== null} onClose={onCancel} dismissible={!submitting}>
      {state !== null && (
        <DialogContent size="sm" closeDisabled={submitting}>
          <DialogHeader
            eyebrow="ARCHIVE CONVERSATION"
            eyebrowClassName="text-[#9a4c44]"
            title="归档会话？"
            description={
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  会话 <span className="font-mono">{state.conversation.id.slice(0, 8)}</span>{" "}
                  将从主列表移除，移入「已归档」。
                </li>
                <li>此会话创建的 worktree 目录将被删除。</li>
                <li>
                  worktree 内未提交的更改将被直接丢弃，且无法恢复。
                </li>
                <li>对应的本地分支会保留，不会被删除。</li>
                <li>归档后无法继续对话，操作不可撤销。</li>
              </ul>
            }
          />
          {state.status === "error" && (
            <p className="px-6 pt-3 text-sm text-[#a33d35] max-[600px]:px-[18px]" role="alert">
              {state.error}
            </p>
          )}
          <DialogFooter>
            <button
              type="button"
              className={secondaryButtonClasses}
              disabled={submitting}
              onClick={onCancel}
            >
              取消
            </button>
            <button
              type="button"
              className={`min-w-[104px] ${dangerButtonClasses}`}
              disabled={submitting}
              onClick={onSubmit}
            >
              {submitting ? "正在归档…" : "确认归档"}
            </button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}