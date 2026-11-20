import type { RunStatus } from "../run-state";

export const statusLabels: Record<RunStatus, string> = {
  idle: "等待对话",
  running: "运行中",
  stopping: "正在停止",
  completed: "已完成",
  error: "运行失败",
  cancelled: "已停止",
};

export const surfaceClasses =
  "border border-[rgba(20,32,27,0.12)] bg-[#fcfcf9]";

const buttonBase =
  "cursor-pointer rounded-full text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-45";

/** 次要按钮：描边浅底。 */
export const secondaryButtonClasses =
  `${buttonBase} border border-[#cdd4cd] bg-[#f8faf7] px-4 py-2.5 text-[#3c4741] hover:bg-[#eef0eb]`;

/** 主按钮：品牌绿实底。 */
export const primaryButtonClasses =
  `${buttonBase} bg-[#276c53] px-4 py-2.5 text-white hover:bg-[#1f5943]`;

/** 危险按钮：红色实底。 */
export const dangerButtonClasses =
  `${buttonBase} bg-[#a33d35] px-4 py-2.5 text-white hover:bg-[#84312b]`;

/** 小号描边按钮，用在卡片和表单内。 */
export const smallButtonClasses =
  `${buttonBase} border border-[#cdd4cd] bg-[#f8faf7] px-3 py-1.5 text-xs text-[#275f49] hover:bg-[#eef4ef]`;

/** 表单输入框。 */
export const inputClasses =
  "w-full rounded-[8px] border border-[#cdd4cd] bg-white px-2.5 py-1.5 text-sm text-[#14201b] outline-none transition placeholder:text-[#9aa39d] focus:border-[#7aae99] focus:ring-2 focus:ring-[#7aae99]/30 disabled:bg-[#f4f5f1] disabled:text-[#8b948e] aria-[invalid=true]:border-[#d19a94] aria-[invalid=true]:focus:ring-[#d19a94]/30";