import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  initialMcpSettingsState,
  mcpSettingsReducer,
  type McpSettingsState,
} from "../mcp-settings-state";
import type { McpServerEntry } from "../run-client";
import { McpSettingsDialog } from "./McpSettingsDialog";

const servers: McpServerEntry[] = [
  {
    name: "github",
    config: {
      type: "stdio",
      command: "npx",
      args: ["-y", "server-github"],
      env: { TOKEN: "${GITHUB_TOKEN}" },
      timeoutMs: 60_000,
    },
  },
  {
    name: "docs",
    config: { type: "http", url: "https://docs.example/mcp", timeoutMs: 60_000 },
  },
];

function ready(): Extract<McpSettingsState, { status: "ready" }> {
  const state = mcpSettingsReducer(
    mcpSettingsReducer(initialMcpSettingsState, { type: "open" }),
    { type: "loaded", servers },
  );
  if (state.status !== "ready") throw new Error("expected ready");
  return state;
}

function render(state: McpSettingsState): string {
  return renderToStaticMarkup(createElement(McpSettingsDialog, {
    state,
    dispatch: vi.fn(),
    onRetryLoad: vi.fn(),
    onProbe: vi.fn(),
    onSave: vi.fn(),
  }));
}

describe("McpSettingsDialog", () => {
  it("renders nothing while closed", () => {
    expect(render(initialMcpSettingsState)).toBe("");
  });

  it("renders the header, the server list and the selected stdio form", () => {
    const html = render(ready());
    expect(html).toContain("MCP 服务器");
    expect(html).toContain('aria-label="关闭"');
    expect(html).toContain("服务器 · 2");
    expect(html).toContain("github");
    expect(html).toContain("docs");
    // 选中 github：stdio 字段可见，http 字段不可见。
    expect(html).toContain('value="npx"');
    expect(html).toContain('value="server-github"');
    expect(html).toContain('value="${GITHUB_TOKEN}"');
    expect(html).not.toContain("https://docs.example/mcp");
    expect(html).toContain("测试连接");
    expect(html).toContain("删除此服务器");
  });

  it("switches to the http fields when an http server is selected", () => {
    const base = ready();
    const state = mcpSettingsReducer(base, { type: "select", id: base.drafts[1]!.id });
    const html = render(state);
    expect(html).toContain('value="https://docs.example/mcp"');
    expect(html).toContain("请求头");
    expect(html).not.toContain('value="npx"');
  });

  it("disables saving and shows the name error for a blank new server", () => {
    const html = render(mcpSettingsReducer(ready(), { type: "add" }));
    expect(html).toContain("未命名");
    expect(html).toContain("请填写名称。");
    expect(html).toContain("有字段未填对");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>保存<\/button>/);
  });

  it("marks duplicate names in the list", () => {
    const base = ready();
    const state = mcpSettingsReducer(base, {
      type: "edit",
      id: base.drafts[1]!.id,
      patch: { name: "github" },
    });
    const html = render(state);
    expect(html).toContain("已有同名服务器。");
    expect((html.match(/text-\[#a33d35\]">github</g) ?? []).length).toBeGreaterThan(0);
  });

  it("shows probe results next to the button and as a list dot", () => {
    const base = ready();
    const state = mcpSettingsReducer(base, {
      type: "probe_finished",
      id: base.drafts[0]!.id,
      result: { status: "ok", toolCount: 21 },
    });
    const html = render(state);
    expect(html).toContain("连接成功，21 个工具");
    expect(html).toContain('aria-label="连接成功"');
  });

  it("renders the load error with a retry and no form", () => {
    const html = render({ status: "load_error", error: "mcp.json is not valid JSON" });
    expect(html).toContain("读取配置失败");
    expect(html).toContain("mcp.json is not valid JSON");
    expect(html).toContain("重试");
    expect(html).not.toContain("测试连接");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>保存<\/button>/);
  });

  it("renders the discard confirmation when closing with unsaved changes", () => {
    const dirty = mcpSettingsReducer(ready(), { type: "add" });
    const asked = mcpSettingsReducer(dirty, { type: "request_close" });
    const html = render(asked);
    expect(html).toContain("放弃修改？");
    expect(html).toContain("留下");
  });

  it("shows the empty state when there are no servers", () => {
    const state = mcpSettingsReducer(
      mcpSettingsReducer(initialMcpSettingsState, { type: "open" }),
      { type: "loaded", servers: [] },
    );
    const html = render(state);
    expect(html).toContain("还没有配置任何 MCP 服务器");
    expect(html).toContain("新增第一个服务器");
  });
});
