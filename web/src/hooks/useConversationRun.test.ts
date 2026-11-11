// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { useConversationRun } from "./useConversationRun";
import {
  cancelConversationRun,
  cancelSubAgentRun,
  HttpRunError,
  RunProtocolError,
  steerConversationRun,
  streamConversationRun,
  subscribeConversationRun,
  UNKNOWN_WORKSPACE_STATUS,
} from "../run-client";

vi.mock("../run-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../run-client")>();
  return {
    ...original,
    streamConversationRun: vi.fn(),
    subscribeConversationRun: vi.fn(),
    cancelConversationRun: vi.fn(),
    cancelSubAgentRun: vi.fn(),
    steerConversationRun: vi.fn(),
  };
});

const streamMock = vi.mocked(streamConversationRun);
const subscribeMock = vi.mocked(subscribeConversationRun);
const cancelMock = vi.mocked(cancelConversationRun);
const cancelChildMock = vi.mocked(cancelSubAgentRun);
const steerMock = vi.mocked(steerConversationRun);

const emptyUsage = {
  calls: 0,
  unmeasuredCalls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

function conversationWithRun(status: "running" | "completed") {
  return {
    id: "c1",
    revision: 0,
    executionMode: "workspace_sandbox" as const,
    title: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    workspace: { name: "p", canonicalPath: "/p" },
    project: null,
    workspaceStatus: UNKNOWN_WORKSPACE_STATUS,
    archived: false,
    usage: emptyUsage,
    turns: [{
      id: "turn-1",
      userMessage: "hi",
      status,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      runs: [{
        id: "run-1",
        attempt: 1,
        status,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        usage: emptyUsage,
        steeringMessages: [],
        subAgentRuns: [],
      }],
    }],
  };
}

type AgentEvent = {
  v: 1;
  runId: string;
  seq: number;
  type: string;
  step?: number;
  data: Record<string, unknown>;
};

function event(runId: string, seq: number, type: string, extra: Record<string, unknown> = {}): AgentEvent {
  return { v: 1, runId, seq, type, data: {}, ...extra };
}

beforeEach(() => {
  streamMock.mockReset();
  subscribeMock.mockReset();
  cancelMock.mockReset();
  cancelChildMock.mockReset();
  steerMock.mockReset();
});

type SubscribeOptions = Parameters<typeof subscribeConversationRun>[2];

/** 让 subscribeConversationRun 挂起，交出 onEvent 和结束/失败控制。 */
function pendingSubscription() {
  let options!: SubscribeOptions;
  let finish!: () => void;
  let fail!: (error: unknown) => void;
  const called = new Promise<void>((resolveCalled) => {
    subscribeMock.mockImplementationOnce((_conversationId, _runId, received) => {
      options = received;
      resolveCalled();
      return new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
    });
  });
  return {
    called,
    emit: (e: AgentEvent) => {
      options.onStreamSeq?.(e.seq);
      options.onEvent(e as never);
    },
    get after() {
      return options.after;
    },
    finish: () => finish(),
    fail: (error: unknown) => fail(error),
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const toolApproval = (seq: number) =>
  event("run-1", seq, "interaction.required", {
    step: 1,
    interactionId: "interaction-1",
    kind: "tool_approval",
    expiresAt: "2026-01-01T00:05:00.000Z",
    payload: {
      toolCallId: "tool-1",
      toolName: "bash",
      ruleId: "bash-confirm",
      argumentsDigest: "digest",
      argumentsSummary: { command: "pwd" },
      risk: "Runs a shell command.",
      impact: "Runs one command.",
    },
  });

describe("useConversationRun hydrate/resume", () => {
  it("hydrates a running turn as running (not error)", () => {
    const settled = vi.fn();
    const { result } = renderHook(() => useConversationRun(settled));
    act(() => result.current.hydrate(conversationWithRun("running")));
    expect(result.current.state.turns[0]?.run.status).toBe("running");
    expect(result.current.canSteer).toBe(false);
    expect(result.current.isActive()).toBe(false);
  });

  it("hydrates a completed turn as completed", () => {
    const settled = vi.fn();
    const { result } = renderHook(() => useConversationRun(settled));
    act(() => result.current.hydrate(conversationWithRun("completed")));
    expect(result.current.state.turns[0]?.run.status).toBe("completed");
  });
});

describe("useConversationRun stop", () => {
  it("clears stopping when run.cancelled arrives", async () => {
    // streamConversationRun 挂起不结束，捕获 onEvent。
    let capturedOnEvent: ((event: AgentEvent) => void) | undefined;
    streamMock.mockImplementation(async (_id, _req, options) => {
      capturedOnEvent = options.onEvent as (event: AgentEvent) => void;
    });
    cancelMock.mockResolvedValue({ runId: "run-1", status: "cancelling" });

    const settled = vi.fn();
    const { result } = renderHook(() => useConversationRun(settled));

    act(() => result.current.setInput("hi"));
    act(() => result.current.start("c1", false));

    // 等 streamConversationRun 被调用并捕获 onEvent（start 是异步启动的）。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(capturedOnEvent).toBeDefined();

    // 模拟 run.started 以建立 runId。
    act(() => capturedOnEvent!(event("run-1", 1, "run.started")));

    // 点停止：应调用 cancel，且不 abort 事件流。
    act(() => result.current.stop());
    expect(cancelMock).toHaveBeenCalledWith("c1", "run-1");
    expect(result.current.isStopping).toBe(true);

    // run.cancelled 到达 → stopping 清除，回到可发送状态。
    act(() => capturedOnEvent!(event("run-1", 2, "run.cancelled")));
    expect(result.current.isStopping).toBe(false);
  });

  it("clears stopping via hydrate after switching conversation", async () => {
    let capturedOnEvent: ((event: AgentEvent) => void) | undefined;
    streamMock.mockImplementation(async (_id, _req, options) => {
      capturedOnEvent = options.onEvent as (event: AgentEvent) => void;
    });
    cancelMock.mockResolvedValue({ runId: "run-1", status: "cancelling" });

    const settled = vi.fn();
    const { result } = renderHook(() => useConversationRun(settled));

    act(() => result.current.setInput("hi"));
    act(() => result.current.start("c1", false));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => capturedOnEvent!(event("run-1", 1, "run.started")));

    act(() => result.current.stop());
    expect(result.current.isStopping).toBe(true);

    // 切换会话 → hydrate 清除 stopping。
    act(() => result.current.hydrate(conversationWithRun("completed")));
    expect(result.current.isStopping).toBe(false);
  });

  it("allows retry after a failed child stop request", async () => {
    let capturedOnEvent!: (event: AgentEvent) => void;
    streamMock.mockImplementation(async (_id, _request, options) => {
      capturedOnEvent = options.onEvent as (event: AgentEvent) => void;
    });
    cancelMock.mockRejectedValueOnce(new Error("network"));
    const { result } = renderHook(() => useConversationRun(vi.fn()));
    act(() => result.current.setInput("hi"));
    act(() => result.current.start("c1", false));
    await flush();
    act(() => capturedOnEvent(event("run-1", 1, "run.started")));
    act(() => result.current.stop());
    await flush();
    expect(result.current.isStopping).toBe(false);
  });
});

describe("useConversationRun reconnect", () => {
  it("resubscribes after the last seen seq when the start stream breaks", async () => {
    let startOptions!: Parameters<typeof streamConversationRun>[2];
    let breakStream!: (error: unknown) => void;
    streamMock.mockImplementation((_id, _req, options) => {
      startOptions = options;
      return new Promise<void>((_, reject) => {
        breakStream = reject;
      });
    });
    const resumed = pendingSubscription();
    const { result } = renderHook(() => useConversationRun(vi.fn()));

    act(() => result.current.setInput("hi"));
    act(() => result.current.start("c1", false));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    act(() => {
      startOptions.onRunId?.("run-1");
      startOptions.onStreamSeq?.(1);
      startOptions.onEvent(event("run-1", 1, "run.started") as never);
      startOptions.onStreamSeq?.(2);
      startOptions.onEvent(event("run-1", 2, "step.started", { step: 1 }) as never);
    });

    // 网络断开：不是 abort，也不是终态。
    await act(async () => {
      breakStream(new RunProtocolError("stream broke"));
    });
    await resumed.called;
    expect(subscribeMock).toHaveBeenCalledWith("c1", "run-1", expect.anything());
    expect(resumed.after).toBe(2);
    expect(result.current.isActive()).toBe(true);

    act(() => resumed.emit(event("run-1", 3, "run.completed", {
      data: { answer: "done" },
    })));
    await act(async () => resumed.finish());
    expect(result.current.isActive()).toBe(false);
    expect(result.current.state.turns[0]?.run.status).toBe("completed");
  });
});

describe("useConversationRun resume", () => {
  it("replays a running run from seq 0 and allows approval and steering", async () => {
    const replay = pendingSubscription();
    steerMock.mockResolvedValue({ runId: "run-1", seq: 0 });
    const { result } = renderHook(() => useConversationRun(vi.fn()));

    act(() => result.current.hydrate(conversationWithRun("running")));
    act(() => result.current.resume("c1", "turn-1", "run-1"));
    await replay.called;
    expect(replay.after).toBe(0);

    act(() => {
      replay.emit(event("run-1", 1, "run.started"));
      replay.emit(event("run-1", 2, "step.started", { step: 1 }));
      replay.emit(toolApproval(3));
    });

    expect(result.current.status).toBe("running");
    expect(result.current.canSteer).toBe(true);
    expect(result.current.pendingInteractions).toHaveLength(1);
    expect(result.current.pendingInteractions[0]).toMatchObject({
      interactionId: "interaction-1",
    });

    act(() => result.current.setInput("also check tests"));
    await act(async () => {
      await result.current.steer();
    });
    expect(steerMock.mock.calls[0]?.slice(0, 2)).toEqual([
      "c1",
      { runId: "run-1", input: "also check tests" },
    ]);
  });

  it("falls back to snapshot=1 when the run is no longer replayable", async () => {
    subscribeMock.mockRejectedValueOnce(
      new HttpRunError(
        410,
        "The run's event stream cannot be replayed.",
        "RUN_STREAM_NOT_REPLAYABLE",
      ),
    );
    subscribeMock.mockImplementationOnce((_conversationId, _runId, options) => {
      expect(options.snapshot).toBe(true);
      return new Promise<void>((resolve) => {
        options.onSnapshot?.({ status: "running", waitingForSubAgents: true, children: [], pendingInteractions: [] });
        resolve();
      });
    });
    const { result } = renderHook(() => useConversationRun(vi.fn()));

    act(() => result.current.hydrate(conversationWithRun("running")));
    act(() => result.current.resume("c1", "turn-1", "run-1"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    expect(subscribeMock).toHaveBeenCalledTimes(2);
    expect(result.current.state.turns[0]?.run.status).toBe("running");
  });
});

describe.each(["reconnect", "resume"] as const)("useConversationRun %s snapshot failure", (entry) => {
  async function startRun() {
    const settled = vi.fn();
    const { result } = renderHook(() => useConversationRun(settled));
    if (entry === "reconnect") {
      streamMock.mockImplementationOnce(async (_id, _request, options) => {
        options.onRunId?.("run-1");
        options.onStreamSeq?.(1);
        options.onEvent(event("run-1", 1, "run.started") as never);
        throw new TypeError("Connection lost.");
      });
      act(() => result.current.setInput("hi"));
      await act(async () => result.current.start("c1", false));
    } else {
      act(() => result.current.hydrate(conversationWithRun("running")));
      await act(async () => result.current.resume("c1", "turn-1", "run-1"));
    }
    return { result, settled };
  }

  beforeEach(() => {
    subscribeMock.mockRejectedValueOnce(
      new HttpRunError(410, "History unavailable.", "RUN_STREAM_NOT_REPLAYABLE"),
    );
  });

  it("retries a broken snapshot stream using its latest cursor", async () => {
    vi.useFakeTimers();
    try {
      const snapshot = pendingSubscription();
      const recovered = pendingSubscription();
      const { result, settled } = await startRun();
      const options = subscribeMock.mock.calls[1]![2];
      expect(options.snapshot).toBe(true);
      act(() => {
        options.onStreamSeq?.(25);
        options.onSnapshot?.({ status: "running", waitingForSubAgents: true, children: [], pendingInteractions: [] });
      });
      await act(async () => snapshot.fail(new TypeError("Snapshot connection lost.")));
      expect(result.current.isActive()).toBe(true);
      expect(result.current.state.turns[0]?.run.error).toBeUndefined();
      expect(settled).not.toHaveBeenCalled();
      if (entry === "reconnect") {
        await act(async () => vi.advanceTimersByTimeAsync(499));
        expect(subscribeMock).toHaveBeenCalledTimes(2);
        await act(async () => vi.advanceTimersByTimeAsync(1));
      }
      expect(subscribeMock).toHaveBeenCalledTimes(3);
      expect(recovered.after).toBe(25);

      await act(async () => {
        recovered.emit(event("run-1", 26, "run.completed"));
        recovered.finish();
      });
      expect(result.current.state.turns[0]?.run.status).toBe("completed");
      expect(result.current.isActive()).toBe(false);
      expect(settled).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the snapshot's terminal HTTP error without retrying", async () => {
    subscribeMock.mockRejectedValueOnce(
      new HttpRunError(410, "The run has already ended.", "RUN_STREAM_ENDED"),
    );
    const { result, settled } = await startRun();
    expect(subscribeMock).toHaveBeenCalledTimes(2);
    expect(result.current.state.turns[0]?.run.error).toEqual({
      kind: "run", code: "RUN_STREAM_ENDED", message: "The run has already ended.",
    });
    expect(result.current.isActive()).toBe(false);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("leaves the new conversation active when the old snapshot is aborted", async () => {
    const snapshot = pendingSubscription();
    const { result, settled } = await startRun();
    const signal = subscribeMock.mock.calls[1]![2].signal;
    const nextConversation = conversationWithRun("running");
    nextConversation.id = "c2";
    nextConversation.turns[0]!.id = "turn-2";
    nextConversation.turns[0]!.runs[0]!.id = "run-2";
    const nextRun = pendingSubscription();
    act(() => {
      result.current.hydrate(nextConversation);
      result.current.resume("c2", "turn-2", "run-2");
    });
    expect(signal.aborted).toBe(true);
    await act(async () => snapshot.fail(new DOMException("Aborted", "AbortError")));
    expect(subscribeMock).toHaveBeenCalledTimes(3);
    expect(result.current.isActive()).toBe(true);
    expect(result.current.state.turns[0]?.run.status).toBe("running");
    expect(settled).not.toHaveBeenCalled();
    await act(async () => {
      nextRun.emit(event("run-2", 1, "run.completed"));
      nextRun.finish();
    });
  });
});
