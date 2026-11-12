// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import {
  getConversation,
  getLarkBinding,
  getLarkCapability,
  listConversations,
  subscribeConversationRun,
  inspectWorkspaceSelection,
  openConversation,
  getProjectBranches,
  getProjectWorktrees,
  UNKNOWN_WORKSPACE_STATUS,
  type ConversationDetail,
  type ConversationSummary,
} from "./run-client";

vi.mock("./run-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("./run-client")>();
  return {
    ...original,
    listConversations: vi.fn(),
    getConversation: vi.fn(),
    subscribeConversationRun: vi.fn(),
    cancelConversationRun: vi.fn(),
    deleteConversation: vi.fn(),
    inspectWorkspaceSelection: vi.fn(),
    openConversation: vi.fn(),
    getProjectBranches: vi.fn(),
    getProjectWorktrees: vi.fn(),
    getLarkCapability: vi.fn(),
    getLarkBinding: vi.fn(),
    issueLarkBindingCode: vi.fn(),
    unbindLarkChat: vi.fn(),
  };
});

const usage = {
  calls: 0,
  unmeasuredCalls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};
const at = "2026-01-01T00:00:00.000Z";

function summary(id: string, name: string): ConversationSummary {
  return {
    id,
    revision: 0,
    executionMode: "workspace_sandbox",
    title: null,
    createdAt: at,
    updatedAt: at,
    workspace: { name },
    project: { key: `git:/work/${name}/.git`, root: `/work/${name}`, name },
    archived: false,
  };
}

function detail(id: string, name: string): ConversationDetail {
  return {
    ...summary(id, name),
    workspace: { name, canonicalPath: `/work/${name}` },
    workspaceStatus: UNKNOWN_WORKSPACE_STATUS,
    usage,
    turns: [],
  };
}

/** runs:watch：发一条空 snapshot 后保持连接，与真实 SSE 行为一致。 */
function stubRunActivity(): void {
  const body = `event: snapshot\ndata: ${JSON.stringify({ runs: [] })}\n\n`;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes("runs:watch")) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("{}", { status: 404 });
  }));
}

const alpha = summary("alpha", "alpha");
const beta = summary("beta", "beta");

beforeEach(() => {
  vi.mocked(listConversations).mockResolvedValue({
    items: [alpha, beta],
    nextCursor: null,
  });
  vi.mocked(getConversation).mockImplementation(async (id) =>
    id === "alpha" ? detail("alpha", "alpha") : detail("beta", "beta"),
  );
  // 订阅在 abort 前保持挂起，模拟运行流持续连接；本测试不打开会话，正常不会调用。
  vi.mocked(subscribeConversationRun).mockImplementation(
    (_conversationId, _runId, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () =>
          reject(options.signal.reason),
        );
      }),
  );
  vi.mocked(inspectWorkspaceSelection).mockRejectedValue(new Error("not used"));
  vi.mocked(openConversation).mockRejectedValue(new Error("not used"));
  vi.mocked(getProjectBranches).mockResolvedValue({
    branches: [],
    remotes: [],
    remoteBranches: [],
    recommendedBranch: null,
    recommendationSource: "origin/HEAD",
  });
  vi.mocked(getProjectWorktrees).mockResolvedValue({
    projectKey: "git:/work/alpha/.git",
    mainWorkspace: "/work/alpha",
    worktrees: [],
  });
  vi.mocked(getLarkCapability).mockResolvedValue({ enabled: true });
  vi.mocked(getLarkBinding).mockResolvedValue({ bound: false });
  stubRunActivity();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Feishu binding entry", () => {
  it("opens the binding dialog from the row menu and loads the binding state", async () => {
    render(<MemoryRouter><App /></MemoryRouter>);

    await waitFor(() => expect(getLarkCapability).toHaveBeenCalledTimes(1));

    // Radix 菜单由 pointerdown 展开，click 不会触发。
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: /会话操作 alpha/ }),
      { button: 0, ctrlKey: false, pointerId: 1, pointerType: "mouse" },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /绑定飞书单聊/ }),
    );

    // 弹窗挂载并读到未绑定状态（尚未签发绑定码）。
    expect(await screen.findByText("尚未生成绑定码。")).toBeTruthy();
    await waitFor(() =>
      expect(getLarkBinding).toHaveBeenCalledWith("alpha"),
    );
  });

  it("requests capability once across re-renders", async () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    await waitFor(() => expect(getLarkCapability).toHaveBeenCalledTimes(1));

    // 切换会话引发多轮重渲染，能力探测仍只在挂载时发一次。
    fireEvent.click(screen.getByRole("button", { name: /^beta.*beta/ }));
    await waitFor(() => expect(getConversation).toHaveBeenCalled());
    expect(getLarkCapability).toHaveBeenCalledTimes(1);
  });
});
