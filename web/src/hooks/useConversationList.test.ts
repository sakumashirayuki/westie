// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UNKNOWN_WORKSPACE_STATUS, type ConversationSummary } from "../run-client";
import { mergeConversationSummaries } from "./useConversationList";
import { useConversationRename } from "./useConversationRename";

function summary(
  id: string,
  updatedAt: string,
): ConversationSummary {
  return {
    id,
    revision: 1,
    executionMode: "workspace_sandbox",
    title: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    project: null,
    workspace: { name: id },
    archived: false,
  };
}

describe("mergeConversationSummaries", () => {
  it("keeps the list sorted by updatedAt desc, id desc", () => {
    const merged = mergeConversationSummaries(
      [summary("newer", "2026-02-02T00:00:00.000Z")],
      [
        summary("latest", "2026-03-03T00:00:00.000Z"),
        summary("older", "2026-01-01T00:00:00.000Z"),
      ],
    );
    expect(merged.map((s) => s.id)).toEqual([
      "latest",
      "newer",
      "older",
    ]);
  });

  it("does not move an upserted existing item to the head", () => {
    const existing = [
      summary("a", "2026-03-03T00:00:00.000Z"),
      summary("b", "2026-02-02T00:00:00.000Z"),
      summary("c", "2026-01-01T00:00:00.000Z"),
    ];
    // 点中 c 后 upsert 传入 c 的最新 summary；c 的 updatedAt 未变时仍应留在原位。
    const merged = mergeConversationSummaries(
      [summary("c", "2026-01-01T00:00:00.000Z")],
      existing,
    );
    expect(merged.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("re-orders an upserted item whose updatedAt has advanced", () => {
    const existing = [
      summary("a", "2026-03-03T00:00:00.000Z"),
      summary("b", "2026-02-02T00:00:00.000Z"),
    ];
    const merged = mergeConversationSummaries(
      [summary("b", "2026-04-04T00:00:00.000Z")],
      existing,
    );
    expect(merged.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("breaks tied updatedAt by id descending", () => {
    const timestamp = "2026-03-03T00:00:00.000Z";
    const merged = mergeConversationSummaries(
      [],
      [summary("a", timestamp), summary("b", timestamp)],
    );
    expect(merged.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("prefers the first-argument summary when both sides carry the same id", () => {
    const merged = mergeConversationSummaries(
      [summary("a", "2026-06-06T00:00:00.000Z")],
      [summary("a", "2026-01-01T00:00:00.000Z")],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].updatedAt).toBe("2026-06-06T00:00:00.000Z");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useConversationRename", () => {
  const conversation = summary("a", "2026-01-01T00:00:00.000Z");

  it("prefills the draft with the title, falling back to the workspace name", async () => {
    const { result } = renderHook(() =>
      useConversationRename({
        isBlocked: () => false,
        isRunActive: () => false,
        onRenamed: () => {},
        onMissing: vi.fn(),
      })
    );
    act(() => result.current.request(conversation));
    expect(result.current.state?.draft).toBe("a");

    act(() => result.current.cancel());
    act(() =>
      result.current.request({ ...conversation, title: "自定义标题" })
    );
    expect(result.current.state?.draft).toBe("自定义标题");
  });

  it("refuses to open for a running conversation", () => {
    const { result } = renderHook(() =>
      useConversationRename({
        isBlocked: () => false,
        isRunActive: () => true,
        onRenamed: () => {},
        onMissing: vi.fn(),
      })
    );
    act(() => result.current.request(conversation));
    expect(result.current.state?.error).toContain("正在运行");
  });

  it("submits the trimmed title and reports the renamed summary", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ ...conversation, title: "新标题" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
    );
    vi.stubGlobal("fetch", fetcher);
    const onRenamed = vi.fn();
    const { result } = renderHook(() =>
      useConversationRename({
        isBlocked: () => false,
        isRunActive: () => false,
        onRenamed,
        onMissing: vi.fn(),
      })
    );

    act(() => result.current.request(conversation));
    act(() => result.current.change("  新标题  "));
    await act(async () => {
      await result.current.submit();
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/v1/agent/conversations/a",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "新标题" }),
      }),
    );
    expect(onRenamed).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", title: "新标题" }),
    );
    expect(result.current.state).toBeNull();
  });

  it("clears the title when the draft is only whitespace", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ...conversation, title: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetcher);
    const onRenamed = vi.fn();
    const { result } = renderHook(() =>
      useConversationRename({
        isBlocked: () => false,
        isRunActive: () => false,
        onRenamed,
        onMissing: vi.fn(),
      })
    );

    act(() => result.current.request({ ...conversation, title: "旧标题" }));
    act(() => result.current.change("   "));
    await act(async () => {
      await result.current.submit();
    });

    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toBe(
      JSON.stringify({ title: null }),
    );
    expect(onRenamed).toHaveBeenCalledWith(
      expect.objectContaining({ title: null }),
    );
  });

  it("keeps the dialog open with a message when the server reports a busy conversation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "CONVERSATION_BUSY",
              message: "Conversation already has an active run.",
            },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        )
      ),
    );
    const onRenamed = vi.fn();
    const { result } = renderHook(() =>
      useConversationRename({
        isBlocked: () => false,
        isRunActive: () => false,
        onRenamed,
        onMissing: vi.fn(),
      })
    );

    act(() => result.current.request(conversation));
    act(() => result.current.change("新标题"));
    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.state?.status).toBe("editing");
    expect(result.current.state?.error).toContain("正在运行");
    expect(onRenamed).not.toHaveBeenCalled();
  });

  it("does not call the server when the title is unchanged", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() =>
      useConversationRename({
        isBlocked: () => false,
        isRunActive: () => false,
        onRenamed: () => {},
        onMissing: vi.fn(),
      })
    );

    act(() => result.current.request({ ...conversation, title: "同名" }));
    act(() => result.current.change("  同名  "));
    await act(async () => {
      await result.current.submit();
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.state).toBeNull();
  });

  it("does not call the server when an unnamed conversation keeps its workspace name", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() =>
      useConversationRename({
        isBlocked: () => false,
        isRunActive: () => false,
        onRenamed: () => {},
        onMissing: vi.fn(),
      })
    );

    act(() => result.current.request(conversation));
    await act(async () => {
      await result.current.submit();
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.state).toBeNull();
  });

  it("preserves a workspace name with surrounding spaces without sending a request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const spacedConversation = {
      ...conversation,
      project: null,
    workspaceStatus: UNKNOWN_WORKSPACE_STATUS,
    workspace: { ...conversation.workspace, name: "  a  " },
    };
    const { result } = renderHook(() =>
      useConversationRename({
        isBlocked: () => false,
        isRunActive: () => false,
        onRenamed: () => {},
        onMissing: vi.fn(),
      })
    );

    act(() => result.current.request(spacedConversation));
    expect(result.current.state?.draft).toBe("  a  ");
    await act(async () => {
      await result.current.submit();
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.state).toBeNull();
  });
});

