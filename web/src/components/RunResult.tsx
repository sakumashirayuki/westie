import { code } from "@streamdown/code";
import { Streamdown } from "streamdown";

import type { RunMemoryStatus } from "../events";
import type { AnswerKind, AnswerStatus, RunState } from "../run-state";
import { RetryNotice } from "./RetryNotice";
import { UsageSummary } from "./UsageSummary";

const answerStatusClasses: Record<Exclude<AnswerStatus, "idle">, string> = {
  streaming: "text-[#a5650d]",
  completed: "text-[#28795b]",
  interrupted: "text-[#a9362e]",
};

const markdownControls = {
  code: { copy: true, download: false },
  table: false,
  mermaid: false,
} as const;

const markdownPlugins = { code };

const markdownTranslations = {
  copied: "已复制",
  copyCode: "复制代码",
};

export function RunResult({ run }: { run: RunState }) {
  if (run.error !== undefined) {
    return (
      <div
        className="rounded-xl border border-[rgba(183,71,61,0.28)] bg-[#fff7f4] p-4"
        role="alert"
      >
        <strong className="text-[#962f27]">
          {errorTitle(run.error.kind)}
        </strong>
        <p className="my-2 text-[#70443f]">{run.error.message}</p>
        {run.error.code === "MODEL_UNAVAILABLE" && (
          <p className="my-2 text-[#70443f]">
            模型服务暂时不可用，自动重试已用尽。稍后重新发送即可。
          </p>
        )}
        {run.error.code && (
          <code className="text-xs text-[#962f27]">{run.error.code}</code>
        )}
      </div>
    );
  }

  const memoryNotice = memoryNeedsNotice(run.memory);
  const outputKind = run.answerKind === "tool" ? "tool" : "agent";
  const retry = run.status === "running" ? run.steps.at(-1)?.retry : undefined;

  return (
    <div
      key={outputKind}
      className="agent-output-transition"
      data-output-kind={outputKind}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold">{answerTitle(run.answerKind)}</h2>
        {run.answerStatus !== "idle" && (
          <span
            className={`font-mono text-xs ${
              run.answerKind === "tool"
                ? "text-[#a5650d]"
                : answerStatusClasses[run.answerStatus]
            }`}
          >
            {answerStatusLabel(run.answerStatus, run.answerKind)}
          </span>
        )}
      </div>
      <div className="mt-3 min-w-0 leading-[1.72]">
        {run.answer ? (
          <Streamdown
            className="agent-markdown"
            controls={markdownControls}
            disallowedElements={["img"]}
            lineNumbers
            mode={run.answerStatus === "streaming" ? "streaming" : "static"}
            plugins={markdownPlugins}
            skipHtml
            translations={markdownTranslations}
          >
            {run.answer}
          </Streamdown>
        ) : (
          <span className="text-[#7a827d]">
            {run.status === "running" ? "正在思考…" : "Agent 未返回回答。"}
          </span>
        )}
        {retry !== undefined && <RetryNotice retry={retry} />}
        {memoryNotice === undefined ? null : <MemoryNotice memory={memoryNotice} />}
        {run.stopReason === "step_limit" && (
          <p className="mt-3 rounded-[9px] border border-[#e7c98d] bg-[#fff9eb] px-[13px] py-2.5 text-xs leading-[1.5] text-[#79581a]">
            步数已用尽，交接内容未经过完成检查。
          </p>
        )}
        {run.answerStatus === "streaming" && (
          <span
            className="ml-[3px] inline-block h-[1em] w-0.5 animate-pulse bg-[#28795b] align-[-0.12em] motion-reduce:animate-none"
            aria-hidden="true"
          />
        )}
      </div>
      {run.usage !== undefined && (
        <UsageSummary
          usage={run.usage}
          scope="run"
          className="mt-3 border-t border-[rgba(40,121,91,0.16)] pt-3"
        />
      )}
    </div>
  );
}

function memoryNeedsNotice(
  memory: RunMemoryStatus | undefined,
): Exclude<RunMemoryStatus, { status: "ready" }> | undefined {
  if (memory === undefined || memory.status === "ready") return undefined;
  return memory;
}

function MemoryNotice({
  memory,
}: {
  memory: Exclude<RunMemoryStatus, { status: "ready" }>;
}) {
  return (
    <p className="mt-3 rounded-[9px] border border-[#e7c98d] bg-[#fff9eb] px-[13px] py-2.5 text-xs leading-[1.5] text-[#79581a]">
      {memory.status === "truncated"
        ? `项目记忆索引超出加载上限，本轮只加载了部分内容；其余内容从第 ${memory.nextLine} 行起保存在 MEMORY.md 中，可要求 Agent 继续读取。`
        : `本轮未能加载项目记忆（${memoryUnavailableLabel(memory.reason)}），会话可以继续，但本次不会使用或写入项目记忆。`}
    </p>
  );
}

function memoryUnavailableLabel(
  reason: Extract<RunMemoryStatus, { status: "unavailable" }>["reason"],
) {
  if (reason === "identity") return "项目归属无法确定";
  if (reason === "encoding") return "记忆文件编码无效";
  return "记忆文件读取失败";
}

function errorTitle(kind: "http" | "run" | "transport") {
  if (kind === "http") return "请求被服务端拒绝";
  if (kind === "run") return "Agent 运行失败";
  return "连接异常";
}

function answerStatusLabel(
  status: Exclude<AnswerStatus, "idle">,
  kind: AnswerKind | null,
) {
  if (kind === "tool") return "调用工具";
  if (status === "streaming") return "生成中";
  if (status === "completed") return "已完成校验";
  return "未完成校验";
}

function answerTitle(kind: AnswerKind | null) {
  if (kind === "tool") return "工具调用说明";
  if (kind === "final") return "最终回答";
  return "Agent 输出";
}
