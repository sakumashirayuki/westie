// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { emptyRunUsageTotals } from "../events";
import {
  UNKNOWN_WORKSPACE_STATUS,
  type ConversationDetail,
  type ConversationSummary,
} from "../run-client";
import { ConversationList } from "./ConversationList";
import { WorkspacePanel } from "./WorkspacePanel";

const timestamp = "2026-08-03T00:00:00.000Z";

function summary(
  id: string,
  executionMode: ConversationSummary["executionMode"],
): ConversationSummary {
  return {
    id,
    revision: 0,
    executionMode,
    title: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    workspace: { name: `project-${id}` },
    project: { key: `git:/workspace/${id}/.git`, root: `/workspace/${id}`, name: `project-${id}` },
    archived: false,
  };
}

describe("access mode views", () => {
  it("does not show execution mode badges in the conversation list", () => {
    const html = renderToStaticMarkup(createElement(ConversationList, {
      conversations: [
        summary("sandbox", "workspace_sandbox"),
        summary("full", "full_access"),
      ],
      selectedId: "full",
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
    }));

    expect(html).not.toContain("Sandbox");
    expect(html).not.toContain("Full Access");
    expect(html).toMatch(/aria-current="page"/);
    expect(html).toContain(
      "aria-label=\"会话操作 project-sandbox sandbox\"",
    );
    expect(html).toContain(
      "aria-label=\"会话操作 project-full full\"",
    );
    expect(html).not.toMatch(/<button[^>]*>[^<]*<button/);
  });

  it("shows the current project mode as read-only", () => {
    const conversation: ConversationDetail = {
      ...summary("conversation-id-123", "full_access"),
      workspace: { name: "project-conversation-id-123", canonicalPath: "/workspace/conversation-id-123" },
      workspaceStatus: UNKNOWN_WORKSPACE_STATUS,
      usage: emptyRunUsageTotals(),
      turns: [],
    };
    const html = renderToStaticMarkup(createElement(WorkspacePanel, {
      conversation,
      openingDisabled: false,
      opening: false,
      onOpenProject: vi.fn(),
    }));

    expect(html).toContain("Full Access");
    expect(html).not.toContain("此会话的工作目录与执行模式不可更改");
    // 工作目录类型与分支：来自实时状态，未知时明确说明。
    expect(html).toContain("目录未确认");
    expect(html).toContain("分支未知");
    expect(html).not.toContain("打开其他项目");
    expect(html).toContain("会话详情");
    expect(html).not.toContain("type=\"radio\"");
  });

  it("expands and collapses workspace details", () => {
    const conversation: ConversationDetail = {
      ...summary("conversation-id-123", "full_access"),
      workspace: { name: "project-conversation-id-123", canonicalPath: "/workspace/conversation-id-123" },
      workspaceStatus: UNKNOWN_WORKSPACE_STATUS,
      usage: emptyRunUsageTotals(),
      turns: [],
    };
    const view = render(createElement(WorkspacePanel, {
      conversation,
      openingDisabled: false,
      opening: false,
      onOpenProject: vi.fn(),
    }));

    const toggle = screen.getByRole("button", { name: "会话详情 ▾" });
    expect(screen.queryByText("项目主目录：/workspace/conversation-id-123")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("项目主目录：/workspace/conversation-id-123")).toBeTruthy();
    expect(screen.getByRole("button", { name: "收起详情 ▴" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "收起详情 ▴" }));
    expect(screen.queryByText("项目主目录：/workspace/conversation-id-123")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "会话详情 ▾" }));
    view.rerender(createElement(WorkspacePanel, {
      conversation: { ...conversation, id: "next-conversation" },
      openingDisabled: false,
      opening: false,
      onOpenProject: vi.fn(),
    }));
    expect(screen.queryByText("next-conversation")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "会话详情 ▾" }));
    expect(screen.getByText("next-conversation")).toBeTruthy();
  });

  it("keeps the unavailable workspace warning visible", () => {
    const conversation: ConversationDetail = {
      ...summary("missing-workspace", "workspace_sandbox"),
      workspace: { name: "project-missing-workspace", canonicalPath: "/workspace/missing-workspace" },
      workspaceStatus: {
        ...UNKNOWN_WORKSPACE_STATUS,
        availability: { status: "missing" },
      },
      usage: emptyRunUsageTotals(),
      turns: [],
    };
    const html = renderToStaticMarkup(createElement(WorkspacePanel, {
      conversation,
      openingDisabled: false,
      opening: false,
      onOpenProject: vi.fn(),
    }));
    expect(html).toContain("目录不存在");
    expect(html).toContain("仍可查看历史记录");
  });

  it("keeps long workspace paths accessible", () => {
    const path = "/Users/example/.westie/worktrees/my-agent-harness/feature/very-long-branch-name";
    const conversation: ConversationDetail = {
      ...summary("long-path", "workspace_sandbox"),
      workspace: { name: "workspace", canonicalPath: path },
      workspaceStatus: UNKNOWN_WORKSPACE_STATUS,
      usage: emptyRunUsageTotals(),
      turns: [],
    };
    const html = renderToStaticMarkup(createElement(WorkspacePanel, {
      conversation,
      openingDisabled: false,
      opening: false,
      onOpenProject: vi.fn(),
    }));
    expect(html).toContain(`title="${path}"`);
    expect(html).toContain(path);
  });

  it("does not show conversation actions before a project is opened", () => {
    const html = renderToStaticMarkup(createElement(WorkspacePanel, {
      conversation: null,
      openingDisabled: false,
      opening: false,
      onOpenProject: vi.fn(),
    }));

    expect(html).not.toContain("会话 ID");
    expect(html).not.toContain("复制会话 ID");
    expect(html).toContain("打开项目");
  });
});
