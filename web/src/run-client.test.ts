import { describe, expect, it, vi } from "vitest";

import { emptyRunUsageTotals } from "./events";

import {
  AgentRunError,
  deleteConversation,
  getConversation,
  HttpRunError,
  listConversations,
  RunProtocolError,
  respondToInteraction,
  selectWorkspaceFile,
  streamConversationRun,
} from "./run-client";

const encoder = new TextEncoder();

function sseResponse(frames: string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
  );
}

function event(type: string, seq: number, data: object, step?: number) {
  return { streamSeq: seq, event: { v: 1, runId: "run-1", seq, type, ...(step === undefined ? {} : { step }), data } };
}

describe("streamConversationRun", () => {
  it("delivers answer.delta events to the caller", async () => {
    const seen: Array<{ type: string; text?: string }> = [];
    const frames = [
      event("run.started", 1, {}),
      event("answer.delta", 2, { text: "Hello" }, 1),
      event("answer.completed", 3, { answer: "Hello" }, 1),
      event("run.completed", 4, { steps: 1, stopReason: "final", usage: emptyUsage() }),
    ].map((value) => `event: ${value.event.type}\ndata: ${JSON.stringify(value)}\n\n`);
    const fetcher = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => sseResponse(frames));

    await streamConversationRun(
      "conversation-1",
      { input: "hello" },
      {
        signal: new AbortController().signal,
        fetch: fetcher,
        onEvent: (value) => seen.push({
          type: value.type,
          text: value.type === "answer.delta" ? value.data.text : undefined,
        }),
      },
    );

    expect(seen).toContainEqual({ type: "answer.delta", text: "Hello" });
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({
      input: "hello",
    }));
  });

  it.each([
    event("answer.delta", 1, { text: 42 }, 1),
    event("answer.completed", 1, { answer: null }, 1),
  ])("rejects non-string answer event fields", async (invalidEvent) => {
    await expect(streamConversationRun(
      "conversation-1",
      { input: "hello" },
      {
        signal: new AbortController().signal,
        fetch: vi.fn(async () => sseResponse([
          `data: ${JSON.stringify({ streamSeq: 1, event: invalidEvent })}\n\n`,
        ])),
        onEvent: vi.fn(),
      },
    )).rejects.toBeInstanceOf(RunProtocolError);
  });

  it("streams events and accepts a terminal run.completed", async () => {
    const seen: string[] = [];
    const frames = [
      event("run.started", 1, {}),
      event("run.completed", 2, { steps: 0, stopReason: "final", usage: emptyUsage() }),
    ].map((value) => `event: ${value.event.type}\ndata: ${JSON.stringify(value)}\n\n`);

    await streamConversationRun(
      "conversation-1",
      { input: "hello" },
      {
        signal: new AbortController().signal,
        fetch: vi.fn(async () => sseResponse(frames)),
        onEvent: (value) => seen.push(value.type),
      },
    );
    expect(seen).toEqual(["run.started", "run.completed"]);
  });

  it("reports structured HTTP errors", async () => {
    const promise = streamConversationRun(
      "conversation-1",
      { input: "hello" },
      {
        signal: new AbortController().signal,
        fetch: vi.fn(async () => new Response(
          JSON.stringify({ error: { code: "INVALID_REQUEST", message: "Bad input." } }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        )),
        onEvent: vi.fn(),
      },
    );
    await expect(promise).rejects.toMatchObject({
      name: "HttpRunError",
      status: 422,
      code: "INVALID_REQUEST",
      message: "Bad input.",
    });
  });

  it("distinguishes run.error from transport failures", async () => {
    const failure = event("run.error", 1, { code: "MODEL_FAILED", message: "Model failed.", usage: emptyUsage() });
    await expect(streamConversationRun(
      "conversation-1",
      { input: "hello" },
      {
        signal: new AbortController().signal,
        fetch: vi.fn(async () => sseResponse([`data: ${JSON.stringify(failure)}\n\n`])),
        onEvent: vi.fn(),
      },
    )).rejects.toBeInstanceOf(AgentRunError);
  });

  it("rejects unexpected EOF before a terminal event", async () => {
    const started = event("run.started", 1, {});
    await expect(streamConversationRun(
      "conversation-1",
      { input: "hello" },
      {
        signal: new AbortController().signal,
        fetch: vi.fn(async () => sseResponse([`data: ${JSON.stringify(started)}\n\n`])),
        onEvent: vi.fn(),
      },
    )).rejects.toEqual(new RunProtocolError("事件流在运行结束前意外断开。"));
  });

  it("rejects events from different runs in one stream", async () => {
    const started = event("run.started", 1, {});
    const completed = { ...event("run.completed", 2, { steps: 0, stopReason: "final", usage: emptyUsage() }), event: { ...event("run.completed", 2, { steps: 0, stopReason: "final", usage: emptyUsage() }).event, runId: "run-2" } };
    await expect(streamConversationRun(
      "conversation-1",
      { input: "hello" },
      {
        signal: new AbortController().signal,
        fetch: vi.fn(async () => sseResponse([
          `data: ${JSON.stringify(started)}\n\n`,
          `data: ${JSON.stringify(completed)}\n\n`,
        ])),
        onEvent: vi.fn(),
      },
    )).rejects.toEqual(new RunProtocolError("父事件流中的 runId 与请求不一致。"));
  });

  it("rejects non-contiguous event sequence numbers", async () => {
    const started = event("run.started", 1, {});
    const completed = event("run.completed", 3, { steps: 0, stopReason: "final", usage: emptyUsage() });
    await expect(streamConversationRun(
      "conversation-1",
      { input: "hello" },
      {
        signal: new AbortController().signal,
        fetch: vi.fn(async () => sseResponse([
          `data: ${JSON.stringify(started)}\n\n`,
          `data: ${JSON.stringify(completed)}\n\n`,
        ])),
        onEvent: vi.fn(),
      },
    )).rejects.toEqual(new RunProtocolError("事件 streamSeq 不是严格连续递增的。"));
  });
});

