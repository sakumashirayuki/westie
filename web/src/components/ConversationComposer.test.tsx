// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationComposer } from "./ConversationComposer";

type ComposerProps = Parameters<typeof ConversationComposer>[0];

function renderComposer(overrides: Partial<ComposerProps> = {}) {
  const props = {
    input: "",
    status: "idle" as const,
    hasConversation: true,
    hasTurns: false,
    projectSelecting: false,
    canSteer: false,
    hasPendingInteraction: false,
    onInputChange: vi.fn(),
    onSubmit: vi.fn(),
    onSteer: vi.fn(),
    onStop: vi.fn(),
    ...overrides,
  };
  render(<ConversationComposer {...props} />);
  return props;
}

function renderStatefulComposer(overrides: Partial<ComposerProps> = {}) {
  function StatefulComposer() {
    const [input, setInput] = useState(overrides.input ?? "");
    return (
      <ConversationComposer
        {...{
          input,
          status: "idle",
          hasConversation: true,
          hasTurns: false,
          projectSelecting: false,
          canSteer: false,
          hasPendingInteraction: false,
          onInputChange: setInput,
          onSubmit: vi.fn(),
          onSteer: vi.fn(),
          onStop: vi.fn(),
          ...overrides,
        }}
      />
    );
  }
  render(<StatefulComposer />);
}

afterEach(() => {
  cleanup();
});

describe("ConversationComposer expand", () => {
  it("starts collapsed with two rows", () => {
    renderComposer();

    const textarea = screen.getByLabelText("开始对话") as HTMLTextAreaElement;
    const toggle = screen.getByRole("button", { name: "展开输入框" });

    expect(textarea.rows).toBe(2);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("expands to eight rows and collapses back", () => {
    renderComposer();

    const textarea = screen.getByLabelText("开始对话") as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole("button", { name: "展开输入框" }));

    expect(textarea.rows).toBe(8);
    const toggle = screen.getByRole("button", { name: "收起输入框" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle);

    expect((screen.getByLabelText("开始对话") as HTMLTextAreaElement).rows)
      .toBe(2);
    expect(screen.getByRole("button", { name: "展开输入框" }).getAttribute(
      "aria-expanded",
    )).toBe("false");
  });

  it("keeps the send button disabled while the input is empty", () => {
    renderStatefulComposer();

    expect(screen.getByRole("button", { name: "发送" }).hasAttribute("disabled"))
      .toBe(true);

    fireEvent.change(screen.getByLabelText("开始对话"), {
      target: { value: "继续分析" },
    });

    expect(screen.getByRole("button", { name: "发送" }).hasAttribute("disabled"))
      .toBe(false);
  });

  it("does not submit the form when toggling", () => {
    const props = renderComposer();

    fireEvent.click(screen.getByRole("button", { name: "展开输入框" }));

    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(props.onSteer).not.toHaveBeenCalled();
  });
});