describe("useConversationRename error handling", () => {
  const conversation = summary("a", "2026-01-01T00:00:00.000Z");

  it("keeps the dialog editable after an error so the user can retry", async () => {
    // 第一次 409，第二次成功：证明错误不锁死输入，重试能走通。
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: "CONVERSATION_BUSY",
                message: "Conversation already has an active run.",
              },
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ ...conversation, title: "第二次成功" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const onRenamed = vi.fn();
    const { result } = renderHook(() =>
      useConversationRename({
        isBlocked: () => false,
        isRunActive: () => false,
        onRenamed,
        onMissing: vi.fn(),
      })
    );

    act(() => result.current.request(conversation));
    act(() => result.current.change("第一次尝试"));
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.state?.error).toContain("正在运行");
    // 输入框仍可编辑，编辑会清掉错误提示。
    act(() => result.current.change("第二次尝试"));
    expect(result.current.state?.error).toBeUndefined();

    await act(async () => {
      await result.current.submit();
    });
    expect(onRenamed).toHaveBeenCalledWith(
      expect.objectContaining({ title: "第二次成功" }),
    );
    expect(result.current.state).toBeNull();
  });
});

describe("useConversationRename missing conversation", () => {
  it("drops the row when the server reports 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            error: {
              code: "CONVERSATION_NOT_FOUND",
              message: "Conversation not found.",
            },
          }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        )
      ),
    );
    const onRenamed = vi.fn();
    const onMissing = vi.fn();
    const { result } = renderHook(() =>
      useConversationRename({
        isBlocked: () => false,
        isRunActive: () => false,
        onRenamed,
        onMissing,
      })
    );

    act(() => result.current.request(summary("gone", "2026-01-01T00:00:00.000Z")));
    act(() => result.current.change("新标题"));
    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.state).toBeNull();
    expect(onMissing).toHaveBeenCalledWith("gone");
    expect(onRenamed).not.toHaveBeenCalled();
  });
});
