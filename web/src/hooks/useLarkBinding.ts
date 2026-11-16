import { useCallback, useEffect, useRef, useState } from "react";

import {
  getLarkBinding,
  getLarkCapability,
  issueLarkBindingCode,
  unbindLarkChat,
  type ConversationSummary,
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
  /** 桥接是否配置了凭证；挂载时探测一次，决定行菜单入口与弹窗是否渲染。 */
  readonly capabilityEnabled: boolean;
  /** 当前绑定弹窗的目标会话；null 表示弹窗关闭。 */
  readonly target: ConversationSummary | null;
  readonly state: LarkBindingState;
  /** 打开弹窗：记录目标会话并读取该会话的绑定状态，不自动签发绑定码。 */
  readonly open: (conversation: ConversationSummary) => void;
  readonly close: () => void;
  readonly issue: () => Promise<void>;
  readonly unbind: () => Promise<void>;
}

/**
 * 飞书绑定弹窗的唯一编排者：持有目标会话、能力开关与三态（未绑定 / 已绑定 /
 * 码已过期）状态机。
 *
 * - 能力探测只在挂载时发一次；打开弹窗只请求该会话的绑定状态，不重复探测能力。
 * - `open` 只读不签发；「重新生成 / 签发」才调用 POST 签发新码并作废旧码。
 * - 入口渲染由 `capabilityEnabled` 控制，桥接未配置时弹窗不会挂载。
 */
export function useLarkBinding(): UseLarkBindingResult {
  const [capabilityEnabled, setCapabilityEnabled] = useState(false);
  const [target, setTarget] = useState<ConversationSummary | null>(null);
  const [openState, setOpenState] = useState<LarkBindingState>({
    status: "loading",
  });
  const activeId = useRef<string | undefined>(undefined);

  // 进入页面时读取一次飞书能力，决定行菜单是否显示「绑定飞书单聊」入口。
  // 放在 useEffect 中，避免重渲染重复请求；卸载后不再落地状态。
  useEffect(() => {
    let cancelled = false;
    getLarkCapability().then(
      (capability) => {
        if (!cancelled) setCapabilityEnabled(capability.enabled);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // 打开弹窗时查询目标会话的绑定状态。
  const open = useCallback((conversation: ConversationSummary) => {
    activeId.current = conversation.id;
    setTarget(conversation);
    setOpenState({ status: "loading" });
    void (async () => {
      try {
        const binding = await getLarkBinding(conversation.id);
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
    setTarget(null);
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

  return {
    capabilityEnabled,
    target,
    state: openState,
    open,
    close,
    issue,
    unbind,
  };
}
