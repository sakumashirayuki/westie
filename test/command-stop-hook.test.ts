import assert from "node:assert/strict";
import test from "node:test";

import {
  createCommandStopHook,
  parseDecision,
} from "../src/application/command-stop-hook.js";
import { AgentEventFactory, type AgentEvent } from "../src/agent-events.js";
import { HostSandboxRunner } from "../src/sandbox/host-sandbox-runner.js";
import { AuthorizedToolExecutor } from "../src/tool-permissions.js";
import { STOP_HOOK_OUTPUT_INVALID } from "../src/application/command-stop-hook.js";
import { StopHookFailedError } from "../src/stop-hook.js";

const runId = "run-1";

function createHook(command: string, overrides: {
  maxContinuations?: number;
  executor?: AuthorizedToolExecutor;
  timeoutMs?: number;
} = {}) {
  return createCommandStopHook({
    command,
    timeoutMs: overrides.timeoutMs ?? 10_000,
    maxContinuations: overrides.maxContinuations ?? 2,
    workspaceRoot: process.cwd(),
    executionMode: "full_access",
    conversationId: "conversation-1",
    runId,
    input: "实现 parser",
    sandboxRunner: new HostSandboxRunner(),
    eventFactory: new AgentEventFactory(runId),
    authorizedToolExecutor: overrides.executor ??
      new AuthorizedToolExecutor({
        policy: {
          evaluate: () => ({ effect: "allow", ruleId: "test" }),
          isVisible: () => true,
        },
      }),
    toolPermissionContext: {
      workspaceRoot: process.cwd(),
      executionMode: "full_access",
      conversationId: "conversation-1",
    },
  });
}

async function collect(
  hook: ReturnType<typeof createHook>,
  candidateAnswer: string,
): Promise<{
  decision: unknown;
  events: AgentEvent[];
  error: unknown;
}> {
  const events: AgentEvent[] = [];
  const generator = hook.check({
    candidateAnswer,
    transcript: [{ role: "user", content: "实现 parser" }],
    step: 3,
    continuations: 0,
  });
  try {
    for (;;) {
      const next = await generator.next();
      if (next.done === true) {
        return { decision: next.value, events, error: undefined };
      }
      events.push(next.value);
    }
  } catch (error) {
    return { decision: undefined, events, error };
  }
}

test("parses only the two strict decision shapes", () => {
  assert.deepEqual(parseDecision({ decision: "allow" }), { decision: "allow" });
  assert.deepEqual(parseDecision({ decision: "block", reason: "未通过" }), {
    decision: "block",
    reason: "未通过",
  });
});

test("rejects every invalid decision shape with the output protocol code", () => {
  const invalid: readonly [unknown, RegExp][] = [
    [{ decision: "allow", extra: 1 }, /Unrecognized key/],
    [{ decision: "block" }, /expected string/],
    [{ decision: "block", reason: "" }, /reason must not be empty/],
    [{ decision: "block", reason: "   " }, /reason must not be empty/],
    [{ decision: "block", reason: "x".repeat(4 * 1024 + 1) }, /reason must be at most 4096 bytes/],
    // 4 KiB 是 UTF-8 字节数，不是字符数。
    [{ decision: "block", reason: "汉".repeat(1400) }, /reason must be at most 4096 bytes/],
    [{ decision: "deny" }, /Invalid discriminator value/],
    [[], /expected object/],
    ["allow", /expected object/],
    [null, /expected object/],
  ];
  for (const [value, message] of invalid) {
    assert.throws(
      () => parseDecision(value),
      (error: unknown) => {
        assert.ok(error instanceof StopHookFailedError);
        assert.equal(error.code, STOP_HOOK_OUTPUT_INVALID);
        assert.match(error.message, message);
        return true;
      },
      JSON.stringify(value)?.slice(0, 60),
    );
  }
});

test("rejects a top-level __proto__ key that strictObject skips", () => {
  // JSON.parse 把 `__proto__` 作为自有键写入，zod 4.4.3 的未知键检查会跳过它。
  const values = [
    JSON.parse('{"decision":"allow","__proto__":{"x":1}}'),
    JSON.parse('{"decision":"block","reason":"未通过","__proto__":null}'),
  ];
  for (const value of values) {
    assert.throws(
      () => parseDecision(value),
      (error: unknown) => {
        assert.ok(error instanceof StopHookFailedError);
        assert.equal(error.code, STOP_HOOK_OUTPUT_INVALID);
        assert.match(error.message, /Unrecognized key: "__proto__"/);
        return true;
      },
    );
  }
});

