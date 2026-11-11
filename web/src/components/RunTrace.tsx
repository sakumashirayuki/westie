import { useEffect, useState } from "react";

import type { JsonValue } from "../events";
import type {
  InteractionRequestMap,
  InteractionResponder,
  WorkspaceGrantSelector,
} from "../interaction-ui";
import { describeSubAgent } from "../pending-interactions";
import type { StepTrace, ToolTrace } from "../run-state";
import { statusLabels } from "./view-styles";
import { RetryNotice } from "./RetryNotice";
import { parseTodoOutput, TodoList } from "./TodoList";
import { ToolApprovalCard } from "./ToolApprovalCard";
import { WorkspaceGrantCard } from "./WorkspaceGrantCard";

const STOP_HOOK_TOOL_NAME = "stop_hook";

const toolStatusClasses: Record<ToolTrace["status"], string> = {
  approval_required: "text-[#a5650d]",
  running: "text-[#a5650d]",
  success: "text-[#28795b]",
  error: "text-[#a9362e]",
};

export function RunTrace({
  steps,
  canRespond,
  interactionRequests,
  onRespond,
  onSelectFile,
  onOpenSubAgent,
  onStopSubAgent,
}: {
  steps: StepTrace[];
  canRespond: boolean;
  interactionRequests: InteractionRequestMap;
  onRespond: InteractionResponder;
  onSelectFile: WorkspaceGrantSelector;
  /** 点击 agent 卡片时打开子 Run 抽屉；缺省时卡片不可点。 */
  onOpenSubAgent?: (toolCallId: string) => void;
  onStopSubAgent?: (toolCallId: string) => void;
}) {
  const hasPendingInteraction = steps.some(
    (step) =>
      step.workspaceGrants.some((grant) => grant.status === "pending") ||
      step.tools.some((tool) => tool.approval?.status === "pending"),
  );
  const [isOpen, setIsOpen] = useState(hasPendingInteraction);

  useEffect(() => {
    if (hasPendingInteraction) setIsOpen(true);
  }, [hasPendingInteraction]);

  return (
    <details
      className="mt-5 border-t border-[#e0e2dd] pt-4"
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-bold text-[#536159]">
        运行过程 · {steps.length} steps
      </summary>
      <ol className="mt-[18px] list-none p-0">
        {steps.map((step) => (
          <li
            className="relative ml-[7px] border-l border-[#d8dbd4] pb-[26px] pl-[30px] before:absolute before:top-[3px] before:-left-[5px] before:size-[9px] before:rounded-full before:border-2 before:border-white before:bg-[#318064] before:shadow-[0_0_0_1px_#318064] last:border-l-transparent last:pb-0"
            key={step.number}
          >
            <div className="flex items-center gap-3">
              <span className="font-mono text-xs font-bold tracking-[0.08em] text-[#276c53]">
                STEP {step.number}
              </span>
              <small className="text-[#858c87]">
                {stepLabel(step)}
              </small>
            </div>
            {step.retry !== undefined && <RetryNotice retry={step.retry} />}
            {step.actionType === "tool" && step.assistantText.trim() !== "" && (
              <div className="mt-2.5 rounded-[10px] border border-[#e0e2dd] bg-[#fafaf7] px-[13px] py-[11px]">
                <span className="text-[11px] text-[#7b847e]">模型说明</span>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-[1.6] text-[#405048]">
                  {step.assistantText}
                </p>
              </div>
            )}
            {step.workspaceGrants.map((grant) =>
              grant.status === "pending" ? (
                <PendingElsewhereNote
                  key={grant.interactionId}
                  label="文件读取授权"
                />
              ) : (
                <WorkspaceGrantCard
                  key={grant.interactionId}
                  grant={grant}
                  canRespond={canRespond}
                  request={interactionRequests[grant.interactionId]}
                  onRespond={onRespond}
                  onSelectFile={onSelectFile}
                />
              )
            )}
            {step.tools.map((tool) => (
              <details
                className="mt-2.5 overflow-hidden rounded-[10px] border border-[#e0e2dd] bg-[#fafaf7]"
                key={tool.id}
                open={
                  tool.status === "approval_required" ||
                  tool.status === "running"
                }
              >
                <summary className="flex cursor-pointer items-center gap-2.5 px-[13px] py-[11px]">
                  <code className="font-bold text-[#273c34]">
                    {tool.name}
                  </code>
                  {tool.name === "agent" && (
                    <span className="truncate text-sm text-[#405048]">
                      {describeSubAgent(steps, tool.id)}
                    </span>
                  )}
                  {tool.name === "web_fetch" && (
                    <span className="truncate text-sm text-[#405048]">
                      {toolFetchSummary(tool)}
                    </span>
                  )}
                  {tool.name === "glob" && (
                    <span className="truncate text-sm text-[#405048]">
                      {toolGlobSummary(tool)}
                    </span>
                  )}
                  {tool.name.startsWith("mcp__") && (
                    <span className="truncate text-sm text-[#405048]">
                      {toolMcpSummary(tool)}
                    </span>
                  )}
                  {tool.name === STOP_HOOK_TOOL_NAME && (
                    <span className="truncate text-sm text-[#405048]">
                      {stopHookSummary(tool)}
                    </span>
                  )}
                  <span className="mr-auto" />
                  {tool.subAgent !== undefined && (
                    <SubAgentBadge
                      summary={tool.subAgent}
                      onOpen={
                        onOpenSubAgent === undefined
                          ? undefined
                          : () => onOpenSubAgent(tool.id)
                      }
                      onStop={onStopSubAgent === undefined ? undefined : () => onStopSubAgent(tool.id)}
                    />
                  )}
                  <span className={`text-xs ${toolStatusClasses[tool.status]}`}>
                    {toolStatus(tool.status, tool.error)}
                  </span>
                  {tool.durationMs !== undefined && (
                    <small className="text-[#8b928d]">
                      {tool.durationMs} ms
                    </small>
                  )}
                </summary>
                {tool.approval &&
                  (tool.approval.status === "pending" ? (
                    <PendingElsewhereNote label="工具确认" />
                  ) : (
                    <ToolApprovalCard
                      tool={tool}
                      canRespond={canRespond}
                      request={interactionRequests[tool.approval.interactionId]}
                      onRespond={onRespond}
                    />
                  ))}
                {renderToolResult(tool)}
              </details>
            ))}
          </li>
        ))}
      </ol>
    </details>
  );
}

function renderToolResult(tool: ToolTrace) {
  if (tool.name === "todo") return <TodoResultBlock tool={tool} />;
  if (tool.name === STOP_HOOK_TOOL_NAME) return <StopHookResultBlock tool={tool} />;
  if (tool.name.startsWith("mcp__")) return <McpResultBlock tool={tool} />;
  return (
    <>
      <DataBlock label="参数" value={tool.arguments} />
      {tool.result !== undefined && (
        <DataBlock label="结果" value={tool.result} />
      )}
      {tool.error && <DataBlock label="错误" value={tool.error} />}
    </>
  );
}

/**
 * 步骤说明。被完成检查否决的步骤等待下一步补做；检查放行的步骤紧接最终回答，
 * 与普通“思考中”区分开。
 */
function stepLabel(step: StepTrace): string {
  if (step.actionType === "final") return "生成回答";
  if (step.actionType === "tool") return "调用工具";
  const checks = step.tools.filter((tool) => tool.name === STOP_HOOK_TOOL_NAME);
  if (checks.length === 0) return "思考中";
  // 先按工具状态区分失败；没有结果的成功检查不等于放行。
  if (checks.some((tool) => tool.status === "error")) return "完成检查失败";
  if (checks.some((tool) => stopHookDecision(tool.result) === "block")) {
    return "完成检查要求继续";
  }
  return checks.some((tool) => stopHookDecision(tool.result) === "allow")
    ? "完成检查放行"
    : "完成检查";
}

/** 完成检查的业务结果：允许结束、要求继续或执行失败。 */
function stopHookSummary(tool: ToolTrace): string {
  if (tool.status === "error") return "检查执行失败";
  if (stopHookDecision(tool.result) === "block") return "要求继续";
  if (tool.status === "success") return "允许结束";
  return "";
}

function stopHookDecision(result: JsonValue | undefined): string | undefined {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const decision = (result as Record<string, unknown>).decision;
  return typeof decision === "string" ? decision : undefined;
}

function StopHookResultBlock({ tool }: { tool: ToolTrace }) {
  const decision = stopHookDecision(tool.result);
  const reason =
    tool.result !== null && typeof tool.result === "object" &&
      !Array.isArray(tool.result)
      ? (tool.result as Record<string, unknown>).reason
      : undefined;
  return (
    <div className="px-[13px] pb-3">
      <span className="text-[11px] text-[#7b847e]">完成检查</span>
      <pre className="mt-[5px] overflow-auto rounded-[7px] bg-[#eff0eb] p-2.5 font-mono text-xs leading-[1.55] text-[#405048]">
        {JSON.stringify(tool.arguments, null, 2)}
      </pre>
      {typeof reason === "string" && (
        <p className="mt-2 whitespace-pre-wrap text-sm leading-[1.6] text-[#70443f]">
          {reason}
        </p>
      )}
      {tool.status === "success" && decision === "allow" && (
        <p className="mt-2 text-sm text-[#28795b]">脚本允许结束。</p>
      )}
      {tool.error && <DataBlock label="错误" value={tool.error} />}
    </div>
  );
}

function SubAgentBadge({
  summary,
  onOpen,
  onStop,
}: {
  summary: NonNullable<ToolTrace["subAgent"]>;
  onOpen?: () => void;
  onStop?: () => void;
}) {
  const text = [
    statusLabels[summary.status],
    `${summary.steps} steps`,
    ...(summary.usage === undefined
      ? []
      : [`${summary.usage.inputTokens + summary.usage.outputTokens} tokens`]),
  ].join(" · ");
  if (onOpen === undefined && onStop === undefined) return <small className="text-[#69736d]">{text}</small>;
  return (
    <span className="inline-flex items-center gap-1">
      {onOpen !== undefined && <button type="button" className="rounded-[7px] border border-[#d8dbd4] bg-white px-2 py-0.5 text-[11px] text-[#276c53] hover:bg-[#eff0eb]" onClick={(event) => { event.preventDefault(); onOpen(); }}>{text} · 查看子 Run</button>}
      {onStop !== undefined && (summary.status === "running" || summary.status === "stopping") && <button type="button" className="rounded-[7px] border border-[#e1b9b4] bg-white px-2 py-0.5 text-[11px] text-[#a33d35] disabled:opacity-50" disabled={summary.status === "stopping"} onClick={(event) => { event.preventDefault(); onStop(); }}>{summary.status === "stopping" ? "正在停止…" : "停止"}</button>}
    </span>
  );
}

function PendingElsewhereNote({ label }: { label: string }) {
  return (
    <p className="mt-2.5 rounded-[9px] border border-[#e7c98d] bg-[#fff9eb] px-[13px] py-2.5 text-xs leading-[1.5] text-[#79581a]">
      {label}待处理 · 请在输入框上方的卡片里做决定
    </p>
  );
}

function DataBlock({
  label,
  value,
}: {
  label: string;
  value: JsonValue | { code: string; message: string };
}) {
  return (
    <div className="px-[13px] pb-3">
      <span className="text-[11px] text-[#7b847e]">{label}</span>
      <pre className="mt-[5px] overflow-auto rounded-[7px] bg-[#eff0eb] p-2.5 font-mono text-xs leading-[1.55] text-[#405048]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function toolStatus(status: ToolTrace["status"], error?: ToolTrace["error"]) {
  if (status === "approval_required") return "等待确认";
  if (status === "running") return "执行中";
  if (status === "success") return "成功";
  if (error?.code === "TOOL_INTERRUPTED") return "已中断";
  return "失败";
}

function toolFetchSummary(tool: ToolTrace): string {
  const result = tool.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return "";
  }
  const record = result as Record<string, unknown>;
  const finalUrl = typeof record.finalUrl === "string" ? record.finalUrl : "";
  const title = typeof record.title === "string" ? record.title : "";
  return [finalUrl, title].filter((part) => part !== "").join(" · ");
}

function toolGlobSummary(tool: ToolTrace): string {
  const args = tool.arguments;
  let pattern = "";
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    if (typeof record.pattern === "string") pattern = record.pattern;
  }
  const result = tool.result;
  let count: string | undefined;
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.paths)) count = `${record.paths.length} 命中`;
  }
  return [pattern, count].filter((part) => part !== undefined).join(" · ");
}

