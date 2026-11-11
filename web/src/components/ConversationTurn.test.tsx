import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ConversationTurnState } from "../conversation-state";
import { ConversationTurn } from "./ConversationTurn";

function turn(
  steeringMessages: ConversationTurnState["run"]["steeringMessages"],
): ConversationTurnState {
  return {
    id: "turn-1",
    userMessage: "重构上下文压缩",
    subAgentRuns: {},
    subAgentDescriptions: {},
    run: {
      status: "running",
      runId: "run-1",
      answer: "",
      answerStatus: "idle",
      answerKind: null,
      steeringMessages,
      steps: [{
        number: 1,
        actionType: "tool",
        assistantText: "",
        tools: [],
        workspaceGrants: [],
      }],
    },
  };
}

function render(
  steeringMessages: ConversationTurnState["run"]["steeringMessages"],
): string {
  return renderToStaticMarkup(createElement(ConversationTurn, {
    turn: turn(steeringMessages),
    number: 1,
    interactionRequests: {},
    onRespond: vi.fn(),
    onSelectFile: vi.fn(),
  }));
}

describe("ConversationTurn", () => {
  // 插话曾经只渲染在默认折叠的运行过程里，用户点完插话看不到任何变化。
  it("shows steering messages outside the collapsed run trace", () => {
    const html = render([{ seq: 0, content: "先跑测试", status: "applied", step: 3 }]);

    expect(html).toContain("先跑测试");
    expect(html.indexOf("先跑测试")).toBeLessThan(html.indexOf("运行过程"));
  });

  it("shows a queued steering message before it takes effect", () => {
    const html = render([{ seq: 0, content: "先跑测试", status: "queued" }]);

    expect(html).toContain("已送达，将在下一步生效");
  });

  it("keeps the turn header clean when nothing was steered", () => {
    const html = render([]);

    expect(html).toContain("重构上下文压缩");
    expect(html).not.toContain("插话");
  });

  it("renders the latest todo list at the top of the turn", () => {
    const base = turn([]);
    const withTodo: ConversationTurnState = {
      ...base,
      run: {
        ...base.run,
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
                { content: "已完成步骤", status: "completed" },
                { content: "进行中步骤", status: "in_progress" },
              ],
              counts: { pending: 0, in_progress: 1, completed: 1 },
            },
            durationMs: 1,
          }],
        }],
      },
    };

    const html = renderToStaticMarkup(createElement(ConversationTurn, {
      turn: withTodo,
      number: 1,
      interactionRequests: {},
      onRespond: vi.fn(),
      onSelectFile: vi.fn(),
    }));

    expect(html).toContain("任务清单");
    expect(html).toContain("已完成步骤");
    expect(html).toContain("进行中步骤");
    expect(html).toContain("进行中");
  });
});

describe("ConversationTurn restored sub agents", () => {
  it("lists restored sub agent runs as entries when the trace is gone", () => {
    const base = turn([]);
    const restored: ConversationTurnState = {
      ...base,
      run: { ...base.run, status: "completed", steps: [] },
      subAgentRuns: {
        "call-a": {
          ...base.run,
          status: "completed",
          steps: [],
          usage: {
            calls: 2,
            unmeasuredCalls: 0,
            inputTokens: 700,
            cachedInputTokens: 0,
            outputTokens: 300,
            reasoningTokens: 0,
          },
        },
      },
      subAgentDescriptions: { "call-a": "审计 A 组" },
    };
    const onOpenSubAgent = vi.fn();

    const html = renderToStaticMarkup(createElement(ConversationTurn, {
      turn: restored,
      number: 1,
      interactionRequests: {},
      onRespond: vi.fn(),
      onSelectFile: vi.fn(),
      onOpenSubAgent,
    }));

    expect(html).toContain("子 Run · 1");
    expect(html).toContain("审计 A 组");
    expect(html).toContain("1000 tokens");
    expect(html).toContain("查看");
  });

  it("does not duplicate the entry while the live trace still shows the agent card", () => {
    const html = renderToStaticMarkup(createElement(ConversationTurn, {
      turn: { ...turn([]), subAgentRuns: { "call-a": turn([]).run }, subAgentDescriptions: {}, run: { ...turn([]).run, steps: [{ ...turn([]).run.steps[0]!, tools: [{ id: "call-a", name: "agent", status: "running", arguments: {}, subAgent: { runId: "child", status: "running", steps: 1 } }] }] } },
      number: 1,
      interactionRequests: {},
      onRespond: vi.fn(),
      onSelectFile: vi.fn(),
    }));

    expect(html).not.toContain("子 Run · 1");
  });

  it("keeps snapshot children visible when parent trace only has an approval", () => {
    const base = turn([]);
    const html = renderToStaticMarkup(createElement(ConversationTurn, {
      turn: {
        ...base,
        subAgentRuns: { "call-child": { ...base.run, status: "running", runId: "child-1" } },
        subAgentDescriptions: { "call-child": "慢任务" },
        run: { ...base.run, steps: [{ ...base.run.steps[0]!, tools: [{ id: "probe", name: "bash", status: "approval_required", arguments: {} }] }] },
      },
      number: 1, interactionRequests: {}, onRespond: vi.fn(), onSelectFile: vi.fn(), onOpenSubAgent: vi.fn(),
    }));
    expect(html).toContain("慢任务");
  });
});
