import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Sidebar } from "./Sidebar";

function render(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}): string {
  return renderToStaticMarkup(createElement(Sidebar, {
    conversations: {
      conversations: [],
      status: "ready",
      nextCursor: null,
      switchingDisabled: false,
      deletionDisabled: false,
      archiveDisabled: false,
      runActivities: new Map(),
      onSelect: vi.fn(),
      onRename: vi.fn(),
      onArchive: vi.fn(),
      onDelete: vi.fn(),
      onLoadMore: vi.fn(),
      onRetry: vi.fn(),
    },
    newConversationDisabled: false,
    onNewConversation: vi.fn(),
    onOpenMcpSettings: vi.fn(),
    onShowArchived: vi.fn(),
    ...overrides,
  }));
}

describe("Sidebar", () => {
  it("renders brand, primary action, conversation list and settings nav", () => {
    const html = render();
    expect(html).toContain("westie");
    expect(html).toContain("新建会话");
    expect(html).toContain("历史会话");
    expect(html).toContain("MCP 服务器");
    expect(html).toContain("已归档");
    expect(html).toContain('aria-label="设置"');
  });

  it("disables the primary action when asked", () => {
    const html = render({ newConversationDisabled: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?新建会话<\/button>/);
  });

  it("highlights the MCP nav item while its dialog is open", () => {
    expect(render()).not.toContain('aria-current="true"');
    expect(render({ activeNav: "mcp" })).toContain('aria-current="true"');
  });
});
