import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test as base, expect } from "@playwright/test";
import { initializeSqliteSchema, openSqliteDatabase, SQLiteConversationStore } from "../src/infrastructure/sqlite/index.js";
import { startAgentServer, type RunningAgentServer } from "../src/server-bootstrap.js";
import { installDeepSeekFetchInterceptor, startDeepSeekModelMock, type DeepSeekModelMock, type ModelMockResponse } from "./model-mock.js";

type Session = {
  url: string;
  conversationId: string;
  workspacePath: string;
  resumeResponse(): void;
};

type TestSession = {
  prepare(options: { responses: readonly ModelMockResponse[]; workspace?: "shared" | "isolated" }): Promise<Session>;
};

type Worker = {
  server: RunningAgentServer;
  model: DeepSeekModelMock;
  root: string;
};

export const test = base.extend<{ testSession: TestSession }, Worker>({
  root: [async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), "my-agent-harness-e2e-"));
    try {
      await mkdir(join(root, "home"));
      await mkdir(join(root, "workspace"));
      await use(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, { scope: "worker" }],

  model: [async ({}, use) => {
    const model = await startDeepSeekModelMock();
    const restoreFetch = installDeepSeekFetchInterceptor(model.baseURL);
    try {
      await use(model);
    } finally {
      restoreFetch();
      await model[Symbol.asyncDispose]();
    }
  }, { scope: "worker" }],

  server: [async ({ root, model }, use) => {
    void model;
    const env = {
      AGENT_DATABASE_PATH: join(root, "agent.sqlite"),
      AGENT_MODEL_CONTEXT_TOKENS: "32768",
      AGENT_MODEL_MAX_OUTPUT_TOKENS: "4096",
      DEEPSEEK_API_KEY: "e2e-test-key",
      DEEPSEEK_MODEL: "deepseek-e2e",
      HOME: join(root, "home"),
      HOST: "127.0.0.1",
      LLM_PROVIDER: "deepseek",
      TAVILY_API_KEY: "e2e-test-key",
    };
    const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    let server: RunningAgentServer | undefined;
    try {
      server = await startAgentServer({
        port: 0,
        sandboxRunnerFactory: async () => ({
          async run() { throw new Error("E2E sandbox runner does not execute commands"); },
        }),
        worktreeRoot: join(root, "worktrees"),
      });
      await use(server);
    } finally {
      try {
        await server?.close();
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
  }, { scope: "worker", timeout: 30_000 }],

  testSession: async ({ server, model, root }, use) => {
    let session: Session | undefined;
    let isolatedPath: string | undefined;
    try {
      await use({
        async prepare({ responses, workspace = "shared" }) {
          if (session) throw new Error("Only one session may be prepared per test");
          if ((await activeRuns(server.url)).length) throw new Error("A previous run is still active");
          const list = await fetch(`${server.url}/v1/agent/conversations`);
          const body = await list.json() as { items: unknown[] };
          if (!list.ok || body.items.length) throw new Error("A previous session remains");
          isolatedPath = workspace === "isolated" ? await mkdtemp(join(root, "workspace-")) : undefined;
          const workspacePath = await realpath(isolatedPath ?? join(root, "workspace"));
          const database = openSqliteDatabase(join(root, "agent.sqlite"));
          try {
            initializeSqliteSchema(database);
            const conversation = new SQLiteConversationStore(database).createConversation(workspacePath, "workspace_sandbox");
            session = { url: server.url, conversationId: conversation.id, workspacePath, resumeResponse: () => model.resume() };
          } finally {
            database.close();
          }
          model.setResponses(responses);
          return session;
        },
      });
    } finally {
      model.resume();
      if (session) {
        const url = `${server.url}/v1/agent/conversations/${encodeURIComponent(session.conversationId)}`;
        const runs = await activeRuns(server.url);
        for (const run of runs.filter((item) => item.conversationId === session!.conversationId)) {
          await fetch(`${url}/runs/${encodeURIComponent(run.runId)}:cancel`, { method: "POST" });
        }
        const deadline = Date.now() + 10_000;
        while ((await activeRuns(server.url)).some((run) => run.conversationId === session!.conversationId)) {
          if (Date.now() >= deadline) throw new Error("Run did not stop during E2E cleanup");
          await delay(50);
        }
        const removed = await fetch(url, { method: "DELETE" });
        if (!removed.ok) throw new Error(`Failed to delete E2E conversation: ${removed.status}`);
        const detail = await fetch(url);
        if (detail.status !== 404) throw new Error("E2E conversation remains after cleanup");
      }
      model.setResponses([]);
      if (isolatedPath) await rm(isolatedPath, { recursive: true, force: true });
    }
  },
});

async function activeRuns(url: string): Promise<Array<{ conversationId: string; runId: string }>> {
  const controller = new AbortController();
  try {
    const response = await fetch(`${url}/v1/agent/runs:watch`, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error("Could not read active runs");
    const reader = response.body.getReader();
    let text = "";
    while (!text.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Run activity stream ended before snapshot");
      text += new TextDecoder().decode(chunk.value);
    }
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    if (!data) throw new Error("Run activity snapshot is missing");
    return (JSON.parse(data.slice(6)) as { runs: Array<{ conversationId: string; runId: string }> }).runs;
  } finally {
    controller.abort();
  }
}

// 原样转出官方 expect：让用例统一从本文件导入 test 与 expect；
// 后续若用 expect.extend 注册自定义匹配器，spec 的导入路径无需改动。
export { expect };