test("reports an invalid decision through the tool result and the check error", async () => {
  const hook = createHook(`echo '{"decision":"allow","extra":1}'`);
  const { events, error } = await collect(hook, "done");

  assert.ok(error instanceof StopHookFailedError);
  assert.equal(error.code, STOP_HOOK_OUTPUT_INVALID);
  assert.match(error.message, /Unrecognized key/);
  const completed = events.at(-1) as Extract<AgentEvent, { type: "tool.completed" }>;
  assert.equal(completed.type, "tool.completed");
  assert.equal(completed.data.status, "error");
  assert.equal(
    completed.data.status === "error" ? completed.data.error.code : undefined,
    STOP_HOOK_OUTPUT_INVALID,
  );
  assert.match(
    completed.data.status === "error" ? completed.data.error.message : "",
    /Unrecognized key/,
  );
});

test("writes the check input to stdin and reads a block decision", async () => {
  const hook = createHook(
    `cat >/dev/null; echo '{"decision":"block","reason":"空输入测试未通过"}'`,
  );
  const { decision, events } = await collect(hook, "实现已完成。");
  assert.deepEqual(decision, { decision: "block", reason: "空输入测试未通过" });
  assert.deepEqual(
    events.map((event) => event.type),
    ["tool.started", "tool.completed"],
  );
  const started = events[0] as Extract<AgentEvent, { type: "tool.started" }>;
  assert.equal(started.data.name, "stop_hook");
  assert.deepEqual(started.data.arguments, {
    command: `cat >/dev/null; echo '{"decision":"block","reason":"空输入测试未通过"}'`,
    timeoutMs: 10_000,
  });
});

test("passes the request as JSON on stdin", async () => {
  // 脚本从 stdin 读 JSON，按候选回答决定放行还是要求继续。
  const allow = `{"decision":"allow"}`;
  const block = `{"decision":"block","reason":"candidate answer not accepted"}`;
  const script = [
    "input=$(cat)",
    `case "$input" in *candidateAnswer*实现已完成*) echo '${allow}';; *) echo '${block}';; esac`,
  ].join("\n");
  const accepted = await collect(createHook(script), "实现已完成。");
  assert.deepEqual(accepted.decision, { decision: "allow" });
  const rejected = await collect(createHook(script), "尚未完成");
  assert.deepEqual(rejected.decision, {
    decision: "block",
    reason: "candidate answer not accepted",
  });
});

test("keeps the output protocol code and stderr diagnosis for a failing script", async () => {
  const hook = createHook(`echo "check exploded" >&2; exit 3`);
  const { events, error } = await collect(hook, "done");

  assert.ok(error instanceof StopHookFailedError);
  assert.equal(error.code, STOP_HOOK_OUTPUT_INVALID);
  assert.match(error.message, /exited with status 3/);
  assert.match(error.message, /check exploded/);
  // 前端仍能收到完成的工具事件，卡片不会停在“执行中”。
  assert.deepEqual(
    events.map((event) => event.type),
    ["tool.started", "tool.completed"],
  );
  const completed = events[1] as Extract<AgentEvent, { type: "tool.completed" }>;
  assert.equal(completed.data.status, "error");
});

test("keeps the timeout code and message when the script times out", async () => {
  const hook = createHook("sleep 5", { timeoutMs: 100 });
  const { events, error } = await collect(hook, "done");

  assert.ok(error instanceof StopHookFailedError);
  assert.equal(error.code, "COMMAND_TIMEOUT");
  assert.match(error.message, /timed out after 100ms/);
  const completed = events.at(-1) as Extract<AgentEvent, { type: "tool.completed" }>;
  assert.equal(completed.type, "tool.completed");
  assert.equal(
    completed.data.status === "error" ? completed.data.error.code : undefined,
    "COMMAND_TIMEOUT",
  );
});

test("rejects extra stdout content as an invalid output", async () => {
  const hook = createHook(`echo '{"decision":"allow"} more'`);
  const { events, error } = await collect(hook, "done");

  assert.ok(error instanceof StopHookFailedError);
  assert.equal(error.code, STOP_HOOK_OUTPUT_INVALID);
  assert.match(error.message, /single JSON object/);
  assert.equal(events.at(-1)?.type, "tool.completed");
});

test("default executor denies without approval and fails the check", async () => {
  const hook = createHook(`echo '{"decision":"allow"}'`, {
    executor: new AuthorizedToolExecutor({
      policy: {
        evaluate: () => ({ effect: "confirm", ruleId: "confirm", reason: "needs approval" }),
        isVisible: () => true,
      },
    }),
  });
  const { error } = await collect(hook, "done");
  assert.ok(error instanceof StopHookFailedError);
  assert.equal(error.code, "TOOL_APPROVAL_DENIED");
});
