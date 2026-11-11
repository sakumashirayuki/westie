import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import App from "./App";
import {
  conversationDeletionErrorMessage,
  workspaceGrantErrorMessage,
  workspaceSelectionErrorMessage,
} from "./error-messages";
import { HttpRunError } from "./run-client";

describe("workspace selection UI", () => {
  it("requires a project before the first message can be sent", () => {
    const markup = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(App)),
    );

    expect(markup).toContain("请先打开项目");
    expect(markup).toContain("打开项目");
    expect(markup).toMatch(/<textarea[^>]*disabled/);
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>发送<\/button>/);
  });

  it.each([
    [
      "HOST_DIRECTORY_PICKER_CANCELLED",
      "未选择项目，当前项目没有变化。",
    ],
    [
      "WORKSPACE_SELECTION_INVALID",
      "所选目录不可用，请重新选择项目。",
    ],
    [
      "HOST_DIRECTORY_PICKER_UNAVAILABLE",
      "无法打开 macOS 系统目录选择器，请重试。",
    ],
    [
      "HOST_DIRECTORY_PICKER_FAILED",
      "无法打开 macOS 系统目录选择器，请重试。",
    ],
    [
      "WORKSPACE_RUNTIME_UNAVAILABLE",
      "项目运行环境初始化失败，请重试或选择其他目录。",
    ],
    [
      "FULL_ACCESS_REQUIRES_LOOPBACK",
      "Full Access 只能在绑定本机回环地址的服务中使用。",
    ],
    [
      "UNTRUSTED_ORIGIN",
      "当前页面来源不能打开项目或使用 Full Access。",
    ],
  ])("turns %s into project-selection copy", (code, message) => {
    expect(workspaceSelectionErrorMessage(
      new HttpRunError(409, "Server message.", code),
    )).toBe(message);
  });
});

describe("conversationDeletionErrorMessage", () => {
  it.each([
    [
      "CONVERSATION_BUSY",
      "会话正在运行，请等待运行结束后再删除。",
    ],
    [
      "UNTRUSTED_ORIGIN",
      "当前页面来源不能删除会话。",
    ],
  ])("turns %s into deletion copy", (code, message) => {
    expect(conversationDeletionErrorMessage(
      new HttpRunError(409, "Server message.", code),
    )).toBe(message);
  });

  it("uses a stable Chinese fallback", () => {
    expect(conversationDeletionErrorMessage(new Error("Failed."))).toBe(
      "删除会话失败，请重试。",
    );
  });
});

describe("workspaceGrantErrorMessage", () => {
  it.each([
    [
      "HOST_FILE_PICKER_CANCELLED",
      "未选择文件，授权尚未完成。",
    ],
    [
      "WORKSPACE_GRANT_SELECTION_MISMATCH",
      "所选文件与 Agent 请求的文件不一致，授权尚未完成。",
    ],
  ])("turns retryable %s responses into actionable copy", (code, message) => {
    expect(workspaceGrantErrorMessage(
      new HttpRunError(409, "Server message.", code),
    )).toBe(message);
  });

  it("uses a stable fallback when the picker cannot be opened", () => {
    expect(workspaceGrantErrorMessage(new Error("Failed."))).toBe(
      "打开系统文件选择器失败，请重试。",
    );
  });
});
