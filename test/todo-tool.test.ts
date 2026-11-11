import assert from "node:assert/strict";
import test from "node:test";

import { ToolRegistry } from "../src/tools.js";
import { todoTool } from "../src/tools/todo.js";

test("echoes items and counts statuses", async () => {
  const registry = new ToolRegistry([todoTool]);
  const result = await registry.execute("todo", {
    items: [
      { content: "a", status: "pending" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "completed" },
    ],
  });
  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.deepEqual(result.output, {
      items: [
        { content: "a", status: "pending" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "completed" },
      ],
      counts: { pending: 1, in_progress: 1, completed: 1 },
    });
  }
});

test("rejects more than one in_progress item", async () => {
  const registry = new ToolRegistry([todoTool]);
  const result = await registry.execute("todo", {
    items: [
      { content: "a", status: "in_progress" },
      { content: "b", status: "in_progress" },
    ],
  });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.error.code, "INVALID_TOOL_INPUT");
  }
});

test("rejects blank content", async () => {
  const registry = new ToolRegistry([todoTool]);
  const result = await registry.execute("todo", {
    items: [{ content: "   ", status: "pending" }],
  });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.error.code, "INVALID_TOOL_INPUT");
  }
});

test("rejects more than 50 items", async () => {
  const registry = new ToolRegistry([todoTool]);
  const items = Array.from({ length: 51 }, (_, i) => ({
    content: `item ${i}`,
    status: "pending" as const,
  }));
  const result = await registry.execute("todo", { items });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.error.code, "INVALID_TOOL_INPUT");
  }
});
