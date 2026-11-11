import { z } from "zod";

import type { WorkspaceSkillRegistry } from "../infrastructure/workspace-skills.js";
import { defineTool, ToolExecutionError, type Tool } from "../tools.js";

const MAX_SKILL_TOOL_OUTPUT_BYTES = 512 * 1024;

export function createSkillTool(registry: WorkspaceSkillRegistry): Tool {
  return defineTool({
    name: "skill",
    description:
      "Load the complete instructions for one skill from the current catalog.",
    impact:
      "Loads instructions from one discovered SKILL.md without changing tool permissions.",
    maxOutputBytes: MAX_SKILL_TOOL_OUTPUT_BYTES,
    inputSchema: z.strictObject({
      name: z.string().min(1).max(64),
    }),
    summarizeInput({ name }) {
      return { name };
    },
    async execute({ name }) {
      const descriptor = registry.skills.find((skill) => skill.name === name);
      if (descriptor === undefined) {
        throw new ToolExecutionError(
          "INVALID_TOOL_INPUT",
          `Unknown skill: ${name}`,
        );
      }
      const loaded = await registry.load(name);
      return {
        skill: name,
        content: loaded.content,
        source: loaded.source,
        directory: loaded.directory,
      };
    },
  });
}
