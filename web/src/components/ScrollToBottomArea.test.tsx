// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScrollToBottomArea } from "./ScrollToBottomArea";

/**
 * jsdom 不做布局，滚动尺寸需要手工指定：内容高 1000px，视口高 300px。
 */
const contentHeight = 1000;
const viewportHeight = 300;

describe("ScrollToBottomArea", () => {
  const scrollTo = vi.fn();

  beforeEach(() => {
    let scrollTop = 0;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.dataset.testScroll ? contentHeight : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.dataset.testScroll ? viewportHeight : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.dataset.testScroll ? scrollTop : 0;
      },
      set(value: number) {
        scrollTop = value;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    scrollTo.mockImplementation(function (this: HTMLElement) {
      scrollTop = contentHeight - viewportHeight;
    });
  });

  afterEach(() => {
    cleanup();
    scrollTo.mockReset();
    vi.restoreAllMocks();
  });

  function renderArea() {
    render(
      <ScrollToBottomArea>
        <div data-testid="content" />
      </ScrollToBottomArea>,
    );
    // 内容节点外是测量用的包裹层，再外一层才是滚动容器。
    const scroller = screen.getByTestId("content").parentElement
      ?.parentElement;
    if (scroller === null || scroller === undefined) {
      throw new Error("找不到滚动容器");
    }
    // 标记为可滚动后，尺寸读取才返回测试值。
    scroller.dataset.testScroll = "true";
    return scroller;
  }

  it("keeps the button hidden while the conversation is at the bottom", () => {
    const scroller = renderArea();
    scroller.scrollTop = contentHeight - viewportHeight;

    fireEvent.scroll(scroller);

    expect(screen.queryByRole("button", { name: "回到最新" })).toBeNull();
  });

  it("shows the button after the user scrolls away from the bottom", () => {
    const scroller = renderArea();
    scroller.scrollTop = 100;

    fireEvent.scroll(scroller);

    expect(screen.getByRole("button", { name: "回到最新" })).toBeTruthy();
  });

  it("scrolls to the bottom and hides the button when clicked", () => {
    const scroller = renderArea();
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "回到最新" }));
    });

    expect(scrollTo).toHaveBeenCalledWith({
      top: contentHeight,
      behavior: "smooth",
    });
    expect(screen.queryByRole("button", { name: "回到最新" })).toBeNull();
  });

  it("centers the floating button horizontally", () => {
    const scroller = renderArea();
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);

    const className = screen.getByRole("button", { name: "回到最新" })
      .className;

    expect(className).toContain("left-1/2");
    expect(className).toContain("-translate-x-1/2");
    expect(className).not.toContain("right-3");
  });

  it("keeps the button hidden when the content is shorter than the threshold", () => {
    const scroller = renderArea();
    scroller.scrollTop = contentHeight - viewportHeight - 50;

    fireEvent.scroll(scroller);

    expect(screen.queryByRole("button", { name: "回到最新" })).toBeNull();
  });
});
