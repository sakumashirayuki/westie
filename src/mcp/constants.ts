// MCP 协议子集的共享常量：版本协商、超时与各类上限。client、transport、
// server-pool 与工具适配都从这里取值，避免各处散落魔法数。

/**
 * 支持的协议版本，按优先级降序。握手时客户端用第一个版本发起 initialize，
 * Server 回应的 protocolVersion 必须在这个列表里，否则判失败。
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

/** initialize 握手与 tools/list 首次响应的超时。 */
export const MCP_INITIALIZE_TIMEOUT_MS = 10_000;

/** 单次 tools/call 的默认超时。 */
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000;

/** 单次 tools/call 允许的最大超时。 */
export const MAX_MCP_CALL_TIMEOUT_MS = 600_000;

/** 单条 JSON-RPC 消息上限；超过判定连接损坏。 */
export const MAX_MCP_MESSAGE_BYTES = 4 * 1024 * 1024;

/** 单 Server 最多暴露的工具数。 */
export const MAX_MCP_TOOLS_PER_SERVER = 128;

/** 全部 Server 合计最多暴露的工具数。 */
export const MAX_MCP_TOOLS_TOTAL = 256;

/** 工具 description 上限（截断）。 */
export const MAX_MCP_TOOL_DESCRIPTION_BYTES = 2 * 1024;

/** 工具 inputSchema 上限（跳过并诊断）。 */
export const MAX_MCP_TOOL_SCHEMA_BYTES = 16 * 1024;

/** 文本内容块合计上限（截断）。 */
export const MAX_MCP_TEXT_BYTES = 48 * 1024;

/** 子进程 stderr 只保留的最后字节数，供诊断。 */
export const MAX_MCP_STDERR_BYTES = 8 * 1024;
