import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { RunState } from "../run-state";
import { RunResult } from "./RunResult";

describe("RunResult", () => {
  it("renders completed agent answers as Markdown without raw HTML or images", () => {
    const html = renderToStaticMarkup(createElement(RunResult, {
      run: completedRun([
        "# 标题",
        "",
        "- 第一项",
        "- 第二项",
        "",
        "`inlineCode()`",
        "",
        '<script>alert("unsafe")</script>',
        "",
        "![tracking pixel](https://example.com/tracker.png)",
      ].join("\n")),
    }));

    expect(html).toContain("<h1");
    expect(html).toContain("<li");
    expect(html).toContain("<code");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("tracker.png");
  });

  it("renders an incomplete fenced code block while the answer is streaming", () => {
    const html = renderToStaticMarkup(createElement(RunResult, {
      run: {
        ...completedRun("```ts\nconst value = 1"),
        status: "running",
        answerStatus: "streaming",
        answerKind: "pending",
      },
    }));

    expect(html).toContain("<pre");
    expect(html).toContain('data-language="ts"');
    expect(html).toContain('data-streamdown="code-block-copy-button"');
    expect(html).toContain('title="复制代码"');
    expect(html).toContain("before:content-[counter(line)]");
    expect(html).toContain("const value = 1");
    expect(html).toContain("生成中");
    expect(html).toContain("Agent 输出");
  });

  it("distinguishes tool explanations from final answers", () => {
    const toolHtml = renderToStaticMarkup(createElement(RunResult, {
      run: {
        ...completedRun("I will inspect the file."),
        status: "running",
        answerKind: "tool",
      },
    }));
    const finalHtml = renderToStaticMarkup(createElement(RunResult, {
      run: completedRun("问题已经定位。"),
    }));

    expect(toolHtml).toContain("工具调用说明");
    expect(toolHtml).toContain("调用工具");
    expect(toolHtml).toContain('data-output-kind="tool"');
    expect(toolHtml).toContain("agent-output-transition");
    expect(toolHtml).not.toContain("animate-pulse");
    expect(finalHtml).toContain("最终回答");
    expect(finalHtml).toContain('data-output-kind="agent"');
  });

  it("renders a compact usage line including cache hit ratio and unmeasured calls", () => {
    const html = renderToStaticMarkup(createElement(RunResult, {
      run: {
        ...completedRun("回答。"),
        usage: {
          calls: 3,
          unmeasuredCalls: 1,
          inputTokens: 95210,
          cachedInputTokens: 22528,
          outputTokens: 1108,
          reasoningTokens: 0,
        },
      },
    }));

    expect(html).toContain("输入 95,210 token");
    expect(html).toContain("缓存命中 24%");
    expect(html).toContain("输出 1,108 token");
    expect(html).toContain("调用 3");
    expect(html).toContain("未测得 1 次");
  });
});

describe("RunResult retries", () => {
  it("shows the retry notice for the running step", () => {
    const html = renderToStaticMarkup(createElement(RunResult, {
      run: {
        status: "running",
        answer: "",
        answerStatus: "idle",
        answerKind: null,
        steeringMessages: [],
        steps: [{
          number: 1,
          assistantText: "",
          tools: [],
          workspaceGrants: [],
          retry: { attempt: 2, maxAttempts: 5, delayMs: 3000, reason: "rate_limited" },
        }],
      },
    }));

    expect(html).toContain("模型服务限流");
    expect(html).toContain("3 秒后重试");
    expect(html).toContain("（2/5）");
  });

  it("explains MODEL_UNAVAILABLE in Chinese", () => {
    const html = renderToStaticMarkup(createElement(RunResult, {
      run: {
        ...completedRun(""),
        status: "error",
        error: { kind: "run", code: "MODEL_UNAVAILABLE", message: "Model service is temporarily unavailable." },
      },
    }));

    expect(html).toContain("自动重试已用尽");
  });
});

function completedRun(answer: string, overrides: Partial<RunState> = {}): RunState {
  return {
    status: "completed",
    answer,
    answerStatus: "completed",
    answerKind: "final",
    steps: [],
    steeringMessages: [],
    ...overrides,
  };
}

describe("RunResult project memory notice", () => {
  it("warns when the memory index was truncated", () => {
    const html = renderToStaticMarkup(createElement(RunResult, {
      run: {
        ...completedRun("done"),
        memory: { status: "truncated", nextLine: 201 },
      },
    }));
    expect(html).toContain("第 201 行");
  });

  it("explains when project memory is unavailable without leaking a path", () => {
    const html = renderToStaticMarkup(createElement(RunResult, {
      run: {
        ...completedRun("done"),
        memory: { status: "unavailable", reason: "read" },
      },
    }));
    expect(html).toContain("未能加载项目记忆");
    expect(html).not.toContain("绝对路径");
  });
});
