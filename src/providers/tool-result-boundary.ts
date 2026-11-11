import {
  SUB_AGENT_RESULT_TYPE,
  UNTRUSTED_TOOL_RESULT_TYPE,
  WORKSPACE_SKILL_INSTRUCTIONS_TYPE,
  type ToolResult,
} from "../protocol.js";
import { serializeStopHookResultForModel } from "../stop-hook-result.js";
import type { TranscriptMessage } from "../transcript.js";

/** 子任务报告进入模型时的固定包装；内容按数据转义，只作为证据。 */
export function serializeSubAgentResultForModel(
  message: Extract<TranscriptMessage, { role: "user"; source: "sub_agent" }>,
): string {
  return JSON.stringify({
    type: SUB_AGENT_RESULT_TYPE,
    instructionTrust: "untrusted",
    runId: message.subAgentRunId,
    data: message.content,
  });
}

export { serializeStopHookResultForModel };

export function serializeToolResultForModel(result: ToolResult): string {
  const workspaceSkill = workspaceSkillInstructions(result);
  if (workspaceSkill !== undefined) {
    return JSON.stringify({
      type: WORKSPACE_SKILL_INSTRUCTIONS_TYPE,
      instructionTrust: "workspace",
      skill: workspaceSkill.skill,
      content: workspaceSkill.content,
      ...(workspaceSkill.source === undefined
        ? {}
        : { source: workspaceSkill.source }),
      ...(workspaceSkill.directory === undefined
        ? {}
        : { directory: workspaceSkill.directory }),
    });
  }
  return JSON.stringify({
    type: UNTRUSTED_TOOL_RESULT_TYPE,
    instructionTrust: "untrusted",
    data: result,
  });
}

function workspaceSkillInstructions(
  result: ToolResult,
):
  | {
      readonly skill: string;
      readonly content: string;
      readonly source?: string;
      readonly directory?: string;
    }
  | undefined {
  if (
    result.status !== "success" ||
    result.tool !== "skill" ||
    !isRecord(result.output)
  ) {
    return undefined;
  }
  const { output } = result;
  const keys = Object.keys(output).sort();

  // 新四键形状：skill / content / source / directory。
  if (
    keys.length === 4 &&
    keys[0] === "content" &&
    keys[1] === "directory" &&
    keys[2] === "skill" &&
    keys[3] === "source" &&
    typeof output.skill === "string" &&
    typeof output.content === "string" &&
    typeof output.directory === "string" &&
    (output.source === "workspace" || output.source === "user")
  ) {
    return {
      skill: output.skill,
      content: output.content,
      source: output.source,
      directory: output.directory,
    };
  }

  // 旧两键形状（历史 transcript）：skill / content。
  if (
    keys.length === 2 &&
    keys[0] === "content" &&
    keys[1] === "skill" &&
    typeof output.skill === "string" &&
    typeof output.content === "string"
  ) {
    return { skill: output.skill, content: output.content };
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
