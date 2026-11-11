import { z } from "zod";

import { defineTool, ToolExecutionError } from "../tools.js";

const todoItemSchema = z.strictObject({
  content: z.string().trim().min(1).max(200),
  status: z.enum(["pending", "in_progress", "completed"]),
});

export type TodoItem = z.infer<typeof todoItemSchema>;

export const todoTool = defineTool({
  name: "todo",
  description:
    "Maintain a checklist of the current task's steps. Send the whole list each time; each call replaces the previous list.",
  impact: "Updates the in-memory task checklist without changing files or state.",
  inputSchema: z.strictObject({
    items: z.array(todoItemSchema).max(50),
  }),
  async execute({ items }) {
    const inProgress = items.filter((item) => item.status === "in_progress");
    if (inProgress.length > 1) {
      throw new ToolExecutionError(
        "INVALID_TOOL_INPUT",
        "At most one item may be in_progress.",
      );
    }
    const counts = {
      pending: items.filter((item) => item.status === "pending").length,
      in_progress: inProgress.length,
      completed: items.filter((item) => item.status === "completed").length,
    };
    return { items, counts };
  },
});
