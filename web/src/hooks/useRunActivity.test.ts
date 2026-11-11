// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useRunActivity } from "./useRunActivity";

const encoder = new TextEncoder();

function streamOf(frames: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      // 保持不关闭，模拟长连接，直到 abort。
    },
  });
}

describe("useRunActivity SSE integration", () => {
  it("replaces the table from snapshot and applies run.state updates and removal", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        streamOf([
          `event: snapshot\ndata: ${JSON.stringify({ runs: [
            { conversationId: "c1", runId: "r1", state: "running", startedAt: "2026-01-01T00:00:00.000Z" },
            { conversationId: "c2", runId: "r2", state: "awaiting_interaction", startedAt: "2026-01-01T00:00:00.000Z" },
          ] })}\n\n`,
          `event: run.state\ndata: ${JSON.stringify({ conversationId: "c1", runId: "r1", state: "ended", status: "completed" })}\n\n`,
        ]),
        { headers: { "Content-Type": "text/event-stream" } }
      )
    );

    const { result, unmount } = renderHook(() => useRunActivity({ fetch: fetcher }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // snapshot 先替换整表（c1、c2），随后 run.state ended 移除 c1，最终只剩 c2。
    expect(result.current.activities.get("c2")).toEqual({ runId: "r2", state: "awaiting_interaction" });
    expect(result.current.activities.has("c1")).toBe(false);
    expect(result.current.activities.size).toBe(1);

    unmount();
  });

  it("reconnects and replaces the table from the new snapshot", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        // 第一段连接建立后立即抛错（模拟网络断开），触发重连。
        throw new Error("connection reset");
      }
      // 第二段（重连）：新的 snapshot。
      return new Response(
        streamOf([
          `event: snapshot\ndata: ${JSON.stringify({ runs: [
            { conversationId: "c9", runId: "r9", state: "running", startedAt: "y" },
          ] })}\n\n`,
        ]),
        { headers: { "Content-Type": "text/event-stream" } }
      );
    });

    const { result, unmount } = renderHook(() => useRunActivity({ fetch: fetcher }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });

    // 重连后整表被新 snapshot 替换。
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.activities.get("c9")).toEqual({ runId: "r9", state: "running" });

    unmount();
  });

  it("shows waiting_sub_agents in the sidebar activity", async () => {
    const fetcher = vi.fn(async () => new Response(streamOf([
      `event: snapshot\ndata: ${JSON.stringify({ runs: [{ conversationId: "c1", runId: "r1", state: "waiting_sub_agents", startedAt: "now" }] })}\n\n`,
    ]), { headers: { "Content-Type": "text/event-stream" } }));
    const { result, unmount } = renderHook(() => useRunActivity({ fetch: fetcher }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(result.current.activities.get("c1")?.state).toBe("waiting_sub_agents");
    unmount();
  });
});
