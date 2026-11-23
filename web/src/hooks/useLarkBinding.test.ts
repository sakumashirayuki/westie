// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getLarkBinding,
  getLarkCapability,
  issueLarkBindingCode,
  unbindLarkChat,
  type ConversationSummary,
  type IssuedLarkBindingCode,
  type LarkBindingStatus,
} from "../run-client";
import { useLarkBinding } from "./useLarkBinding";

vi.mock("../run-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../run-client")>();
  return {
    ...original,
    getLarkCapability: vi.fn(),
    getLarkBinding: vi.fn(),
    issueLarkBindingCode: vi.fn(),
    unbindLarkChat: vi.fn(),
  };
});

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
const FUTURE_EXPIRES_AT = "2026-01-01T00:10:00.000Z";
const ISSUED_CODE: IssuedLarkBindingCode = {
  code: "WST-ABCDEF",
  expiresAt: FUTURE_EXPIRES_AT,
};

function conversation(id: string): ConversationSummary {
  return {
    id,
    revision: 0,
    executionMode: "workspace_sandbox",
    title: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    workspace: { name: id },
    project: null,
    archived: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLarkCapability).mockResolvedValue({ enabled: true });
  vi.mocked(getLarkBinding).mockResolvedValue({ bound: false });
  vi.mocked(issueLarkBindingCode).mockResolvedValue(ISSUED_CODE);
  vi.mocked(unbindLarkChat).mockResolvedValue(undefined);
});

describe("useLarkBinding generation guard", () => {
  it("drops a stale binding response after switching the dialog target", async () => {
    const first = deferred<LarkBindingStatus>();
    const second = deferred<LarkBindingStatus>();
    vi.mocked(getLarkBinding)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { result } = renderHook(() => useLarkBinding());

    act(() => result.current.open(conversation("a")));
    act(() => result.current.open(conversation("b")));

    await act(async () => {
      first.resolve({ bound: false });
      await first.promise;
      await Promise.resolve();
    });
    // A 的迟到响应不得落地，弹窗仍停在第二次打开的 loading 态。
    expect(result.current.target?.id).toBe("b");
    expect(result.current.state.status).toBe("loading");

    await act(async () => {
      second.resolve({
        bound: true,
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      await second.promise;
      await Promise.resolve();
    });
    expect(result.current.state.status).toBe("bound");
  });

  it("ignores an in-flight binding read when the dialog is closed first", async () => {
    const pending = deferred<LarkBindingStatus>();
    vi.mocked(getLarkBinding).mockImplementation(() => pending.promise);
    const { result } = renderHook(() => useLarkBinding());

    act(() => result.current.open(conversation("a")));
    act(() => result.current.close());

    await act(async () => {
      pending.resolve({ bound: true });
      await pending.promise;
      await Promise.resolve();
    });
    expect(result.current.target).toBeNull();
    expect(result.current.state.status).toBe("loading");
  });

  it("does not apply an issue result after the dialog is closed", async () => {
    const issue = deferred<IssuedLarkBindingCode>();
    vi.mocked(issueLarkBindingCode).mockImplementation(() => issue.promise);
    const { result } = renderHook(() => useLarkBinding());

    act(() => result.current.open(conversation("a")));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.state.status).toBe("unbound");

    act(() => {
      void result.current.issue();
    });
    expect(result.current.state.status).toBe("submitting");
    act(() => result.current.close());

    await act(async () => {
      issue.resolve(ISSUED_CODE);
      await issue.promise;
      await Promise.resolve();
    });
    expect(result.current.state.status).toBe("loading");
  });
});

describe("useLarkBinding binding change callback", () => {
  it("reports unbind success through onBindingChange and returns to unbound", async () => {
    vi.mocked(getLarkBinding).mockResolvedValue({
      bound: true,
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    const onBindingChange = vi.fn();
    const { result } = renderHook(() =>
      useLarkBinding({ onBindingChange }),
    );

    act(() => result.current.open(conversation("a")));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.state.status).toBe("bound");

    await act(async () => {
      await result.current.unbind();
    });
    expect(result.current.state.status).toBe("unbound");
    expect(onBindingChange).toHaveBeenCalledTimes(1);
    expect(onBindingChange).toHaveBeenCalledWith("a", false);
  });
});

describe("useLarkBinding binding polling", () => {
  it("polls after issuing a code, flips to bound once and stops polling afterwards", async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    try {
      vi.mocked(getLarkBinding)
        .mockResolvedValueOnce({ bound: false })
        .mockResolvedValueOnce({ bound: false })
        .mockResolvedValueOnce({
          bound: true,
          createdAt: "2026-01-02T00:00:00.000Z",
        });
      const onBindingChange = vi.fn();
      const { result } = renderHook(() =>
        useLarkBinding({ onBindingChange }),
      );

      act(() => result.current.open(conversation("a")));
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await result.current.issue();
      });
      const callsAfterIssue = vi.mocked(getLarkBinding).mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(vi.mocked(getLarkBinding)).toHaveBeenCalledTimes(
        callsAfterIssue + 1,
      );
      expect(result.current.state.status).toBe("unbound");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(result.current.state.status).toBe("bound");
      expect(onBindingChange).toHaveBeenCalledTimes(1);
      expect(onBindingChange).toHaveBeenCalledWith("a", true);

      // 进入已绑定态后定时器清理，继续推进时间不再发起轮询。
      const callsAtBound = vi.mocked(getLarkBinding).mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000);
      });
      expect(vi.mocked(getLarkBinding)).toHaveBeenCalledTimes(callsAtBound);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling after unmount without reporting a binding change", async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    try {
      const onBindingChange = vi.fn();
      const { result, unmount } = renderHook(() =>
        useLarkBinding({ onBindingChange }),
      );

      act(() => result.current.open(conversation("a")));
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await result.current.issue();
      });
      const callsAfterIssue = vi.mocked(getLarkBinding).mock.calls.length;

      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(vi.mocked(getLarkBinding)).toHaveBeenCalledTimes(callsAfterIssue);
      expect(onBindingChange).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a transient poll failure and keeps polling", async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    try {
      vi.mocked(getLarkBinding)
        .mockResolvedValueOnce({ bound: false })
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValueOnce({
          bound: true,
          createdAt: "2026-01-02T00:00:00.000Z",
        });
      const onBindingChange = vi.fn();
      const { result } = renderHook(() =>
        useLarkBinding({ onBindingChange }),
      );

      act(() => result.current.open(conversation("a")));
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await result.current.issue();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(result.current.state.status).toBe("unbound");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(result.current.state.status).toBe("bound");
      expect(onBindingChange).toHaveBeenCalledWith("a", true);
    } finally {
      vi.useRealTimers();
    }
  });
});
