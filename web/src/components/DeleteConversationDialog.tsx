import type { ConversationSummary } from "../run-client";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "./ui/dialog";
import { dangerButtonClasses, secondaryButtonClasses } from "./view-styles";

export interface DeleteConversationDialogState {
  conversation: ConversationSummary;
  status: "confirming" | "submitting" | "error";
  error?: string;
}

export function DeleteConversationDialog({
  state,
  onCancel,
  onSubmit,
}: {
  state: DeleteConversationDialogState | null;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const submitting = state?.status === "submitting";
  return (
    <Dialog open={state !== null} onClose={onCancel} dismissible={!submitting}>
      {state !== null && (
        <DialogContent size="sm" closeDisabled={submitting}>
          <DialogHeader
            eyebrow="DELETE CONVERSATION"
            eyebrowClassName="text-[#9a4c44]"
            title="删除会话？"
            description={
              <>
                将删除项目 <strong>{state.conversation.workspace.name}</strong> 的会话
                <span className="ml-1 font-mono">
                  {state.conversation.id.slice(0, 8)}
                </span>
                。删除后无法恢复。
              </>
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
              {submitting ? "正在删除…" : "确认删除"}
            </button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
