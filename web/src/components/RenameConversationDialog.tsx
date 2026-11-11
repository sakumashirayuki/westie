import { useEffect, useRef, useState } from "react";

import type { ConversationRenameState } from "../hooks/useConversationRename";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "./ui/dialog";
import { primaryButtonClasses, secondaryButtonClasses } from "./view-styles";

const MAX_TITLE_LENGTH = 120;

/** 会话改名弹窗：输入框预填当前标题，清空输入即恢复为工作区名。 */
export function RenameConversationDialog({
  state,
  onChange,
  onCancel,
  onSubmit,
}: {
  state: ConversationRenameState | null;
  onChange: (draft: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const submitting = state?.status === "submitting";
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // 每次打开弹窗都把输入框重置为当前标题，并把焦点放到输入框。
  useEffect(() => {
    if (state === null) return;
    setDraft(state.draft);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [state?.conversation.id]);

  function commit(next: string): void {
    setDraft(next);
    onChange(next);
  }

  return (
    <Dialog open={state !== null} onClose={onCancel} dismissible={!submitting}>
      {state !== null && (
        <DialogContent size="sm" closeDisabled={submitting}>
          <DialogHeader
            eyebrow="RENAME CONVERSATION"
            eyebrowClassName="text-[#276c52]"
            title="重命名会话"
            description={
              <>
                当前项目 <strong>{state.conversation.workspace.name}</strong>
                ，清空输入并保存即恢复为项目名。
              </>
            }
          />
          <div className="px-6 pt-3 max-[600px]:px-[18px]">
            <label className="block text-xs font-bold text-[#4a554e]" htmlFor="conversation-title">
              会话标题
            </label>
            <input
              id="conversation-title"
              ref={inputRef}
              className="mt-1.5 w-full rounded-xl border border-[rgba(20,32,27,0.14)] bg-white px-3 py-2 text-sm outline-none focus:border-[#7aae99] disabled:opacity-60"
              value={draft}
              maxLength={MAX_TITLE_LENGTH}
              disabled={submitting}
              placeholder={state.conversation.workspace.name}
              onChange={(event) => commit(event.target.value)}
              onKeyDown={(event) => {
                // 中文输入法选词时按 Enter 是上屏，事件仍是 Enter；只拦真正的提交键。
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  onSubmit();
                }
              }}
            />
            <p className="mt-1.5 text-[11px] text-[#78817b]">
              {draft.trim().length}/{MAX_TITLE_LENGTH}
            </p>
          </div>
          {state.error !== undefined && (
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
              className={`min-w-[104px] ${primaryButtonClasses}`}
              disabled={submitting}
              onClick={onSubmit}
            >
              {submitting ? "正在保存…" : "保存"}
            </button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
