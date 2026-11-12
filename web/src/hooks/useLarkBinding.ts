import { useCallback, useEffect, useRef, useState } from "react";

import {
  getLarkBinding,
  getLarkCapability,
  issueLarkBindingCode,
  unbindLarkChat,
  type IssuedLarkBindingCode,
} from "../run-client";

export type LarkBindingState =
  | { status: "loading" }
  | { status: "unavailable"; error: string }
  | {
      status: "unbound";
      code?: IssuedLarkBindingCode;
      /** 本地判断码已过期（超过 expiresAt）。 */
      expired: boolean;
    }
  | { status: "bound"; createdAt?: string }
  | { status: "submitting" };

export interface UseLarkBindingResult {
  readonly capabilityEnabled: boolean;
  readonly state: LarkBindingState;
  /** 打开弹窗时读取能力与绑定状态；不自动签发绑定码。 */
  readonly open: (conversationId: string) => void;
  readonly close: () => void;
  readonly issue: () => Promise<void>;
  readonly unbind: () => Promise<void>;
}

/**
 * 管理飞书绑定弹窗的三态（未绑定 / 已绑定 / 码已过期）与请求错误。
 *
 * - 打开弹窗时以 GET 接口读取实际绑定状态；绑定码到期后本地切到过期态。
 * - `open` 只读不签发；「重新生成 / 签发」才调用 POST 签发新码并作废旧码。
 */
export function useLarkBinding(conversationId?: string): UseLarkBindingResult {
  const [capabilityEnabled, setCapabilityEnabled] = useState(false);
  const [openState, setOpenState] = useState<LarkBindingState>({
    status: "loading",
  });
  const activeId = useRef<string | undefined>(undefined);

  // 打开弹窗时一次性查询能力与绑定状态。
  const open = useCallback((conversationId: string) => {
    activeId.current = conversationId;
    setOpenState({ status: "loading" });
    void (async () => {
      try {
        const [capability, binding] = await Promise.all([
          getLarkCapability(),
          getLarkBinding(conversationId),
        ]);
        setCapabilityEnabled(capability.enabled);
        if (!capability.enabled) {
          setOpenState({ status: "unavailable", error: "飞书桥接未配置。" });
          return;
        }
        setOpenState(
          binding.bound
            ? { status: "bound", createdAt: binding.createdAt }
            : { status: "unbound", expired: false },
        );
      } catch (error) {
        setOpenState({
          status: "unavailable",
          error: error instanceof Error ? error.message : "读取绑定状态失败。",
        });
      }
    })();
  }, []);

  const close = useCallback(() => {
    activeId.current = undefined;
    setOpenState({ status: "loading" });
  }, []);

  const issue = useCallback(async () => {
    const id = activeId.current;
    if (id === undefined) return;
    setOpenState({ status: "submitting" });
    try {
      const code = await issueLarkBindingCode(id);
      setOpenState({ status: "unbound", code, expired: false });
    } catch (error) {
      setOpenState({
        status: "unavailable",
        error: error instanceof Error ? error.message : "签发绑定码失败。",
      });
    }
  }, []);

  const unbind = useCallback(async () => {
    const id = activeId.current;
    if (id === undefined) return;
    setOpenState({ status: "submitting" });
    try {
      await unbindLarkChat(id);
      setOpenState({ status: "unbound", expired: false });
    } catch (error) {
      setOpenState({
        status: "unavailable",
        error: error instanceof Error ? error.message : "解除绑定失败。",
      });
    }
  }, []);

  // 绑定码到期后本地切到过期态。
  useEffect(() => {
    const state = openState;
    if (state.status !== "unbound" || state.expired || state.code === undefined) {
      return;
    }
    const expiresAt = new Date(state.code.expiresAt).valueOf();
    const delay = Math.max(0, expiresAt - Date.now());
    const timer = setTimeout(() => {
      setOpenState((current) =>
        current.status === "unbound" && current.code !== undefined
          ? { status: "unbound", expired: true }
          : current,
      );
    }, delay);
    return () => clearTimeout(timer);
  }, [openState]);

  return { capabilityEnabled, state: openState, open, close, issue, unbind };
}