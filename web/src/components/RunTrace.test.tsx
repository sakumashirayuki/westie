import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RunTrace } from "./RunTrace";

describe("RunTrace tool cards", () => {
  it("renders a todo card as a checklist instead of raw JSON", () => {
    const html = renderToStaticMarkup(createElement(RunTrace, {
      steps: [{
        number: 1,
        actionType: "tool",
        assistantText: "",
        workspaceGrants: [],
        tools: [{
          id: "call-todo",
          name: "todo",
          status: "success",
          arguments: {},
          result: {
            items: [
              { content: "第一步", status: "completed" },
              { content: "第二步", status: "in_progress" },
            ],
            counts: { pending: 0, in_progress: 1, completed: 1 },
          },
          durationMs: 1,
        }],
      }],
      canRespond: false,
      interactionRequests: {},
      onRespond: vi.fn(),
      onSelectFile: vi.fn(),
    }));

    expect(html).toContain("任务清单");
    expect(html).toContain("第一步");
    expect(html).toContain("第二步");
    expect(html).toContain("进行中");
    // 不显示原始 JSON。
    expect(html).not.toContain("in_progress"); // 状态值是内部键，不应出现在正文
  });

  it("renders web_fetch summary with finalUrl and title", () => {
    const html = renderToStaticMarkup(createElement(RunTrace, {
      steps: [{
        number: 1,
        actionType: "tool",
        assistantText: "",
        workspaceGrants: [],
        tools: [{
          id: "call-fetch",
          name: "web_fetch",
          status: "success",
          arguments: { url: "https://example.com/" },
          result: {
            url: "https://example.com/",
            finalUrl: "https://example.com/final",
            status: 200,
            contentType: "text/html",
            title: "My Page",
            content: "text",
            startLine: 1,
            endLine: 1,
            totalLines: 1,
          },
          durationMs: 10,
        }],
      }],
      canRespond: false,
      interactionRequests: {},
      onRespond: vi.fn(),
      onSelectFile: vi.fn(),
    }));

    expect(html).toContain("https://example.com/final");
    expect(html).toContain("My Page");
  });

  it("renders glob summary with pattern and hit count", () => {
    const html = renderToStaticMarkup(createElement(RunTrace, {
      steps: [{
        number: 1,
        actionType: "tool",
        assistantText: "",
        workspaceGrants: [],
        tools: [{
          id: "call-glob",
          name: "glob",
          status: "success",
          arguments: { pattern: "**/*.ts" },
          result: { paths: ["a.ts", "b.ts"] },
          durationMs: 10,
        }],
      }],
      canRespond: false,
      interactionRequests: {},
      onRespond: vi.fn(),
      onSelectFile: vi.fn(),
    }));

    expect(html).toContain("**/*.ts");
    expect(html).toContain("2 命中");
  });

  it("renders an mcp__ summary line and text content", () => {
    const html = renderToStaticMarkup(createElement(RunTrace, {
      steps: [{
        number: 1,
        actionType: "tool",
        assistantText: "",
        workspaceGrants: [],
        tools: [{
          id: "call-mcp",
          name: "mcp__github__create_issue",
          status: "success",
          arguments: { title: "hello" },
          result: {
            server: "github",
            tool: "create_issue",
            content: [
              { type: "text", text: "issue-1 created" },
              { type: "image", mimeType: "image/png", bytes: 4, omitted: true },
            ],
          },
          durationMs: 10,
        }],
      }],
      canRespond: false,
      interactionRequests: {},
      onRespond: vi.fn(),
      onSelectFile: vi.fn(),
    }));

    expect(html).toContain("github · create_issue");
    expect(html).toContain("issue-1 created");
    expect(html).toContain("image (4 bytes, omitted)");
  });
});

describe("RunTrace", () => {
  it("shows tool-step assistant text above the tool card", () => {
    const html = renderToStaticMarkup(createElement(RunTrace, {
      steps: [{
        number: 1,
        actionType: "tool",
        assistantText: "I will inspect the file.",
        workspaceGrants: [],
        tools: [{
          id: "call-1",
          name: "read",
          status: "success",
          arguments: { path: "README.md" },
          result: { content: "example" },
          durationMs: 8,
        }],
      }],
      canRespond: false,
      interactionRequests: {},
      onRespond: vi.fn(),
      onSelectFile: vi.fn(),
    }));

    expect(html).toContain("模型说明");
    expect(html).toContain("I will inspect the file.");
    expect(html.indexOf("I will inspect the file.")).toBeLessThan(
      html.indexOf("read"),
    );
  });

  it("does not repeat final-step text in the run trace", () => {
    const html = renderToStaticMarkup(createElement(RunTrace, {
      steps: [{
        number: 1,
        actionType: "final",
        assistantText: "Final answer",
        workspaceGrants: [],
        tools: [],
      }],
      canRespond: false,
      interactionRequests: {},
      onRespond: vi.fn(),
      onSelectFile: vi.fn(),
    }));

    expect(html).not.toContain("模型说明");
    expect(html).not.toContain("Final answer");
  });

  it("renders multiple tools in one step without a component change", () => {
    const html = renderToStaticMarkup(createElement(RunTrace, {
      steps: [{
        number: 1,
        actionType: "tool",
        assistantText: "",
        workspaceGrants: [],
        tools: [
          { id: "call-read", name: "read", status: "success", arguments: { path: "README.md" }, result: { content: "text" }, durationMs: 8 },
          { id: "call-grep", name: "grep", status: "success", arguments: { pattern: "TODO" }, result: { matches: [] }, durationMs: 4 },
        ],
      }],
      canRespond: false,
      interactionRequests: {},
      onRespond: vi.fn(),
      onSelectFile: vi.fn(),
    }));

    expect(html).toContain("read");
    expect(html).toContain("grep");
    expect(html.indexOf("read")).toBeLessThan(html.indexOf("grep"));
  });
});

