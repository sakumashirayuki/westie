/** 子 Run 的步数上限；到达时走现有的交接步，交接说明成为 answer。 */
export const SUB_AGENT_MAX_STEPS = 128;

export const STOP_AGENT_REASON_MAX_BYTES = 1024;

/** stop_agent 的停止原因上限按 UTF-8 字节计，与一条转向消息同口径。 */
export function assertStopAgentReason(reason: string): string {
  if (reason.trim() === "") {
    throw new Error("A stop reason must not be empty.");
  }
  if (Buffer.byteLength(reason, "utf8") > STOP_AGENT_REASON_MAX_BYTES) {
    throw new Error("A stop reason must not exceed 1 KiB.");
  }
  return reason;
}
