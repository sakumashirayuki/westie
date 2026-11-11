import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { HostDirectoryPicker } from "../src/infrastructure/host-file-picker.js";
import { openSqliteDatabase } from "../src/infrastructure/sqlite/index.js";
import { HostSandboxRunner } from "../src/sandbox/host-sandbox-runner.js";
import {
  startAgentServer,
  type RunningAgentServer,
} from "../src/server-bootstrap.js";

const PROVIDER_HOST = "api.deepseek.com";

/**
 * 真实 HTTP → Run → 检查脚本 → SQLite 的端到端用例。
 *
 * 第 1 次模型调用返回 final，第 2 次返回 final 之前先写一个完成标记文件，
 * 让真实脚本从第 2 次开始放行。沙箱换成宿主机执行，避免依赖 sandbox-exec。
 */
test("runs the project completion check before accepting the final answer", async () => {
  const directory = await prepareEnvironment();
  const realFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== PROVIDER_HOST) return realFetch(input, init);
    modelCalls += 1;
    if (modelCalls === 2) {
      await writeFile(join(directory, "done"), "1", "utf8");
    }
    return sseResponse(finalCompletion(modelCalls === 1 ? "任务已完成。" : "补充了标记。"));
  };

  let server: RunningAgentServer | undefined;
  try {
    server = await startAgentServer({
      port: 0,
      sandboxRunnerFactory: async () => new HostSandboxRunner(),
      hostDirectoryPicker: pickWorkspace(directory),
    });

    const inspected = await realFetch(
      `${server.url}/v1/agent/conversations:select-workspace`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "inspect" }),
      },
    );
    assert.equal(inspected.status, 200);
    const { selectionToken } = await inspected.json() as { selectionToken: string };
    const created = await realFetch(`${server.url}/v1/agent/conversations:open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selectionToken,
        executionMode: "full_access",
        workspace: { kind: "selected_directory" },
      }),
    });
    assert.equal(created.status, 201);
    const { id: conversationId } = await created.json() as { id: string };

    const run = await realFetch(
      `${server.url}/v1/agent/conversations/${conversationId}/runs:stream`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "完成任务" }),
      },
    );
    assert.equal(run.status, 200);
    const frames = await run.text();

    assert.equal(modelCalls, 2);
    assert.match(frames, /"type":"tool\.started"/);
    assert.match(frames, /"name":"stop_hook"/);
    assert.match(frames, /"decision":"block"/);
    assert.match(frames, /"type":"run\.completed"/);
    // 被拒绝的候选回答不作为完成答复出现；通过的候选回答是唯一 answer.completed。
    assert.match(frames, /"type":"answer\.completed","step":2,"data":\{"answer":"补充了标记。"\}/);
    assert.doesNotMatch(frames, /"answer":"任务已完成。"/);
    assert.equal(await readFile(join(directory, "done"), "utf8"), "1");

    const database = openSqliteDatabase(join(directory, "agent.sqlite"));
    try {
      const rows = database
        .prepare(
          `SELECT role, message_json FROM transcript_messages
           WHERE conversation_id = $conversationId ORDER BY seq`,
        )
        .all({ "$conversationId": conversationId }) as Array<{
          role: string;
          message_json: string;
        }>;
      const messages = rows.map((row) => JSON.parse(row.message_json) as {
        role: string;
        content?: string;
        source?: string;
      });
      assert.deepEqual(
        messages.map((message) => message.role),
        ["user", "user", "user", "assistant"],
      );
      // 第一次检查拒绝（applied:true，模型据此补做），第二次放行。
      assert.equal(messages[1]?.source, "stop_hook");
      assert.match(messages[1]?.content ?? "", /"decision":"block"/);
      assert.match(messages[1]?.content ?? "", /"applied":true/);
      assert.equal(messages[2]?.source, "stop_hook");
      assert.match(messages[2]?.content ?? "", /"decision":"allow"/);
      assert.equal(messages[3]?.content, "补充了标记。");
      const stored = database
        .prepare(
          `SELECT runs.status, runs.error_code
           FROM runs JOIN turns ON turns.id = runs.turn_id
           WHERE turns.conversation_id = $conversationId`,
        )
        .all({ "$conversationId": conversationId }) as Array<{
          status: string;
          error_code: string | null;
        }>;
      assert.deepEqual(
        stored.map((row) => ({ ...row })),
        [{ status: "completed", error_code: null }],
      );
    } finally {
      database.close();
    }
  } finally {
    globalThis.fetch = realFetch;
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * 脚本超时：Run 以 STOP_HOOK_FAILED 结束，检查的错误码与诊断消息跟随 run.error，
 * 且前端的 stop_hook 卡片先收到 tool.completed。
 */
test("surfaces the timeout code and diagnosis on a failed check", async () => {
  const directory = await prepareEnvironment({
    command: "sleep 5",
    timeoutMs: 100,
    maxContinuations: 1,
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== PROVIDER_HOST) return realFetch(input, init);
    return sseResponse(finalCompletion("任务已完成。"));
  };

  let server: RunningAgentServer | undefined;
  try {
    server = await startAgentServer({
      port: 0,
      sandboxRunnerFactory: async () => new HostSandboxRunner(),
      hostDirectoryPicker: pickWorkspace(directory),
    });
    const inspected = await realFetch(
      `${server.url}/v1/agent/conversations:select-workspace`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "inspect" }),
      },
    );
    assert.equal(inspected.status, 200);
    const { selectionToken } = await inspected.json() as { selectionToken: string };
    const created = await realFetch(`${server.url}/v1/agent/conversations:open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selectionToken,
        executionMode: "full_access",
        workspace: { kind: "selected_directory" },
      }),
    });
    const { id: conversationId } = await created.json() as { id: string };
    const run = await realFetch(
      `${server.url}/v1/agent/conversations/${conversationId}/runs:stream`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "完成任务" }),
      },
    );
    const frames = await run.text();

    // 超时路径只发一次 tool.completed：脚本执行链自己发的那条，不再补发。
    assert.equal(frames.match(/"type":"tool\.completed"/g)?.length, 1);
    assert.match(frames, /"code":"COMMAND_TIMEOUT"/);
    assert.match(frames, /Command timed out after 100ms/);
    assert.match(frames, /"type":"run\.error"/);
    const completedAt = frames.indexOf('"type":"tool.completed"');
    const errorAt = frames.indexOf('"type":"run.error"');
    assert.ok(completedAt >= 0 && completedAt < errorAt);
    // 候选回答没有被当作完成答复发布。
    assert.doesNotMatch(frames, /"type":"answer\.completed"/);
  } finally {
    globalThis.fetch = realFetch;
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * 配置文件非法：装配阶段失败，SSE 与落库都必须给出可诊断的错误码，而不是
 * 通用的 AGENT_RUN_FAILED。
 */
test("surfaces STOP_HOOK_CONFIG_INVALID on the stream and in the database", async () => {
  const directory = await prepareEnvironment({ command: "" });
  const realFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== PROVIDER_HOST) return realFetch(input, init);
    providerCalls += 1;
    return sseResponse(finalCompletion("不应该被调用"));
  };

  let server: RunningAgentServer | undefined;
  try {
    server = await startAgentServer({
      port: 0,
      sandboxRunnerFactory: async () => new HostSandboxRunner(),
      hostDirectoryPicker: pickWorkspace(directory),
    });
    const inspected = await realFetch(
      `${server.url}/v1/agent/conversations:select-workspace`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "inspect" }),
      },
    );
    assert.equal(inspected.status, 200);
    const { selectionToken } = await inspected.json() as { selectionToken: string };
    const created = await realFetch(`${server.url}/v1/agent/conversations:open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selectionToken,
        executionMode: "full_access",
        workspace: { kind: "selected_directory" },
      }),
    });
    const { id: conversationId } = await created.json() as { id: string };
    const run = await realFetch(
      `${server.url}/v1/agent/conversations/${conversationId}/runs:stream`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "完成任务" }),
      },
    );
    const frames = await run.text();

    assert.equal(providerCalls, 0);
    assert.match(frames, /"type":"run\.error"/);
    assert.match(frames, /"code":"STOP_HOOK_CONFIG_INVALID"/);
    const database = openSqliteDatabase(join(directory, "agent.sqlite"));
    try {
      const stored = database
        .prepare(
          `SELECT runs.status, runs.error_code
           FROM runs JOIN turns ON turns.id = runs.turn_id
           WHERE turns.conversation_id = $conversationId`,
        )
        .all({ "$conversationId": conversationId }) as Array<{
          status: string;
          error_code: string;
        }>;
      assert.deepEqual(
        stored.map((row) => ({ ...row })),
        [{ status: "failed", error_code: "STOP_HOOK_CONFIG_INVALID" }],
      );
    } finally {
      database.close();
    }
  } finally {
    globalThis.fetch = realFetch;
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function sseResponse(payload: string): Response {
  return new Response(payload, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** DeepSeek Chat Completions 的流式最终回答。 */
function finalCompletion(content: string): string {
  const chunk = {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-test",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content },
        finish_reason: null,
      },
    ],
    usage: null,
  };
  const finish = {
    ...chunk,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_cache_hit_tokens: 0,
    },
  };
  return [
    `data: ${JSON.stringify(chunk)}`,
    "",
    `data: ${JSON.stringify(finish)}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

async function prepareEnvironment(
  config: unknown = {
    command:
      `if [ -f done ]; then echo '{"decision":"allow"}'; ` +
      `else echo '{"decision":"block","reason":"缺少 done 标记"}'; fi`,
    timeoutMs: 10_000,
    maxContinuations: 1,
  },
): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agent-stop-hook-http-")),
  );
  await mkdir(join(directory, ".agents"), { recursive: true });
  await writeFile(
    join(directory, ".agents", "stop-hook.json"),
    JSON.stringify(config),
    "utf8",
  );
  Object.assign(process.env, {
    HOME: directory,
    HOST: "127.0.0.1",
    AGENT_DATABASE_PATH: join(directory, "agent.sqlite"),
    AGENT_MODEL_CONTEXT_TOKENS: "64000",
    AGENT_MODEL_MAX_OUTPUT_TOKENS: "4000",
    LLM_PROVIDER: "deepseek",
    DEEPSEEK_API_KEY: "test-key",
    DEEPSEEK_MODEL: "deepseek-test",
    TAVILY_API_KEY: "test-key",
  });
  return directory;
}

function pickWorkspace(directory: string): HostDirectoryPicker {
  return {
    async pickDirectory() {
      return { status: "selected", path: directory };
    },
  };
}