describe("RunTrace agent card", () => {
  const agentStep = {
    number: 4,
    actionType: "tool" as const,
    assistantText: "",
    workspaceGrants: [],
    tools: [{
      id: "call-agent",
      name: "agent",
      status: "running" as const,
      arguments: { description: "查错误码映射", task: "找出全部位置" },
      subAgent: { runId: "child-1", status: "running" as const, steps: 5 },
    }],
  };

  it("shows the description and a button to open the child run", () => {
    const html = renderToStaticMarkup(createElement(RunTrace, {
      steps: [agentStep],
      canRespond: true,
      interactionRequests: {},
      onRespond: vi.fn(),
      onSelectFile: vi.fn(),
      onOpenSubAgent: vi.fn(),
    }));

    expect(html).toContain("查错误码映射");
    expect(html).toContain("5 steps");
    expect(html).toContain("查看子 Run");
    // 子 Run 的步骤不嵌套渲染在父轨迹里。
    expect(html).not.toContain("STEP 1");
  });

  it("renders the summary as plain text when no opener is provided", () => {
    const html = renderToStaticMarkup(createElement(RunTrace, {
      steps: [agentStep],
      canRespond: false,
      interactionRequests: {},
      onRespond: vi.fn(),
      onSelectFile: vi.fn(),
    }));

    expect(html).toContain("5 steps");
    expect(html).not.toContain("查看子 Run");
  });
});

describe("RunTrace interrupted tool", () => {
  it("labels a TOOL_INTERRUPTED tool as 已中断", () => {
    const html = renderToStaticMarkup(createElement(RunTrace, {
      steps: [{
        number: 1,
        actionType: "tool",
        assistantText: "",
        workspaceGrants: [],
        tools: [{
          id: "call-a",
          name: "read",
          status: "error",
          arguments: { path: "README.md" },
          error: { code: "TOOL_INTERRUPTED", message: "Run 在这个工具执行期间被用户取消，工具可能已经部分执行，结果未知。" },
        }],
      }],
      canRespond: false,
      interactionRequests: {},
      onRespond: vi.fn(),
      onSelectFile: vi.fn(),
    }));

    expect(html).toContain("已中断");
    expect(html).not.toContain("失败");
  });

  it("labels a blocked completion check on the step and in the tool card", () => {
    const html = renderToStaticMarkup(createElement(RunTrace, {
      steps: [{
        number: 1,
        actionType: "waiting",
        assistantText: "",
        workspaceGrants: [],
        tools: [{
          id: "run-1:stop_hook:1:1",
          name: "stop_hook",
          status: "success",
          arguments: {
            command: "node .agents/check-completion.mjs",
            timeoutMs: 30000,
          },
          result: { decision: "block", reason: "空输入测试未通过" },
          durationMs: 12,
        }],
      }],
      canRespond: false,
      interactionRequests: {},
      onRespond: vi.fn(),
      onSelectFile: vi.fn(),
    }));

    expect(html).toContain("完成检查要求继续");
    expect(html).toContain("要求继续");
    expect(html).toContain("空输入测试未通过");
    expect(html).toContain("node .agents/check-completion.mjs");
  });

  it("shows an allowed completion check as a passed step", () => {
    const html = renderToStaticMarkup(createElement(RunTrace, {
      steps: [{
        number: 2,
        actionType: "waiting",
        assistantText: "",
        workspaceGrants: [],
        tools: [{
          id: "run-1:stop_hook:2:1",
          name: "stop_hook",
          status: "success",
          arguments: { command: "node check.mjs", timeoutMs: 30000 },
          result: { decision: "allow" },
          durationMs: 8,
        }],
      }],
      canRespond: false,
      interactionRequests: {},
      onRespond: vi.fn(),
      onSelectFile: vi.fn(),
    }));

    expect(html).toContain("允许结束");
    expect(html).toContain("脚本允许结束");
    expect(html).toContain("完成检查放行");
    expect(html).not.toContain("要求继续");
  });

  it("labels a failed completion check as failed instead of passed", () => {
    const html = renderToStaticMarkup(createElement(RunTrace, {
      steps: [{
        number: 3,
        assistantText: "",
        workspaceGrants: [],
        tools: [{
          id: "run-1:stop_hook:3:1",
          name: "stop_hook",
          status: "error",
          arguments: { command: "sleep 5", timeoutMs: 100 },
          error: { code: "COMMAND_TIMEOUT", message: "Command timed out after 100ms." },
          durationMs: 100,
        }],
      }],
      canRespond: false,
      interactionRequests: {},
      onRespond: vi.fn(),
      onSelectFile: vi.fn(),
    }));

    expect(html).toContain("完成检查失败");
    expect(html).toContain("检查执行失败");
    expect(html).toContain("Command timed out after 100ms.");
    expect(html).not.toContain("完成检查放行");
    expect(html).not.toContain("允许结束");
  });
});
