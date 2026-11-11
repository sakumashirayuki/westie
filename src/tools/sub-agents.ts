// 父 Run 里的三个子任务工具：agent（后台启动）、wait_agent（在工具内部等待）、
// stop_agent（只停止指定子任务）。工具只与协调器交互，不认识子 Run 的实现。

import { z } from "zod";

import {
  MAX_SUB_AGENT_TASK_BYTES,
  MAX_SUB_AGENT_STOP_REASON_BYTES,
} from "../protocol.js";
import { assertStopAgentReason } from "../sub-agent-limits.js";
import type { SubAgentCoordinator } from "../sub-agent-coordinator.js";
import { defineTool, type Tool } from "../tools.js";

export const WAIT_AGENT_TOOL_NAME = "wait_agent";
export const STOP_AGENT_TOOL_NAME = "stop_agent";

export interface SubAgentToolContext {
  /** 本父 Run 的协调器；CLI 等没有子任务能力的装配不传。 */
  readonly coordinator: SubAgentCoordinator;
  /** 订阅父 Run 的 steering 入队通知；wait_agent 用它把等待中的工具唤醒。 */
  readonly onSteeringEnqueued: (listener: () => void) => () => void;
}

export function createSubAgentTools(options: SubAgentToolContext): readonly Tool[] {
  return [
    createAgentTool(options),
    createWaitAgentTool(options),
    createStopAgentTool(options),
  ];
}

function createAgentTool(options: SubAgentToolContext): Tool {
  return defineTool({
    name: "agent",
    description:
      "Delegate one self-contained task to a sub agent that starts in the background with an empty context, works with the same tools, and reports back when it finishes. Returns immediately with the runId.",
    impact:
      "Starts a nested agent with the same tools and permissions; each of its tool calls is authorized individually.",
    inputSchema: z.strictObject({
      description: z.string().trim().min(1).max(64),
      task: z.string().trim().min(1).refine(
        (task) => Buffer.byteLength(task, "utf8") <= MAX_SUB_AGENT_TASK_BYTES,
        { message: `task must not exceed ${MAX_SUB_AGENT_TASK_BYTES} bytes.` },
      ),
    }),
    async execute({ description, task }, context) {
      const toolCallId = context.toolCallId;
      if (toolCallId === undefined) {
        throw new Error(
          "The agent tool needs the parent tool call id.",
        );
      }
      // 启动是同步登记：并发上限和父 Run 收尾状态都在任何 await 之前检查。
      return options.coordinator.start({
        description,
        task,
        toolCallId,
      });
    },
  });
}

function createWaitAgentTool(options: SubAgentToolContext): Tool {
  return defineTool({
    name: WAIT_AGENT_TOOL_NAME,
    description:
      "Wait until a sub agent reports back, the user sends a new message, or no sub agent is running. Call it alone, only when you have no other work to do; never poll for sub agent status.",
    impact: "Suspends this tool call until one of those three events happens.",
    inputSchema: z.strictObject({}),
    async execute(_input, context) {
      context.signal?.throwIfAborted();
      if (context.toolCallId !== undefined) options.coordinator.markWaiting(context.toolCallId);
      const reason = await options.coordinator.waitForReadyOrSteering(
        options.onSteeringEnqueued,
        context.signal,
      );
      return { reason };
    },
  });
}

function createStopAgentTool(options: SubAgentToolContext): Tool {
  return defineTool({
    name: STOP_AGENT_TOOL_NAME,
    description:
      "Stop one sub agent started by this run and record why it is no longer needed. Other sub agents keep running.",
    impact: "Cancels that sub agent's execution; its pending approvals stop being actionable.",
    inputSchema: z.strictObject({
      runId: z.string().trim().min(1),
      reason: z
        .string()
        .trim()
        .min(1)
        .refine(
          (reason) =>
            Buffer.byteLength(reason, "utf8") <= MAX_SUB_AGENT_STOP_REASON_BYTES,
          { message: "reason must not exceed 1 KiB." },
        ),
    }),
    async execute({ runId, reason }) {
      return options.coordinator.requestStop(
        runId,
        "no_longer_needed",
        assertStopAgentReason(reason),
      );
    },
  });
}