describe("conversation client", () => {
  it("deletes a conversation through its encoded detail route", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));

    await deleteConversation("conversation/1", { fetch: fetcher });

    expect(fetcher).toHaveBeenCalledWith(
      "/v1/agent/conversations/conversation%2F1",
      { method: "DELETE", signal: undefined },
    );
  });

  it("preserves structured conversation deletion errors", async () => {
    const promise = deleteConversation("conversation-1", {
      fetch: vi.fn(async () => new Response(JSON.stringify({
        error: {
          code: "CONVERSATION_BUSY",
          message: "Conversation already has an active run.",
        },
      }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      })),
    });

    await expect(promise).rejects.toMatchObject({
      name: "HttpRunError",
      status: 409,
      code: "CONVERSATION_BUSY",
    });
  });

  it("lists conversations with an encoded cursor and loads full detail", async () => {
    const summary = {
      id: "conversation/1",
      revision: 2,
      executionMode: "workspace_sandbox",
      title: null,
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T01:00:00.000Z",
      workspace: {
        name: "project",
        canonicalPath: "/Users/example/project",
      },
      project: {
        key: "git:/Users/example/project/.git",
        root: "/Users/example/project",
        name: "project",
      },
      workspaceStatus: {
        kind: "main",
        branch: { status: "branch", name: "main" },
        availability: { status: "available" },
      },
      archived: false,
    };
    const detail = {
      ...summary,
      usage: emptyRunUsageTotals(),
      turns: [{
        id: "turn-1",
        userMessage: "Question",
        status: "failed",
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        runs: [{
          id: "run-1",
          attempt: 1,
          status: "failed",
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          error: { code: "MODEL_FAILED", message: "Model failed." },
          usage: emptyUsage(),
          steeringMessages: [{ seq: 3, content: "先跑测试" }],
          subAgentRuns: [{
            id: "child-1",
            toolCallId: "call-agent",
            description: "查错误码",
            status: "completed",
            finalAnswer: "共 3 处。",
            usage: emptyUsage(),
            messageCount: 4,
            createdAt: summary.createdAt,
            updatedAt: summary.updatedAt,
          }],
        }],
      }],
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{
          id: summary.id,
          revision: summary.revision,
          executionMode: summary.executionMode,
          title: summary.title,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          workspace: { name: summary.workspace.name },
          project: summary.project,
          archived: false,
        }],
        nextCursor: "next/cursor",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(detail), {
        status: 200,
      }));

    await expect(listConversations({
      cursor: "page/one",
      fetch: fetcher,
    })).resolves.toEqual({
      items: [{
        id: summary.id,
        revision: summary.revision,
        executionMode: summary.executionMode,
        title: summary.title,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        workspace: { name: summary.workspace.name },
        project: summary.project,
        archived: false,
      }],
      nextCursor: "next/cursor",
    });
    await expect(getConversation("conversation/1", { fetch: fetcher }))
      .resolves.toEqual(detail);

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "/v1/agent/conversations?cursor=page%2Fone",
    );
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "/v1/agent/conversations/conversation%2F1",
    );
  });

  it("rejects malformed conversation pages and detail runs", async () => {
    await expect(listConversations({
      fetch: vi.fn(async () => new Response(JSON.stringify({
        items: [],
        nextCursor: 42,
      }), { status: 200 })),
    })).rejects.toEqual(
      new RunProtocolError("服务端返回了无效的会话列表。"),
    );

    await expect(getConversation("conversation-1", {
      fetch: vi.fn(async () => new Response(JSON.stringify({
        id: "conversation-1",
        revision: 0,
        executionMode: "workspace_sandbox",
        title: null,
        createdAt: "2026-07-23T00:00:00.000Z",
        updatedAt: "2026-07-23T00:00:00.000Z",
        workspace: {
          name: "project",
          canonicalPath: "/Users/example/project",
        },
        usage: emptyRunUsageTotals(),
        turns: [{
          id: "turn-1",
          userMessage: "Question",
          status: "completed",
          createdAt: "2026-07-23T00:00:00.000Z",
          updatedAt: "2026-07-23T00:00:00.000Z",
          runs: [{ id: "run-1", attempt: 0, status: "completed" }],
        }],
      }), { status: 200 })),
    })).rejects.toEqual(
      new RunProtocolError("服务端返回了无效的会话数据。"),
    );
  });

  it("rejects malformed persisted run errors", async () => {
    await expect(getConversation("conversation-1", {
      fetch: vi.fn(async () => new Response(JSON.stringify({
        id: "conversation-1",
        revision: 0,
        executionMode: "workspace_sandbox",
        title: null,
        createdAt: "2026-07-23T00:00:00.000Z",
        updatedAt: "2026-07-23T00:00:00.000Z",
        workspace: {
          name: "project",
          canonicalPath: "/Users/example/project",
        },
        usage: emptyRunUsageTotals(),
        turns: [{
          id: "turn-1",
          userMessage: "Question",
          status: "failed",
          createdAt: "2026-07-23T00:00:00.000Z",
          updatedAt: "2026-07-23T00:00:00.000Z",
          runs: [{
            id: "run-1",
            attempt: 1,
            status: "failed",
            createdAt: "2026-07-23T00:00:00.000Z",
            updatedAt: "2026-07-23T00:00:00.000Z",
            error: { code: 42, message: "Model failed." },
          }],
        }],
      }), { status: 200 })),
    })).rejects.toEqual(
      new RunProtocolError("服务端返回了无效的会话数据。"),
    );
  });

  it.each([undefined, null, "dangerous"])(
    "rejects the required execution mode %s",
    async (executionMode) => {
      const body = {
        id: "conversation-1",
        revision: 0,
        ...(executionMode === undefined ? {} : { executionMode }),
        createdAt: "2026-07-23T00:00:00.000Z",
        updatedAt: "2026-07-23T00:00:00.000Z",
        workspace: {
          name: "project",
          canonicalPath: "/Users/example/project",
        },
        usage: emptyRunUsageTotals(),
        turns: [],
      };

      await expect(getConversation("conversation-1", {
        fetch: vi.fn(async () => new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })),
      })).rejects.toEqual(
        new RunProtocolError("服务端返回了无效的会话数据。"),
      );
    },
  );
});

