import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SteeringMessages } from "./SteeringMessages";

describe("SteeringMessages", () => {
  it("renders nothing when the run has no steering messages", () => {
    const html = renderToStaticMarkup(
      createElement(SteeringMessages, { messages: [] }),
    );

    expect(html).toBe("");
  });

  it("shows an accepted message as queued before it takes effect", () => {
    const html = renderToStaticMarkup(createElement(SteeringMessages, {
      messages: [{ seq: 0, content: "先跑测试", status: "queued" }],
    }));

    expect(html).toContain("先跑测试");
    expect(html).toContain("已送达，将在下一步生效");
  });

  it("names the step a message took effect on", () => {
    const html = renderToStaticMarkup(createElement(SteeringMessages, {
      messages: [{ seq: 0, content: "先跑测试", status: "applied", step: 4 }],
    }));

    expect(html).toContain("先跑测试");
    expect(html).toContain("已在 STEP 4 生效");
  });

  it("keeps messages in acceptance order", () => {
    const html = renderToStaticMarkup(createElement(SteeringMessages, {
      messages: [
        { seq: 0, content: "改用简洁中文", status: "applied", step: 2 },
        { seq: 1, content: "先跑测试", status: "queued" },
      ],
    }));

    expect(html.indexOf("改用简洁中文")).toBeLessThan(
      html.indexOf("先跑测试"),
    );
  });
});
