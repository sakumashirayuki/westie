import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UsageSummary } from "./UsageSummary";

describe("UsageSummary", () => {
  it("labels the run and conversation scopes differently", () => {
    const usage = {
      calls: 4,
      unmeasuredCalls: 0,
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 120,
      reasoningTokens: 0,
    };

    expect(
      renderToStaticMarkup(createElement(UsageSummary, { usage, scope: "run" })),
    ).toContain("本轮");
    expect(
      renderToStaticMarkup(
        createElement(UsageSummary, { usage, scope: "conversation" }),
      ),
    ).toContain("本会话");
  });

  it("reports a zero cache ratio instead of dividing by zero", () => {
    const html = renderToStaticMarkup(createElement(UsageSummary, {
      scope: "conversation",
      usage: {
        calls: 1,
        unmeasuredCalls: 1,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
    }));

    expect(html).toContain("缓存命中 0%");
    expect(html).toContain("未测得 1 次");
  });
});