describe("interaction client", () => {
  it.each(["approve", "deny"] as const)(
    "posts a %s decision to the encoded interaction route",
    async (decision) => {
      const fetcher = vi.fn(async () =>
        new Response(JSON.stringify({ status: "accepted" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await respondToInteraction("interaction/1", decision, { fetch: fetcher });

      expect(fetcher).toHaveBeenCalledWith(
        "/v1/agent/interactions/interaction%2F1:respond",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ response: { decision } }),
        }),
      );
    },
  );

  it("preserves structured response conflicts", async () => {
    const promise = respondToInteraction("interaction-1", "approve", {
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({
          error: {
            code: "INTERACTION_RESPONSE_CONFLICT",
            message: "Already resolved.",
          },
        }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    });

    await expect(promise).rejects.toMatchObject({
      name: "HttpRunError",
      status: 409,
      code: "INTERACTION_RESPONSE_CONFLICT",
    });
  });

  it("opens the host file picker without sending a browser path", async () => {
    const fetcher = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) =>
      new Response(JSON.stringify({
        interactionId: "interaction/1",
        status: "accepted",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await selectWorkspaceFile("interaction/1", { fetch: fetcher });

    expect(fetcher).toHaveBeenCalledWith(
      "/v1/agent/interactions/interaction%2F1:select-file",
      {
        method: "POST",
        signal: undefined,
      },
    );
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty("body");
  });

  it.each([
    "HOST_FILE_PICKER_CANCELLED",
    "WORKSPACE_GRANT_SELECTION_MISMATCH",
  ])("preserves retryable picker error %s", async (code) => {
    const promise = selectWorkspaceFile("interaction-1", {
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({
          error: {
            code,
            message: "Selection was not accepted.",
            retryable: true,
          },
        }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    });

    await expect(promise).rejects.toMatchObject({
      name: "HttpRunError",
      status: 409,
      code,
    });
  });
});

function emptyUsage() {
  return {
    calls: 0,
    unmeasuredCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}
