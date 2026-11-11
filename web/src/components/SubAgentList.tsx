import {
  subAgentDescription,
  type ConversationTurnState,
} from "../conversation-state";
import { statusLabels } from "./view-styles";

/**
 * 历史会话里子 Run 的入口。步骤轨迹刷新后不恢复，agent 卡片随之消失，这里把恢复
 * 出来的子 Run 列成一行可点的条目，点开抽屉看回答与用量。
 */
export function SubAgentList({
  turn,
  onOpen,
  onStop,
}: {
  turn: ConversationTurnState;
  onOpen?: (toolCallId: string) => void;
  onStop?: (toolCallId: string) => void;
}) {
  const represented = new Set(
    turn.run.steps.flatMap((step) => step.tools.filter((tool) => tool.subAgent !== undefined).map((tool) => tool.id)),
  );
  const entries = Object.entries(turn.subAgentRuns).filter(([toolCallId]) => !represented.has(toolCallId));
  if (entries.length === 0) return null;
  return (
    <section
      className="mt-5 border-t border-[#e0e2dd] pt-4"
      aria-label="子 Run"
    >
      <p className="text-sm font-bold text-[#536159]">
        子 Run · {entries.length}
      </p>
      <ul className="mt-2.5 flex flex-wrap gap-2 p-0">
        {entries.map(([toolCallId, run]) => {
          const label = [
            subAgentDescription(turn, toolCallId),
            statusLabels[run.status],
            ...(run.usage === undefined
              ? []
              : [`${run.usage.inputTokens + run.usage.outputTokens} tokens`]),
          ].join(" · ");
          return (
            <li key={toolCallId} className="list-none">
              {onOpen === undefined ? (
                <span className="inline-block rounded-[9px] border border-[#e0e2dd] bg-[#fafaf7] px-3 py-1.5 text-xs text-[#405048]">
                  {label}
                </span>
              ) : (
                <button
                  type="button"
                  className="rounded-[9px] border border-[#d8dbd4] bg-[#fafaf7] px-3 py-1.5 text-xs text-[#276c53] hover:bg-[#eff0eb]"
                  onClick={() => onOpen(toolCallId)}
                >
                  {label} · 查看
                </button>
              )}
              {onStop !== undefined && (run.status === "running" || run.status === "stopping") && (
                <button type="button" className="ml-1 rounded-[9px] border border-[#e1b9b4] px-2 py-1.5 text-xs text-[#a33d35] disabled:opacity-50" disabled={run.status === "stopping"} onClick={() => onStop(toolCallId)}>
                  {run.status === "stopping" ? "正在停止…" : "停止"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
