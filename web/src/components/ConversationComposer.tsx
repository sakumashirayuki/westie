import type { RunStatus } from "../run-state";
import { statusLabels, surfaceClasses } from "./view-styles";

const statusDotClasses: Record<RunStatus, string> = {
  idle: "bg-[#a4aaa6]",
  running:
    "animate-pulse bg-[#d88e25] shadow-[0_0_0_5px_rgba(216,142,37,0.12)] motion-reduce:animate-none",
  stopping: "animate-pulse bg-[#d88e25] motion-reduce:animate-none",
  completed: "bg-[#27835f]",
  error: "bg-[#b7473d]",
  cancelled: "bg-[#a4aaa6]",
};

export function ConversationComposer({
  input,
  status,
  hasConversation,
  hasTurns,
  projectSelecting,
  canSteer,
  hasPendingInteraction,
  onInputChange,
  onSubmit,
  onSteer,
  onStop,
  isStopping,
}: {
  input: string;
  status: RunStatus;
  hasConversation: boolean;
  hasTurns: boolean;
  projectSelecting: boolean;
  canSteer: boolean;
  hasPendingInteraction: boolean;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onSteer: () => void;
  onStop: () => void;
  isStopping?: boolean;
}) {
  const running = status === "running" && isStopping !== true;
  const stopping = isStopping === true;
  return (
    <form
      className={`${surfaceClasses} rounded-[18px] p-2.5 max-[600px]:rounded-[14px]`}
      onSubmit={(event) => {
        event.preventDefault();
        if (running) onSteer();
        else onSubmit();
      }}
    >
      <label className="sr-only" htmlFor="task">
        {hasTurns ? "继续对话" : "开始对话"}
      </label>
      <textarea
        className="mb-2 block w-full resize-none rounded-xl border border-[#d9dbd3] bg-[#fcfcf9] px-3.5 py-2 leading-[1.5] text-[#14201b] outline-none focus:border-[#3f896e] focus:shadow-[0_0_0_3px_rgba(63,137,110,0.12)] disabled:bg-[#f4f4f0] disabled:text-[#69736d]"
        id="task"
        value={input}
        onChange={(event) => onInputChange(event.target.value)}
        placeholder={running
          ? "运行中可以插话，会在下一步生效"
          : "例如：继续分析刚才提到的第二个模块"}
        rows={2}
        disabled={!hasConversation || projectSelecting}
      />
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-[13px] text-[#69736d]">
          <span
            className={`size-2 rounded-full ${statusDotClasses[status]}`}
            aria-hidden="true"
          />
          {statusLabels[status]}
        </span>
        {running || stopping ? (
          <span className="flex items-center gap-2">
            {hasPendingInteraction && !stopping && (
              <span className="text-xs text-[#a5650d]">
                将在当前确认处理后生效
              </span>
            )}
            <button
              type="submit"
              className="min-w-[80px] cursor-pointer rounded-full bg-[#176b4d] px-4 py-1.5 font-bold text-white hover:bg-[#0d593d] disabled:cursor-not-allowed disabled:opacity-45"
              disabled={
                stopping || !canSteer || !input.trim() || projectSelecting
              }
            >
              插话
            </button>
            <button
              type="button"
              className="min-w-[80px] cursor-pointer rounded-full border border-[#d4d7d0] bg-[#f7f7f3] px-4 py-1.5 font-bold text-[#3c4741] hover:bg-[#edede8]"
              onClick={onStop}
              disabled={stopping}
            >
              {stopping ? "正在停止…" : "停止"}
            </button>
          </span>
        ) : (
          <button
            type="submit"
            className="min-w-[80px] cursor-pointer rounded-full bg-[#176b4d] px-4 py-1.5 font-bold text-white hover:bg-[#0d593d] disabled:cursor-not-allowed disabled:opacity-45"
            disabled={!hasConversation || projectSelecting || !input.trim()}
          >
            发送
          </button>
        )}
      </div>
    </form>
  );
}
