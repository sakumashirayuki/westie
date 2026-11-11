// @vitest-environment jsdom
// 行内操作菜单的行为测试走 jsdom：菜单项只在展开后渲染，静态渲染看不到。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RowActionMenu } from "./row-action-menu";

afterEach(cleanup);

/**
 * Radix 的菜单触发器监听 pointerdown；jsdom 里 `fireEvent.click` 只派发 click，
 * 菜单不会打开。这里补一次 pointerDown，模拟真实指针按下再点击。
 */
async function openMenu(label: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: label }), {
    button: 0,
    ctrlKey: false,
    pointerId: 1,
    pointerType: "mouse",
  });
  // Radix 在 pointerdown 后异步渲染菜单内容，等一帧再查询。
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}



describe("RowActionMenu", () => {
  it("reveals the actions only after opening the menu", async () => {
    render(
      <RowActionMenu
        label="会话操作 a"
        actions={[
          { label: "重命名", onSelect: vi.fn() },
          { label: "删除", onSelect: vi.fn(), tone: "danger" },
        ]}
      />,
    );

    expect(screen.queryByRole("menuitem", { name: "重命名" })).toBeNull();

    await openMenu("会话操作 a");

    expect(screen.getByRole("menuitem", { name: "重命名" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "删除" })).toBeDefined();
  });

  it("calls the matching handler and closes the menu", async () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();
    render(
      <RowActionMenu
        label="会话操作 a"
        actions={[
          { label: "重命名", onSelect: onRename },
          { label: "删除", onSelect: onDelete, tone: "danger" },
        ]}
      />,
    );

    await openMenu("会话操作 a");
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("menuitem", { name: "重命名" })).toBeNull();
  });

  it("disables an action with its reason while the conversation is running", async () => {
    const onRename = vi.fn();
    render(
      <RowActionMenu
        label="会话操作 a"
        actions={[
          {
            label: "重命名",
            onSelect: onRename,
            disabled: true,
            disabledReason: "会话正在运行",
          },
        ]}
      />,
    );

    await openMenu("会话操作 a");
    const item = screen.getByRole("menuitem", { name: /重命名/ });

    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain("会话正在运行");

    fireEvent.click(item);
    expect(onRename).not.toHaveBeenCalled();
  });

  it("closes on Escape without selecting anything", async () => {
    const onRename = vi.fn();
    render(
      <RowActionMenu
        label="会话操作 a"
        actions={[{ label: "重命名", onSelect: onRename }]}
      />,
    );

    await openMenu("会话操作 a");
    expect(screen.getByRole("menuitem", { name: "重命名" })).toBeDefined();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

    expect(screen.queryByRole("menuitem", { name: "重命名" })).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });
});

describe("RowActionMenu trigger", () => {
  // 回归守卫：Radix 的菜单触发器由 pointerdown 打开，只派发 click 打不开。
  // 如果有人把触发方式改成 click-only，真实鼠标仍可用，但这条守卫会失败，
  // 提醒把测试里的 pointerDown 辅助一起改掉，否则后续测试会静默失效。
  it("opens from a pointerdown on the trigger", async () => {
    render(
      <RowActionMenu
        label="会话操作 a"
        actions={[{ label: "重命名", onSelect: vi.fn() }]}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "会话操作 a" }), {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    expect(screen.getByRole("menuitem", { name: "重命名" })).toBeDefined();
  });
});
