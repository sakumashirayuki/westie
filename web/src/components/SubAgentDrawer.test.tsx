import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { initialRunState, type RunState } from "../run-state";
import { SubAgentDrawer } from "./SubAgentDrawer";

describe("SubAgentDrawer", () => {
  const usage = {
    calls: 2,
    unmeasuredCalls: 0,
    inputTokens: 800,
    cachedInputTokens: 0,
    outputTokens: 200,
    reasoningTokens: 0,
  };

  it("renders the child run's header, trace and answer without an input", () => {
    const run: RunState = {
      ...initialRunState,
      status: "completed",
      runId: "child-1",
      answer: "共 3 处映射。",
      answerStatus: "completed",
      answerKind: "final",
      usage,
      steps: [{
        number: 1,
        actionType: "tool",
        assistantText: "",
        workspaceGrants: [],
        tools: [{
          id: "child-grep",
          name: "grep",
          status: "success",
          arguments: { pattern: "TOOL_APPROVAL_EXPIRED" },
          result: { matches: [] },
          durationMs: 12,
        }],
      }],
    };

    const html = renderToStaticMarkup(createElement(SubAgentDrawer, {
      description: "查错误码映射",
      run,
      canRespond: false,
      interactionRequests: {},
      onRespond: vi.fn(),
      onSelectFile: vi.fn(),
      onClose: vi.fn(),
    }));

    expect(html).toContain("SUB AGENT");
    expect(html).toContain("查错误码映射");
    expect(html).toContain("已完成");
    expect(html).toContain("1 steps");
    expect(html).toContain("1000 tokens");
    expect(html).toContain("共 3 处映射。");
    expect(html).toContain("grep");
    expect(html).not.toContain("<textarea");
  });

  it("renders a restored child run with answer and usage but no trace", () => {
    const run: RunState = {
      ...initialRunState,
      status: "completed",
      runId: "child-1",
      answer: "恢复后的回答",
      answerStatus: "completed",
      answerKind: "final",
      usage,
    };

    const html = renderToStaticMarkup(createElement(SubAgentDrawer, {
      description: "历史子 Run",
      run,
      canRespond: false,
      interactionRequests: {},
      onRespond: vi.fn(),
      onSelectFile: vi.fn(),
      onClose: vi.fn(),
    }));

    expect(html).toContain("恢复后的回答");
    expect(html).toContain("1000 tokens");
    expect(html).not.toContain("steps");
    expect(html).not.toContain("运行过程");
  });
});
