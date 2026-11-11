import type { SteeringTrace } from "../run-state";

/**
 * Turn 层级的插话列表。受理后立即以排队态出现，steering.applied 到达后
 * 换成生效步号，因此从点击到生效之间页面始终有反馈。
 */
export function SteeringMessages({
  messages,
}: {
  messages: SteeringTrace[];
}) {
  if (messages.length === 0) return null;
  return (
    <ul className="mt-3 list-none space-y-2 border-t border-[rgba(20,32,27,0.09)] p-0 pt-3">
      {messages.map((message) => (
        <li key={message.seq}>
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] font-bold text-[#5f7690]">插话</span>
            <small className="text-[#858c87]">{statusLabel(message)}</small>
          </div>
          <p className="mt-1 leading-[1.65] whitespace-pre-wrap text-[#33475c]">
            {message.content}
          </p>
        </li>
      ))}
    </ul>
  );
}

function statusLabel(message: SteeringTrace): string {
  if (message.status === "queued") return "已送达，将在下一步生效";
  // 历史会话不恢复步号，只能确认它已经生效。
  return message.step === undefined ? "已生效" : `已在 STEP ${message.step} 生效`;
}
