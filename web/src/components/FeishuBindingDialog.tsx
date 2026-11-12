import { Copy, Clock } from "lucide-react";
import { useState } from "react";

import type { UseLarkBindingResult } from "../hooks/useLarkBinding";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "./ui/dialog";
import {
  dangerButtonClasses,
  primaryButtonClasses,
  secondaryButtonClasses,
  smallButtonClasses,
} from "./view-styles";

/** 飞书绑定弹窗：未绑定（绑定码指引）、已绑定（单聊归属与解绑）、码已过期三种状态。 */
export function FeishuBindingDialog({
  open,
  conversationName,
  lark,
  onClose,
}: {
  open: boolean;
  conversationName: string;
  lark: UseLarkBindingResult;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const state = lark.state;
  const submitting = state.status === "submitting";

  return (
    <Dialog open={open} onClose={onClose} dismissible={!submitting}>
      <DialogContent size="sm" closeDisabled={submitting}>
        <DialogHeader
          eyebrow="FEISHU BINDING"
          eyebrowClassName="text-[#276c52]"
          title="绑定飞书单聊"
          description={`当前会话：${conversationName}`}
        />

        {state.status === "loading" && (
          <div className="px-6 py-6 text-sm text-[#69736d]">正在加载…</div>
        )}

        {state.status === "unavailable" && (
          <div className="px-6 py-6">
            <p className="text-sm text-[#a33d35]" role="alert">{state.error}</p>
          </div>
        )}

        {state.status === "unbound" && !state.expired && state.code !== undefined && (
          <div className="px-6 pt-3 max-[600px]:px-[18px]">
            <p className="text-sm leading-6 text-[#657068]">
              ① 在飞书中搜索机器人「Westie」，打开与它的单聊。
            </p>
            <p className="mt-2 text-sm leading-6 text-[#657068]">
              ② 向机器人发送下面的绑定码完成授权。
            </p>
            <div className="mt-3 flex items-center justify-between rounded-xl border border-[rgba(20,32,27,0.14)] bg-[#f5f6f2] px-4 py-3">
              <code className="font-mono text-xl font-bold tracking-widest text-[#14201b]">
                {state.code.code}
              </code>
              <button
                type="button"
                className={smallButtonClasses}
                onClick={() => {
                  void navigator.clipboard?.writeText(state.code?.code ?? "");
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                <span className="inline-flex items-center gap-1">
                  <Copy className="size-3.5" aria-hidden="true" />
                  {copied ? "已复制" : "复制绑定码"}
                </span>
              </button>
            </div>
            <p className="mt-2 flex items-center gap-1 text-[11px] text-[#8a938d]">
              一次性 · <Clock className="size-3" aria-hidden="true" />
              {formatRemaining(state.code.expiresAt)} · 仅授权当前会话
            </p>
            <p className="mt-3 text-[11px] text-[#8a938d]">
              绑定成功前可关闭窗口，绑定码在有效期内仍然有效。
            </p>
          </div>
        )}

        {state.status === "unbound" && !state.expired && state.code === undefined && (
          <div className="px-6 py-6">
            <p className="text-sm text-[#69736d]">尚未生成绑定码。</p>
          </div>
        )}

        {state.status === "unbound" && state.expired && (
          <div className="px-6 pt-3 max-[600px]:px-[18px]">
            <p className="text-sm leading-6 text-[#a5650d]">
              绑定码已过期，旧码已失效，请重新生成。
            </p>
          </div>
        )}

        {state.status === "bound" && (
          <div className="px-6 pt-3 max-[600px]:px-[18px]">
            <p className="text-sm font-bold text-[#204f3d]">已绑定飞书单聊</p>
            <p className="mt-1 text-sm text-[#657068]">单聊：你 ↔ Westie 助手</p>
            {state.createdAt !== undefined && (
              <p className="mt-1 text-[11px] text-[#8a938d]">
                绑定时间：{formatDate(state.createdAt)}
              </p>
            )}
          </div>
        )}

        <DialogFooter
          note={
            state.status === "bound"
              ? "解绑后本单聊不再驱动该会话，会话历史保留。"
              : undefined
          }
        >
          {state.status === "unbound" && !state.expired && (
            <>
              <button
                type="button"
                className={secondaryButtonClasses}
                disabled={submitting}
                onClick={onClose}
              >
                关闭
              </button>
              <button
                type="button"
                className={smallButtonClasses}
                disabled={submitting}
                onClick={() => void lark.issue()}
              >
                {state.code !== undefined ? "重新生成（旧码立即失效）" : "生成绑定码"}
              </button>
            </>
          )}
          {state.status === "bound" && (
            <>
              <button
                type="button"
                className={secondaryButtonClasses}
                disabled={submitting}
                onClick={onClose}
              >
                关闭
              </button>
              <button
                type="button"
                className={dangerButtonClasses}
                disabled={submitting}
                onClick={() => void lark.unbind()}
              >
                {submitting ? "正在解除…" : "解除绑定"}
              </button>
            </>
          )}
          {state.status === "unbound" && state.expired && (
            <button
              type="button"
              className={primaryButtonClasses}
              onClick={() => void lark.issue()}
            >
              重新生成绑定码
            </button>
          )}
          {state.status === "unavailable" && (
            <button
              type="button"
              className={secondaryButtonClasses}
              onClick={onClose}
            >
              关闭
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatRemaining(expiresAt: string): string {
  const remaining = new Date(expiresAt).valueOf() - Date.now();
  if (remaining <= 0) return "已过期";
  const minutes = Math.ceil(remaining / 60_000);
  return minutes === 1 ? "约 1 分钟内有效" : `${minutes} 分钟内有效`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}