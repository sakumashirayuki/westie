import assert from "node:assert/strict";
import test from "node:test";

import type { WorkspaceSkillRegistry } from "../src/infrastructure/workspace-skills.js";
import { ToolRegistry } from "../src/tools.js";
import { createSkillTool } from "../src/tools/skill.js";

const instructions = "---\nname: review\ndescription: Review.\n---\n# Review\n";

function registry(): WorkspaceSkillRegistry {
  return {
    skills: [{ name: "review", description: "Review.", source: "workspace" }],
    catalog: "<skills/>",
    diagnostics: [],
    async load(name) {
      assert.equal(name, "review");
      return {
        content: instructions,
        directory: "/workspace/.agents/skills/review",
        source: "workspace",
      };
    },
  };
}

test("loads complete instructions with source and directory", async () => {
  const result = await new ToolRegistry([createSkillTool(registry())]).execute(
    "skill",
    { name: "review" },
  );

  assert.deepEqual(result, {
    type: "tool_result",
    tool: "skill",
    status: "success",
    output: {
      skill: "review",
      content: instructions,
      source: "workspace",
      directory: "/workspace/.agents/skills/review",
    },
  });
});

test("rejects unknown names, paths, and extra input fields", async () => {
  const tools = new ToolRegistry([createSkillTool(registry())]);

  assert.equal((await tools.execute("skill", { name: "missing" })).status, "error");
  assert.equal((await tools.execute("skill", { name: "../review" })).status, "error");
  const extra = await tools.execute("skill", { name: "review", path: "/tmp" });
  assert.equal(extra.status, "error");
  if (extra.status === "error") {
    assert.equal(extra.error.code, "INVALID_TOOL_INPUT");
  }
});

test("allows a 64 KiB skill body despite JSON serialization overhead", async () => {
  const content = "\n".repeat(64 * 1024);
  const largeRegistry: WorkspaceSkillRegistry = {
    ...registry(),
    async load() {
      return {
        content,
        directory: "/workspace/.agents/skills/review",
        source: "workspace",
      };
    },
  };

  const result = await new ToolRegistry([
    createSkillTool(largeRegistry),
  ]).execute("skill", { name: "review" });

  assert.equal(result.status, "success");
});
