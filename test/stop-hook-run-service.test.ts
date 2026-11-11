import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ConversationRunService } from "../src/application/conversation-run-service.js";
import type { AgentEvent } from "../src/agent-events.js";
import type { WorkspaceRuntimeProvider } from "../src/application/workspace-runtime.js";
import type { LlmProvider } from "../src/provider-protocol.js";
import { publicRunError } from "../src/agent-run-errors.js";
import { HostSandboxRunner } from "../src/sandbox/host-sandbox-runner.js";
import type { RunEventSource } from "../src/run-stream.js";
import { StopHookConfigError } from "../src/infrastructure/workspace-stop-hook-config.js";
import { parseTranscriptMessage, type TranscriptMessage } from "../src/transcript.js";
import { providerFromTurnFactory, finalTurn } from "./support/provider.js";
import { createSQLiteTestStore } from "./support/sqlite-test-store.js";

const providerCapacity = {
  contextWindowTokens: 64_000,
  maxOutputTokens: 4_000,
} as const;

function provider(
  factory: Parameters<typeof providerFromTurnFactory>[0],
): LlmProvider {
  return providerFromTurnFactory(factory, providerCapacity);
}

/** 收集父 Run 的事件；子 Run 事件不在本用例关注范围内。 */
async function consumeParentEvents(
  events: AsyncIterable<RunEventSource>,
): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const source of events) {
    if (source.subAgent === undefined) collected.push(source.event);
  }
  return collected;
}

function workspaceRuntimeProvider(
  workspaceRoot: string,
): WorkspaceRuntimeProvider {
  return {
    async get(_requested, executionMode) {
      return {
        workspaceRoot,
        executionMode,
        sandboxRunner: new HostSandboxRunner(),
        tools: [],
      };
    },
  };
}

async function withWorkspace(
  run: (workspaceRoot: string) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "my-agent-harness-stop-hook-run-"),
  );
  try {
    await run(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function writeStopHookConfig(
  workspaceRoot: string,
  config: unknown,
): Promise<void> {
  await mkdir(path.join(workspaceRoot, ".agents"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, ".agents", "stop-hook.json"),
    JSON.stringify(config),
    "utf8",
  );
}

test("注入项目级完成检查，并把放行与拒绝交给主循环", async (t) => {
  await withWorkspace(async (workspaceRoot) => {
    await writeStopHookConfig(workspaceRoot, {
      // 真实脚本：第一次要求继续，第二次放行。
      command:
        `if [ -f ${JSON.stringify(path.join(workspaceRoot, "done"))} ]; ` +
        `then echo '{"decision":"allow"}'; ` +
        `else touch ${JSON.stringify(path.join(workspaceRoot, "done"))}; ` +
        `echo '{"decision":"block","reason":"缺少 done 标记"}'; fi`,
      timeoutMs: 10_000,
      maxContinuations: 1,
    });
    const { database, store } = createSQLiteTestStore(t);
    const conversation = store.createConversation(
      workspaceRoot,
      "full_access",
    );
    const { loadStopHookConfig } = await import(
      "../src/infrastructure/workspace-stop-hook-config.js"
    );
    const service = new ConversationRunService({
      loadWorkspaceInstructions: async () => undefined,
      loadStopHookConfig,
      conversationStore: store,
      workspaceRuntimeProvider: workspaceRuntimeProvider(workspaceRoot),
      provider: provider((request) =>
        request.transcript.length > 1
          ? finalTurn("补充了 done 标记。")
          : finalTurn("已经完成。")
      ),
    });

    const run = service.startRun({
      conversationId: conversation.id,
      input: "完成任务",
    });
    const events = await consumeParentEvents(run.events);

    assert.deepEqual(
      events.flatMap((event) =>
        event.type === "run.completed" ? [event.data.stopReason] : []
      ),
      ["final"],
    );
    const toolEvents = events.flatMap((event) =>
      event.type === "tool.started" || event.type === "tool.completed"
        ? [[event.type, event.data.name]]
        : []
    );
    assert.deepEqual(toolEvents, [
      ["tool.started", "stop_hook"],
      ["tool.completed", "stop_hook"],
      ["tool.started", "stop_hook"],
      ["tool.completed", "stop_hook"],
    ]);

    const rows = database
      .prepare(
        `SELECT role, message_json FROM transcript_messages
         WHERE conversation_id = $conversationId ORDER BY seq`,
      )
      .all({ "$conversationId": conversation.id }) as Array<{
        role: string;
        message_json: string;
      }>;
    const transcript: TranscriptMessage[] = rows.map((row) =>
      parseTranscriptMessage(row.message_json)
    );
    assert.deepEqual(
      transcript.map((message) => message.role),
      ["user", "user", "user", "assistant"],
    );
    const blocked = transcript[1];
    assert.ok(blocked?.role === "user" && "source" in blocked);
    assert.match(blocked.content, /"decision":"block"/);
    assert.match(blocked.content, /"applied":true/);
    const allowed = transcript[2];
    assert.ok(allowed?.role === "user" && "source" in allowed);
    assert.match(allowed.content, /"decision":"allow"/);
    const finalAnswer = rows.at(-1);
    assert.equal(
      finalAnswer === undefined
        ? undefined
        : JSON.parse(finalAnswer.message_json).content,
      "补充了 done 标记。",
    );
  });
});

test("配置文件非法时本轮以 STOP_HOOK_CONFIG_INVALID 失败", async (t) => {
  await withWorkspace(async (workspaceRoot) => {
    await writeStopHookConfig(workspaceRoot, { command: "" });
    const { store } = createSQLiteTestStore(t);
    const conversation = store.createConversation(
      workspaceRoot,
      "full_access",
    );
    const { loadStopHookConfig } = await import(
      "../src/infrastructure/workspace-stop-hook-config.js"
    );
    const service = new ConversationRunService({
      loadWorkspaceInstructions: async () => undefined,
      loadStopHookConfig,
      conversationStore: store,
      workspaceRuntimeProvider: workspaceRuntimeProvider(workspaceRoot),
      provider: provider(() => finalTurn("不应该被调用")),
    });

    const run = service.startRun({
      conversationId: conversation.id,
      input: "完成任务",
    });
    await assert.rejects(consumeParentEvents(run.events), (error: unknown) => {
      assert.ok(error instanceof StopHookConfigError);
      assert.equal(publicRunError(error).code, "STOP_HOOK_CONFIG_INVALID");
      return true;
    });
  });
});
