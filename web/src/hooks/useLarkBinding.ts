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

export interface UseLarkBindingOptions {
  /**
   * 绑定关系发生确定变化时回调：轮询发现绑定成功给 true，解绑成功给 false。
   * 仅在变化发生的瞬间触发一次，用于让会话列表即时同步「飞书已绑定」徽标，
   * 免去整列表刷新；打开弹窗读到的既有状态不算变化，不会触发。
   */
  readonly onBindingChange?: (conversationId: string, bound: boolean) => void;
}

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
 * 绑定码签发后的轮询周期：用户在飞书侧发码后最迟约 3 秒在弹窗内看到已绑定，
 * 绑定码 10 分钟有效，周期内请求量保持在两百次以内。
 */
const BINDING_POLL_INTERVAL_MS = 3000;

/**
 * 飞书绑定弹窗的唯一编排者：持有目标会话、能力开关与三态（未绑定 / 已绑定 /
 * 码已过期）状态机。
 *
 * - 能力探测只在挂载时发一次；打开弹窗只请求该会话的绑定状态，不重复探测能力。
 * - `open` 只读不签发；「重新生成 / 签发」才调用 POST 签发新码并作废旧码。
 * - 入口渲染由 `capabilityEnabled` 控制，桥接未配置时弹窗不会挂载。
 * - 每次打开 / 关闭弹窗递增世代号，所有异步回调落地前校验世代，防止 A 弹窗的
 *   迟到响应覆盖 B 弹窗（连续切换目标会话的竞态）。
 * - 签发绑定码后定时轮询绑定状态，发现绑定成功自动切态并通知外部同步列表徽标。
 */
export function useLarkBinding(
  options: UseLarkBindingOptions = {},
): UseLarkBindingResult {
  const [capabilityEnabled, setCapabilityEnabled] = useState(false);
  const [target, setTarget] = useState<ConversationSummary | null>(null);
  const [openState, setOpenState] = useState<LarkBindingState>({
    status: "loading",
  });
  const activeId = useRef<string | undefined>(undefined);
  /** 世代号：打开 / 关闭弹窗时递增；异步回调只处理与当前世代一致的响应。 */
  const generationRef = useRef(0);
  /** 回调放进 ref，外部内联函数变化不会触发轮询 effect 重跑。 */
  const optionsRef = useRef(options);
  optionsRef.current = options;

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
    const generation = ++generationRef.current;
    activeId.current = conversation.id;
    setTarget(conversation);
    setOpenState({ status: "loading" });
    void (async () => {
      try {
        const binding = await getLarkBinding(conversation.id);
        if (generationRef.current !== generation) return;
        setOpenState(
          binding.bound
            ? { status: "bound", createdAt: binding.createdAt }
            : { status: "unbound", expired: false },
        );
      } catch (error) {
        if (generationRef.current !== generation) return;
        setOpenState({
          status: "unavailable",
          error: error instanceof Error ? error.message : "读取绑定状态失败。",
        });
      }
    })();
  }, []);

  const close = useCallback(() => {
    generationRef.current += 1;
    activeId.current = undefined;
    setTarget(null);
    setOpenState({ status: "loading" });
  }, []);

  const issue = useCallback(async () => {
    const id = activeId.current;
    if (id === undefined) return;
    const generation = generationRef.current;
    setOpenState({ status: "submitting" });
    try {
      const code = await issueLarkBindingCode(id);
      if (generationRef.current !== generation) return;
      setOpenState({ status: "unbound", code, expired: false });
    } catch (error) {
      if (generationRef.current !== generation) return;
      setOpenState({
        status: "unavailable",
        error: error instanceof Error ? error.message : "签发绑定码失败。",
      });
    }
  }, []);

  const unbind = useCallback(async () => {
    const id = activeId.current;
    if (id === undefined) return;
    const generation = generationRef.current;
    setOpenState({ status: "submitting" });
    try {
      await unbindLarkChat(id);
      if (generationRef.current !== generation) return;
      setOpenState({ status: "unbound", expired: false });
      optionsRef.current.onBindingChange?.(id, false);
    } catch (error) {
      if (generationRef.current !== generation) return;
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

  // 签发绑定码后轮询绑定状态：用户在飞书侧发码后弹窗自动切到已绑定。
  // 弹窗关闭 / 重开 / 码过期 / 进入已绑定态都会经由 openState 变化清理本定时器。
  useEffect(() => {
    if (
      openState.status !== "unbound" ||
      openState.expired ||
      openState.code === undefined
    ) {
      return;
    }
    const id = activeId.current;
    if (id === undefined) return;
    const generation = generationRef.current;
    const timer = setInterval(() => {
      void getLarkBinding(id).then(
        (binding) => {
          if (generationRef.current !== generation || !binding.bound) return;
          setOpenState({ status: "bound", createdAt: binding.createdAt });
          optionsRef.current.onBindingChange?.(id, true);
        },
        () => {
          // 单次轮询失败保持静默，下个周期继续；世代失效后定时器会被 effect 清理。
        },
      );
    }, BINDING_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
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
