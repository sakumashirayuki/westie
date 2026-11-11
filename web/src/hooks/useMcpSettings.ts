import { useEffect, useReducer } from "react";

import {
  firstInvalidId,
  initialMcpSettingsState,
  mcpSettingsReducer,
  toSaveRequest,
  toServerConfig,
  type McpServerDraft,
} from "../mcp-settings-state";
import {
  getMcpConfig,
  HttpRunError,
  probeMcpServer,
  saveMcpConfig,
} from "../run-client";

/** 「已保存」提示的停留时间。 */
export const SAVED_NOTICE_MS = 2_000;

/** MCP 设置弹窗的状态与它的四个网络动作：读取、重试、测试连接、保存。 */
export function useMcpSettings() {
  const [state, dispatch] = useReducer(
    mcpSettingsReducer,
    initialMcpSettingsState,
  );

  // 依赖保存时刻而不是一个布尔值：连续保存时刻不同，计时器会重置。
  const savedAt = state.status === "ready" ? state.savedAt : undefined;
  useEffect(() => {
    if (savedAt === undefined) return;
    const timer = window.setTimeout(
      () => dispatch({ type: "notice_expired", at: savedAt }),
      SAVED_NOTICE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [savedAt]);

  async function load(): Promise<void> {
    try {
      const view = await getMcpConfig();
      // 管理接口读取不展开 ${VAR}，这里只会看到结构性错误。此时某些 Server 已从列表
      // 里消失，照常展示再保存会把它们删掉，所以按读取失败处理。
      const broken = view.diagnostics.find((d) => d.code === "INVALID_MCP_CONFIG");
      if (broken !== undefined) {
        dispatch({
          type: "load_failed",
          error: broken.server === undefined
            ? broken.message
            : `服务器 ${broken.server}：${broken.message}`,
        });
        return;
      }
      dispatch({ type: "loaded", servers: view.servers });
    } catch (error) {
      dispatch({
        type: "load_failed",
        error: error instanceof Error ? error.message : "读取配置失败。",
      });
    }
  }

  /** 打开弹窗；读取失败后的重试同样调它。 */
  function open(): void {
    if (state.status !== "closed" && state.status !== "load_error") return;
    dispatch({ type: "open" });
    void load();
  }

  async function probe(draft: McpServerDraft): Promise<void> {
    dispatch({ type: "probe_started", id: draft.id });
    try {
      const result = await probeMcpServer(draft.name.trim(), toServerConfig(draft));
      dispatch({
        type: "probe_finished",
        id: draft.id,
        result: result.ok
          ? { status: "ok", toolCount: result.tools.length }
          : { status: "failed", message: result.message },
      });
    } catch (error) {
      dispatch({
        type: "probe_finished",
        id: draft.id,
        result: {
          status: "failed",
          message: error instanceof Error ? error.message : "测试连接失败。",
        },
      });
    }
  }

  async function save(): Promise<void> {
    if (state.status !== "ready" || state.saving) return;
    const invalid = firstInvalidId(state.drafts);
    if (invalid !== undefined) {
      dispatch({ type: "select", id: invalid });
      return;
    }
    dispatch({ type: "save_started" });
    try {
      const view = await saveMcpConfig(toSaveRequest(state.drafts));
      dispatch({ type: "save_succeeded", servers: view.servers, at: Date.now() });
    } catch (error) {
      dispatch({ type: "save_failed", error: saveErrorMessage(error) });
    }
  }

  return { state, dispatch, open, probe, save };
}

function saveErrorMessage(error: unknown): string {
  if (
    error instanceof HttpRunError &&
    error.code === "MCP_CONFIG_REQUIRES_LOOPBACK"
  ) {
    return "服务没有绑定在本机回环地址上，只能查看和测试连接，不能保存。";
  }
  return error instanceof Error ? error.message : "保存失败，请重试。";
}
