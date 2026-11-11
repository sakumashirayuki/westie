// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { respondToInteraction, selectWorkspaceFile } from "../run-client";
import { useRunInteractions } from "./useRunInteractions";

vi.mock("../run-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../run-client")>(),
  respondToInteraction: vi.fn(),
  selectWorkspaceFile: vi.fn(),
}));

beforeEach(() => vi.resetAllMocks());

const actions = ["respond", "select_file"] as const;

function submit(hook: ReturnType<typeof useRunInteractions>, action: typeof actions[number]) {
  return action === "respond" ? hook.respond("i1", "approve") : hook.selectFile("i1");
}

function requestMock(action: typeof actions[number]) {
  return action === "respond" ? vi.mocked(respondToInteraction) : vi.mocked(selectWorkspaceFile);
}

describe("useRunInteractions", () => {
  it.each(actions)("marks a successful %s request as submitted", async (action) => {
    const { result } = renderHook(() => useRunInteractions(() => true));
    await act(async () => { await submit(result.current, action); });
    expect(result.current.interactionRequests.i1).toEqual({ status: "submitted", action });
  });

  it.each(actions)("reports a failed %s request", async (action) => {
    requestMock(action).mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useRunInteractions(() => true));
    await act(async () => { await submit(result.current, action); });
    expect(result.current.interactionRequests.i1).toMatchObject({ status: "error", action });
  });

  it.each(actions)("keeps a cleared %s request cleared when the response arrives", async (action) => {
    let resolve!: () => void;
    requestMock(action).mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    const { result } = renderHook(() => useRunInteractions(() => true));
    let pending!: Promise<void>;
    act(() => { pending = submit(result.current, action); });
    expect(result.current.interactionRequests.i1?.status).toBe("submitting");
    act(() => result.current.reset());
    await act(async () => { resolve(); await pending; });
    expect(result.current.interactionRequests).toEqual({});
  });

  it("does not submit without an active run", async () => {
    const { result } = renderHook(() => useRunInteractions(() => false));
    await act(async () => { await result.current.respond("i1", "approve"); await result.current.selectFile("i1"); });
    expect(respondToInteraction).not.toHaveBeenCalled();
    expect(selectWorkspaceFile).not.toHaveBeenCalled();
  });
});
