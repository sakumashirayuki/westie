import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RunTrace } from "./RunTrace";
import { WorkspaceGrantCard } from "./WorkspaceGrantCard";

const grant = {
  interactionId: "interaction-1",
  toolCallId: "tool-1",
  toolName: "request_file_access",
  status: "pending" as const,
  expiresAt: "2026-07-27T10:00:00.000Z",
  requestedPath: "/Users/me/data/input.csv",
  reason: "outside_workspace" as const,
  access: "read" as const,
  scope: "once" as const,
};

describe("WorkspaceGrantCard", () => {
  it("shows the requested path, precise scope, picker action, and retry copy", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceGrantCard, {
      grant,
      canRespond: true,
      request: {
        status: "error",
        action: "select_file",
        error: "未选择文件，授权尚未完成。",
      },
      onRespond: vi.fn(),
      onSelectFile: vi.fn(),
    }));

    expect(html).toContain("/Users/me/data/input.csv");
    expect(html).toContain("只读 · 单文件 · 一次");
    expect(html).toContain("选择文件并允许一次");
    expect(html).toContain("你可以重新选择");
  });

  it("approves a sensitive file directly and explains the provider boundary", () => {
    const onRespond = vi.fn();
    const onSelectFile = vi.fn();
    const html = renderToStaticMarkup(createElement(WorkspaceGrantCard, {
      grant: {
        ...grant,
        reason: "sensitive_workspace_file",
        requestedPath: "/Users/me/project/.env",
      },
      canRespond: true,
      request: undefined,
      onRespond,
      onSelectFile,
    }));

    expect(html).toContain("Agent 请求读取敏感文件");
    expect(html).toContain("内容可能发送给当前模型服务");
    expect(html).toContain("允许读取一次");
    expect(html).not.toContain("选择文件并允许一次");
  });

  it("opens the run trace and points at the docked card while pending", () => {
    const html = renderToStaticMarkup(createElement(RunTrace, {
      steps: [{
        number: 1,
        assistantText: "",
        tools: [],
        workspaceGrants: [grant],
      }],
      canRespond: true,
      interactionRequests: {},
      onRespond: vi.fn(),
      onSelectFile: vi.fn(),
    }));

    expect(html).toMatch(/^<details[^>]* open=""/);
    expect(html).toContain("文件读取授权待处理");
    expect(html).not.toContain("需要项目外文件授权");
    expect(html).not.toContain("选择文件并允许一次");
  });
});
