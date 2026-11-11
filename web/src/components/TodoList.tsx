import type { JsonValue } from "../events";
import type { ToolTrace } from "../run-state";

export interface TodoItemView {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TodoListView {
  items: TodoItemView[];
  counts: {
    pending: number;
    in_progress: number;
    completed: number;
  };
}

/**
 * 从一条 todo 工具的 result 里解析清单；形状不对时返回 undefined，让调用方
 * 退化为不渲染。
 */
export function parseTodoOutput(value: JsonValue | undefined): TodoListView | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.items)) return undefined;
  const items: TodoItemView[] = [];
  for (const item of record.items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return undefined;
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.content !== "string") return undefined;
    if (
      entry.status !== "pending" &&
      entry.status !== "in_progress" &&
      entry.status !== "completed"
    ) {
      return undefined;
    }
    items.push({ content: entry.content, status: entry.status });
  }
  const counts = record.counts;
  if (counts !== null && typeof counts === "object" && !Array.isArray(counts)) {
    return { items, counts: counts as TodoListView["counts"] };
  }
  return { items, counts: { pending: 0, in_progress: 0, completed: 0 } };
}

/**
 * 从 Turn 的步骤里倒序找最近一次成功 todo 调用，返回其清单。
 */
export function latestTodo(
  steps: ReadonlyArray<{ tools: ToolTrace[] }>,
): TodoListView | undefined {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]!;
    for (let j = step.tools.length - 1; j >= 0; j -= 1) {
      const tool = step.tools[j]!;
      if (tool.name === "todo" && tool.status === "success") {
        const parsed = parseTodoOutput(tool.result);
        if (parsed !== undefined) return parsed;
      }
    }
  }
  return undefined;
}

export function TodoList({ list }: { list: TodoListView }) {
  const done = list.counts.completed;
  const total = list.items.length;
  return (
    <section className="mt-4 rounded-[12px] border border-[#e0e2dd] bg-[#fafaf7] px-[15px] py-[13px]">
      <h4 className="mb-2.5 flex items-center gap-2 text-sm font-bold text-[#536159]">
        任务清单
        <span className="text-xs font-normal text-[#858c87]">
          {done}/{total}
        </span>
      </h4>
      <ul className="m-0 list-none p-0">
        {list.items.map((item, index) => {
          const state = item.status;
          const textClass = state === "completed"
            ? "text-[#9aa19c] line-through"
            : "text-[#405048]";
          const marker = state === "completed" ? "✓" : state === "in_progress" ? "·" : "○";
          const markerClass = state === "in_progress"
            ? "text-[#a5650d] font-bold"
            : state === "completed"
              ? "text-[#28795b]"
              : "text-[#9aa19c]";
          return (
            <li
              key={index}
              className="flex items-start gap-2 py-0.5 text-sm leading-[1.6]"
            >
              <span className={`mt-[1px] ${markerClass}`}>{marker}</span>
              <span className={textClass}>
                {item.content}
                {state === "in_progress" && (
                  <span className="ml-2 rounded-[5px] bg-[#fff9eb] px-1.5 py-0.5 text-[11px] text-[#79581a]">
                    进行中
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
