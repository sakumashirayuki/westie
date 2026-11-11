import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { PendingInteraction } from "../pending-interactions";
import { PendingInteractionDock } from "./PendingInteractionDock";

const approval: PendingInteraction = {
  kind: "tool_approval",
  interactionId: "approval-1",
  step: 4,
  tool: {
    id: "call-bash",
    name: "bash",
    status: "approval_required",
    arguments: { command: "npm test -- --watch=false", timeoutMs: 30000 },
    approval: {
      interactionId: "approval-1",
      status: "pending",
      expiresAt: "2026-08-25T10:00:00.000Z",
      ruleId: "default:bash:confirm",
      argumentsDigest: "9b2",
      risk: "Bash can execute arbitrary commands.",
      impact: "Runs one zsh command.",
      grantOptions: [
        { kind: "command_prefix", value: "npm test" },
        { kind: "command_prefix", value: "npm" },
        { kind: "tool" },
      ],
    },
  },
};

function render(interaction: PendingInteraction[], requests = {}) {
  return renderToStaticMarkup(createElement(PendingInteractionDock, {
    interactions: interaction,
    interactionRequests: requests,
    onRespond: vi.fn(),
    onSelectFile: vi.fn(),
  }));
}

describe("PendingInteractionDock", () => {
  it("renders nothing when no interaction is pending", () => {
    expect(render([])).toBe("");
  });

  it("shows the originating step, the tool and the command to be executed", () => {
    const html = render([approval]);

    expect(html).toContain("STEP 4");
    expect(html).toContain("bash");
    expect(html).toContain("待执行参数");
    expect(html).toContain("npm test -- --watch=false");
  });

  it("renders one grant button per offered scope, most specific first", () => {
    const html = render([approval]);

    expect(html).toContain("允许一次");
    const specific = html.indexOf("本会话内允许 npm test");
    const broad = html.indexOf("本会话内允许 npm<");
    const all = html.indexOf("本会话内允许所有 bash");
    expect(specific).toBeGreaterThan(-1);
    expect(all).toBeGreaterThan(-1);
    expect(specific).toBeLessThan(broad === -1 ? all : broad);
    expect(broad === -1 ? specific : broad).toBeLessThan(all);
  });

  it("keeps the approval buttons enabled without a run-trace canRespond flag", () => {
    expect(render([approval])).not.toContain('disabled=""');
  });

  it("reports a failed submission on the pending card", () => {
    const html = render([approval], {
      "approval-1": {
        status: "error",
        action: "respond",
        error: "提交确认结果失败，请重试。",
      },
    });

    expect(html).toContain("提交确认结果失败，请重试。");
  });
});
