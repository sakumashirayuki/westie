import { describe, expect, it } from "vitest";

import {
  latestTodo,
  parseTodoOutput,
  TodoList,
} from "./TodoList";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

describe("parseTodoOutput", () => {
  it("parses a valid todo result", () => {
    expect(parseTodoOutput({
      items: [
        { content: "a", status: "pending" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "completed" },
      ],
      counts: { pending: 1, in_progress: 1, completed: 1 },
    })).toEqual({
      items: [
        { content: "a", status: "pending" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "completed" },
      ],
      counts: { pending: 1, in_progress: 1, completed: 1 },
    });
  });

  it("returns undefined for malformed results", () => {
    expect(parseTodoOutput(undefined)).toBeUndefined();
    expect(parseTodoOutput("nope")).toBeUndefined();
    expect(parseTodoOutput({ items: [{ content: 1, status: "pending" }] })).toBeUndefined();
    expect(parseTodoOutput({ items: [{ content: "a", status: "bad" }] })).toBeUndefined();
  });
});

describe("latestTodo", () => {
  it("finds the most recent successful todo result", () => {
    const list = latestTodo([
      {
        tools: [{
          id: "t1",
          name: "todo",
          status: "success" as const,
          arguments: null,
          result: {
            items: [{ content: "first", status: "pending" as const }],
            counts: { pending: 1, in_progress: 0, completed: 0 },
          },
        }],
      },
      {
        tools: [{
          id: "t2",
          name: "todo",
          status: "success" as const,
          arguments: null,
          result: {
            items: [{ content: "second", status: "completed" as const }],
            counts: { pending: 0, in_progress: 0, completed: 1 },
          },
        }],
      },
    ]);
    expect(list?.items[0]?.content).toBe("second");
  });

  it("skips failed todo results", () => {
    const list = latestTodo([
      {
        tools: [{
          id: "t1",
          name: "todo",
          status: "success" as const,
          arguments: null,
          result: {
            items: [{ content: "good", status: "pending" as const }],
            counts: { pending: 1, in_progress: 0, completed: 0 },
          },
        }],
      },
      {
        tools: [{
          id: "t2",
          name: "todo",
          status: "error" as const,
          arguments: null,
          error: { code: "X", message: "y" },
        }],
      },
    ]);
    expect(list?.items[0]?.content).toBe("good");
  });
});

describe("TodoList", () => {
  it("renders items with status styling", () => {
    const html = renderToStaticMarkup(createElement(TodoList, {
      list: {
        items: [
          { content: "pending item", status: "pending" },
          { content: "doing item", status: "in_progress" },
          { content: "done item", status: "completed" },
        ],
        counts: { pending: 1, in_progress: 1, completed: 1 },
      },
    }));
    expect(html).toContain("任务清单");
    expect(html).toContain("1/3");
    expect(html).toContain("pending item");
    expect(html).toContain("doing item");
    expect(html).toContain("done item");
    expect(html).toContain("进行中");
  });
});
