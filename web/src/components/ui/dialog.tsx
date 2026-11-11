// 弹窗底座：shadcn/ui 的做法，样式层是我们自己的文件，行为层来自 Radix
// （焦点困住、Esc、遮罩点击、焦点回归、aria 关联）。不用 Portal：三个弹窗都是
// fixed 定位铺满视口，没有需要逃出的层叠上下文，而且静态渲染的测试要能看到内容。

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

export interface DialogProps {
  open: boolean;
  /** 用户请求关闭（✕、Esc、遮罩）。提交中时把 `dismissible` 设为 false 即可屏蔽。 */
  onClose: () => void;
  dismissible?: boolean;
  children: ReactNode;
}

export function Dialog({
  open,
  onClose,
  dismissible = true,
  children,
}: DialogProps) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && dismissible) onClose();
      }}
    >
      {children}
    </DialogPrimitive.Root>
  );
}

type DialogSize = "sm" | "md" | "lg";

const sizeClasses: Record<DialogSize, string> = {
  sm: "max-w-[480px]",
  md: "max-w-[560px]",
  lg: "max-w-[880px]",
};

export interface DialogContentProps
  extends Omit<ComponentProps<typeof DialogPrimitive.Content>, "children"> {
  size?: DialogSize;
  /** 关闭按钮在提交中禁用；为 false 时不渲染。 */
  closeButton?: boolean;
  closeDisabled?: boolean;
  children: ReactNode;
}

export function DialogContent({
  size = "md",
  closeButton = true,
  closeDisabled = false,
  className = "",
  children,
  ...props
}: DialogContentProps) {
  return (
    <>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[rgba(20,32,27,0.42)]" />
      <DialogPrimitive.Content
        className={`fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100%-2.5rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[18px] border border-[rgba(20,32,27,0.16)] bg-[#fcfcf9] shadow-[0_24px_90px_rgba(20,32,27,0.24)] outline-none max-[600px]:rounded-[14px] ${sizeClasses[size]} ${className}`}
        {...props}
      >
        {children}
        {closeButton && (
          <DialogPrimitive.Close
            className="absolute right-4 top-4 inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-[#657068] transition hover:bg-[#eef0eb] hover:text-[#14201b] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#276c53] disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="关闭"
            disabled={closeDisabled}
          >
            <X className="size-4" aria-hidden="true" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </>
  );
}

/** 头部：小标题、标题、说明。右侧留出关闭按钮的位置。 */
export function DialogHeader({
  eyebrow,
  eyebrowClassName = "text-[#6c766f]",
  title,
  description,
}: {
  eyebrow?: string;
  eyebrowClassName?: string;
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="shrink-0 px-6 pr-14 pt-6 max-[600px]:px-[18px] max-[600px]:pr-12 max-[600px]:pt-[18px]">
      {eyebrow !== undefined && (
        <p className={`text-xs font-bold tracking-[0.1em] ${eyebrowClassName}`}>
          {eyebrow}
        </p>
      )}
      <DialogPrimitive.Title className="mt-1.5 text-xl font-bold">
        {title}
      </DialogPrimitive.Title>
      {description !== undefined ? (
        <DialogPrimitive.Description className="mt-1.5 text-sm leading-6 text-[#657068]">
          {description}
        </DialogPrimitive.Description>
      ) : (
        <DialogPrimitive.Description className="sr-only">
          {title}
        </DialogPrimitive.Description>
      )}
    </div>
  );
}

/** 正文：默认带左右内边距，可滚动；`bleed` 让正文自己管内边距（左列表右表单用）。 */
export function DialogBody({
  children,
  bleed = false,
  className = "",
}: {
  children: ReactNode;
  bleed?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`min-h-0 flex-1 overflow-y-auto ${
        bleed ? "" : "px-6 pt-5 max-[600px]:px-[18px]"
      } ${className}`}
    >
      {children}
    </div>
  );
}

/** 底部动作区：左侧放提示文字，右侧放按钮。 */
export function DialogFooter({
  children,
  note,
}: {
  children: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-4 px-6 pb-6 pt-5 max-[600px]:px-[18px] max-[600px]:pb-[18px]">
      <div className="min-w-0 text-sm text-[#657068]">{note}</div>
      <div className="flex shrink-0 items-center gap-2.5">{children}</div>
    </div>
  );
}
