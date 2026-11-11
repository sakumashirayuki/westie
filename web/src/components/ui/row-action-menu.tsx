// 行内操作菜单：Radix DropdownMenu 提供键盘导航、焦点管理、Esc 与遮罩点击关闭，
// 样式层是项目自己的。菜单渲染进 Portal，才能逃出会话列表的滚动容器不被裁剪；
// 代价是静态渲染看不到菜单项，菜单项的行为由 jsdom 测试覆盖
// （row-action-menu.test.tsx）。
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";

export interface RowAction {
  /** 菜单项文字。 */
  readonly label: string;
  readonly onSelect: () => void;
  /** 为 true 时禁用并给出原因，例如会话有 Run 在跑。 */
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  /** 危险操作用红色文字。 */
  readonly tone?: "default" | "danger";
}

/**
 * 列表行右侧的“更多操作”菜单。触发按钮是可访问的 `<button>`，
 * 菜单项用 Radix 的 menuitem 角色，键盘上下键与 Esc 由 Radix 处理。
 */
export function RowActionMenu({
  label,
  actions,
}: {
  /** 触发按钮的 aria-label，用于区分不同行的同名菜单。 */
  label: string;
  actions: readonly RowAction[];
}) {
  return (
    <DropdownMenuPrimitive.Root modal={false}>
      <DropdownMenuPrimitive.Trigger
        className="m-1.5 mr-0 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center self-center rounded-lg text-[#5c665f] transition hover:bg-[#eef0eb] hover:text-[#14201b] data-[state=open]:bg-[#eef0eb] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#276c53]"
        aria-label={label}
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-[132px] rounded-xl border border-[rgba(20,32,27,0.16)] bg-[#fcfcf9] p-1 shadow-[0_18px_50px_rgba(20,32,27,0.2)] outline-none"
        >
          {actions.map((action) => (
            <DropdownMenuPrimitive.Item
              key={action.label}
              className={`cursor-pointer select-none rounded-lg px-3 py-2 text-xs font-bold outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 data-[highlighted]:bg-[#eef4ef] ${
                action.tone === "danger" ? "text-[#a33d35]" : "text-[#3c4741]"
              }`}
              disabled={action.disabled ?? false}
              title={action.disabled === true ? action.disabledReason : undefined}
              onSelect={action.onSelect}
            >
              {action.label}
              {action.disabled === true && action.disabledReason !== undefined && (
                <span className="mt-0.5 block font-normal text-[11px] text-[#8a938c]">
                  {action.disabledReason}
                </span>
              )}
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
