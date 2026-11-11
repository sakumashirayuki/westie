import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ConversationList } from "./ConversationList";
import { conversationDisplayName } from "./conversation-display-name";
import { UNKNOWN_WORKSPACE_STATUS, type ConversationSummary } from "../run-client";

function summary(id: string): ConversationSummary {
  return {
    id,
    revision: 1,
    executionMode: "workspace_sandbox",
    title: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    workspace: { name: id },
    project: { key: `git:/ws/${id}/.git`, root: `/ws/${id}`, name: id },
    archived: false,
  };
}

function render(runActivities: ReadonlyMap<string, { runId: string; state: string }>) {
  return renderToStaticMarkup(createElement(ConversationList, {
    conversations: [summary("a"), summary("b"), summary("c")],
    selectedId: undefined,
    status: "ready",
    nextCursor: null,
    switchingDisabled: false,
    deletionDisabled: false,
    archiveDisabled: false,
    runActivities: runActivities as ReadonlyMap<string, { runId: string; state: "running" | "awaiting_interaction" | "ended" }>,
    onSelect: vi.fn(),
    onRename: vi.fn(),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
  }));
}

describe("ConversationList run status markers", () => {
  it("shows running and awaiting markers with aria labels", () => {
    const html = render(new Map([
      ["a", { runId: "r1", state: "running" }],
      ["b", { runId: "r2", state: "awaiting_interaction" }],
    ]));
    expect(html).toContain('aria-label="运行中"');
    expect(html).toContain('aria-label="等待审批"');
    expect(html).toContain("run-status-dot--running");
    expect(html).toContain("run-status-dot--awaiting");
  });

  it("renders one actions menu trigger per conversation", () => {
    const html = render(new Map());
    const triggers = html.match(/<button[^>]*aria-label="会话操作[^"]*"[^>]*>/g) ?? [];
    expect(triggers).toHaveLength(3);
    expect(triggers.some((trigger) => trigger.includes("会话操作 a"))).toBe(true);
  });
});

describe("conversation display name", () => {
  it("prefers the title and falls back to the workspace name", () => {
    expect(conversationDisplayName({ title: "自定义标题", workspace: { name: "project" } }))
      .toBe("自定义标题");
    expect(conversationDisplayName({ title: null, workspace: { name: "project" } }))
      .toBe("project");
  });

  it("renders the custom title in the list instead of the project name", () => {
    const html = renderToStaticMarkup(createElement(ConversationList, {
      conversations: [{ ...summary("a"), title: "重构沙箱配置" }],
      selectedId: undefined,
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
    expect(html).toContain("重构沙箱配置");
    // 标题优先：会话行不再用目录名当标题，目录名只出现在项目分组标题里。
    expect(html).toMatch(/aria-label="项目 a"/);
    expect(html).not.toContain('font-bold">a</span>');
  });

  // 菜单项要展开才渲染，静态渲染只看得到触发按钮；禁用语义由 RowActionMenu 的
  // 单元测试覆盖（见 ui/row-action-menu.test.tsx），这里只验证行内不再出现
  // 裸的改名/删除按钮。
  it("no longer renders standalone rename or delete buttons", () => {
    const html = render(new Map([
      ["a", { runId: "r1", state: "running" }],
    ]));
    expect(html).not.toContain('aria-label="删除会话');
    expect(html).not.toContain('aria-label="重命名会话');
    expect(html).toContain("会话操作 a");
  });

  it("groups conversations by project without repeating workspace details per row", () => {
    const html = renderToStaticMarkup(createElement(ConversationList, {
      conversations: [
        {
          ...summary("main-run"),
          project: { key: "git:/ws/main-run/.git", root: "/ws/main-run", name: "main-run" },
        },
        {
          ...summary("worktree-run"),
          project: { key: "git:/ws/main-run/.git", root: "/ws/main-run", name: "main-run" },
        },
        // 未识别项目：仍然可见，并显示原目录。
        { ...summary("legacy"), project: null },
      ],
      selectedId: undefined,
      status: "ready",
      nextCursor: null,
      switchingDisabled: false,
      deletionDisabled: false,
    archiveDisabled: false,
      runActivities: new Map(),
      projectActions: {
        newConversationDisabled: false,
        onNewConversationInProject: vi.fn(),
      },
      onSelect: vi.fn(),
      onRename: vi.fn(),
      onArchive: vi.fn(),
      onDelete: vi.fn(),
      onLoadMore: vi.fn(),
      onRetry: vi.fn(),
    }));

    expect(html).toContain('aria-label="项目 main-run"');
    expect(html).not.toContain("主目录 · main");
    expect(html).not.toContain("Worktree · feat/evaluation");
    expect(html).toContain("在 main-run 中新建会话");
    // 归属暂未识别的历史会话仍单独成组。
    expect(html).toContain('aria-label="项目 未识别"');
    expect(html).not.toContain('title="/ws/legacy"');
    // 项目旁的 ＋ 只出现在已识别项目上：两个已识别会话共用一个项目分组。
    expect(html.match(/aria-label="在 [^"]*中新建会话"/g)).toEqual([
      'aria-label="在 main-run 中新建会话"',
    ]);
  });

  it("does not repeat workspace availability in the conversation list", () => {
    const html = renderToStaticMarkup(createElement(ConversationList, {
      conversations: [{
        ...summary("gone"),
      }],
      selectedId: undefined,
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

    expect(html).not.toContain("目录不存在");
    expect(html).not.toContain("分支未知");
  });
});
