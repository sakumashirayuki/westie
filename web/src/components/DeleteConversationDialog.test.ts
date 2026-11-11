import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { type ConversationSummary } from "../run-client";
import {
  DeleteConversationDialog,
  type DeleteConversationDialogState,
} from "./DeleteConversationDialog";

const conversation: ConversationSummary = {
  id: "conversation-id-123",
  revision: 0,
  executionMode: "workspace_sandbox",
  title: null,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  project: null,
  workspace: { name: "my-project" },
  archived: false,
};

function render(state: DeleteConversationDialogState | null): string {
  return renderToStaticMarkup(createElement(DeleteConversationDialog, {
    state,
    onCancel: vi.fn(),
    onSubmit: vi.fn(),
  }));
}

describe("DeleteConversationDialog", () => {
  it("shows the project, short id, and irreversible warning", () => {
    const html = render({ conversation, status: "confirming" });

    expect(html).toContain("my-project");
    expect(html).toContain("conversa");
    expect(html).not.toContain("conversation-id-123");
    expect(html).toContain("删除后无法恢复");
    expect(html).toContain("确认删除");
  });

  it("locks actions while submitting and retains retryable errors", () => {
    const submitting = render({ conversation, status: "submitting" });
    expect(submitting).toContain("正在删除…");
    // 关闭 ✕、取消、确认三个按钮在提交中都禁用。
    expect(submitting.match(/disabled=""/g)).toHaveLength(3);

    const failed = render({
      conversation,
      status: "error",
      error: "会话正在运行，请等待运行结束后再删除。",
    });
    expect(failed).toContain("会话正在运行，请等待运行结束后再删除。");
    expect(failed).toContain('role="alert"');
    expect(failed).not.toContain("正在删除…");
  });

  it("renders nothing while closed", () => {
    expect(render(null)).toBe("");
  });
});
