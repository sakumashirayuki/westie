import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures.js";

test("streams an answer and restores the conversation after refresh", async ({ page, testSession }) => {
  const { url, conversationId, resumeResponse } = await testSession.prepare({
    responses: [{ type: "text", chunks: ["流式", "回答"], pauseAfterFirst: true }],
  });
  await page.goto(`${url}/conversations/${conversationId}`);
  await page.locator("#task").fill("你好");
  await page.getByRole("button", { name: "发送" }).click();

  const turn = page.getByRole("article");
  await expect(turn).toContainText("你好");
  await expect(turn.locator(".agent-markdown")).toHaveText("流式");
  await expect(turn).toContainText("运行中");
  resumeResponse();
  await expect(turn.locator(".agent-markdown")).toHaveText("流式回答");
  await expect(turn).toContainText("已完成");

  await page.reload();
  await expect(page).toHaveURL(`${url}/conversations/${conversationId}`);
  await expect(turn).toContainText("你好");
  await expect(turn.locator(".agent-markdown")).toHaveText("流式回答");
  await expect(turn).toContainText("已完成");
});

test("reuses the service with an isolated workspace and tool response", async ({ testSession }) => {
  const { url, conversationId, workspacePath } = await testSession.prepare({
    workspace: "isolated",
    responses: [
      { type: "tool_call", name: "write", arguments: { path: "README.md", content: "# 示例\n" } },
      { type: "text", chunks: ["已创建 README.md"] },
    ],
  });
  const response = await fetch(`${url}/v1/agent/conversations/${conversationId}/runs:stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "创建 README.md" }),
  });
  expect(response.ok).toBe(true);
  const events = await response.text();
  expect(events).toContain("event: run.completed");
  expect(await readFile(join(workspacePath, "README.md"), "utf8")).toBe("# 示例\n");
});