function toolMcpSummary(tool: ToolTrace): string {
  // 名字形如 mcp__<server>__<tool>，摘要行显示 server · tool。
  const rest = tool.name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep === -1) return rest;
  return `${rest.slice(0, sep)} · ${rest.slice(sep + 2)}`;
}

function McpResultBlock({ tool }: { tool: ToolTrace }) {
  const result = tool.result;
  const content = result !== null && typeof result === "object" &&
      !Array.isArray(result) &&
      Array.isArray((result as Record<string, unknown>).content)
    ? (result as Record<string, unknown>).content as unknown[]
    : undefined;

  return (
    <div className="px-[13px] pb-3">
      <DataBlock label="参数" value={tool.arguments} />
      {content !== undefined && (
        <div className="mt-2">
          {content.map((block, index) => {
            if (block === null || typeof block !== "object") return null;
            const record = block as Record<string, unknown>;
            if (record.type === "text" && typeof record.text === "string") {
              return (
                <pre
                  key={index}
                  className="mt-0.5 whitespace-pre-wrap font-mono text-xs leading-[1.55] text-[#405048]"
                >
                  {record.text}
                </pre>
              );
            }
            if (
              (record.type === "image" || record.type === "audio") &&
              typeof record.bytes === "number"
            ) {
              return (
                <p key={index} className="text-xs text-[#7b847e]">
                  {record.type === "image" ? "image" : "audio"} ({record.bytes} bytes, omitted)
                </p>
              );
            }
            if (record.type === "resource" && typeof record.uri === "string") {
              return (
                <p key={index} className="truncate text-xs text-[#7b847e]">
                  resource: {String(record.uri)}
                </p>
              );
            }
            return null;
          })}
          {result !== null && typeof result === "object" &&
            !Array.isArray(result) &&
            (result as Record<string, unknown>).structuredContent !== undefined && (
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] text-[#7b847e]">
                  structured content
                </summary>
                <pre className="mt-1 overflow-auto rounded-[7px] bg-[#eff0eb] p-2.5 font-mono text-xs leading-[1.55] text-[#405048]">
                  {JSON.stringify(
                    (result as Record<string, unknown>).structuredContent,
                    null,
                    2,
                  )}
                </pre>
              </details>
            )}
        </div>
      )}
      {tool.error && <DataBlock label="错误" value={tool.error} />}
    </div>
  );
}

function TodoResultBlock({ tool }: { tool: ToolTrace }) {
  const parsed = parseTodoOutput(tool.result);
  if (parsed === undefined) {
    if (tool.error !== undefined) return <DataBlock label="错误" value={tool.error} />;
    return null;
  }
  return (
    <div className="px-[13px] pb-3">
      <span className="text-[11px] text-[#7b847e]">任务清单</span>
      <div className="mt-[5px]">
        <TodoList list={parsed} />
      </div>
    </div>
  );
}
