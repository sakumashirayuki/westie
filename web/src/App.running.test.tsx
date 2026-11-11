// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import {
  cancelConversationRun,
  deleteConversation,
  getConversation,
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
    openConversation: vi.fn(async () => {
      throw new Error("Unexpected openConversation call.");
    }),
    getProjectBranches: vi.fn(),
    getProjectWorktrees: vi.fn(),
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

function detail(id: string, name: string, running: boolean): ConversationDetail {
  return {
    ...summary(id, name),
    workspace: { name, canonicalPath: `/work/${name}` },
    workspaceStatus: UNKNOWN_WORKSPACE_STATUS,
    usage,
    turns: running
      ? [{
          id: `turn-${id}`,
          userMessage: "long task",
          status: "running",
          createdAt: at,
          updatedAt: at,
          runs: [{
            id: `run-${id}`,
            attempt: 1,
            status: "running",
            createdAt: at,
            updatedAt: at,
            usage,
            steeringMessages: [],
            subAgentRuns: [],
          }],
        }]
      : [],
  };
}

/** runs:watch：发一条 snapshot 后保持连接。 */
function stubRunActivity(runs: { conversationId: string; runId: string }[]) {
  const body = `event: snapshot\ndata: ${JSON.stringify({
    runs: runs.map((run) => ({ ...run, state: "running", startedAt: at })),
  })}\n\n`;
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

const alpha = detail("alpha", "alpha", true);
const beta = detail("beta", "beta", false);

beforeEach(() => {
  vi.mocked(listConversations).mockResolvedValue({
    items: [summary("alpha", "alpha"), summary("beta", "beta")],
    nextCursor: null,
  });
  vi.mocked(getConversation).mockImplementation(async (id) =>
    id === "alpha" ? alpha : beta
  );
  // alpha 的 Run 一直在跑：订阅挂起直到被 abort。
  vi.mocked(subscribeConversationRun).mockImplementation(
    (_conversationId, _runId, options) =>
      new Promise<void>((_, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason));
      }),
  );
  vi.mocked(deleteConversation).mockResolvedValue(undefined);
  // 全局入口：选择器识别出一个普通目录，页面用它的精确路径创建会话。
  vi.mocked(inspectWorkspaceSelection).mockResolvedValue({
    projectKey: "dir:/notes",
    projectType: "directory",
    selectedPath: "/notes",
    selectedCheckoutRoot: null,
    mainWorkspace: "/notes",
    selectionKind: "directory",
    selectionToken: "token-notes",
  });
  vi.mocked(openConversation).mockImplementation(async () => ({
    kind: "conversation",
    conversation: detail("gamma", "gamma", false),
  }));
  stubRunActivity([{ conversationId: "alpha", runId: "run-alpha" }]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function openRunningAlpha() {
  render(
    <MemoryRouter initialEntries={["/conversations/alpha"]}>
      <App />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(subscribeConversationRun).toHaveBeenCalledWith(
      "alpha",
      "run-alpha",
      expect.objectContaining({ after: 0 }),
    )
  );
  await screen.findByLabelText("运行中");
  return vi.mocked(subscribeConversationRun).mock.calls[0]![2].signal;
}

describe("App while a run is active", () => {
  it("switches to another conversation without cancelling the run", async () => {
    const subscription = await openRunningAlpha();

    // 会话行显示名称、执行模式、时间和短 ID，不再显示工作目录。
    fireEvent.click(screen.getByRole("button", { name: /^beta.*beta/ }));

    await waitFor(() => expect(getConversation).toHaveBeenCalledWith(
      "beta",
      expect.anything(),
    ));
    expect(subscription.aborted).toBe(true);
    expect(cancelConversationRun).not.toHaveBeenCalled();
    // 侧栏仍显示 alpha 在运行。
    expect(screen.getByLabelText("运行中")).toBeTruthy();
  });

  it("deletes an idle conversation while another one is running", async () => {
    await openRunningAlpha();

    // 运行中的 alpha 仍是可打开的菜单，但菜单项“删除”被禁用并说明原因；
    // 空闲的 beta 菜单项可点，点完进删除确认弹窗。
    // Radix 菜单由 pointerdown 打开，click 只派发 click 不会展开。
    const pointerDown = (element: Element) =>
      fireEvent.pointerDown(element, {
        button: 0,
        ctrlKey: false,
        pointerId: 1,
        pointerType: "mouse",
      });

    pointerDown(await screen.findByRole("button", { name: /会话操作 alpha/ }));
    expect(
      (await screen.findByRole("menuitem", { name: /删除/ }))
        .getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    pointerDown(screen.getByRole("button", { name: /会话操作 beta/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /删除/ }));
    fireEvent.click(await screen.findByRole("button", { name: "确认删除" }));

    await waitFor(() =>
      expect(deleteConversation).toHaveBeenCalledWith("beta")
    );
    expect(cancelConversationRun).not.toHaveBeenCalled();
  });

  it("opens a new conversation while the run keeps going", async () => {
    const subscription = await openRunningAlpha();

    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));

    // 全局入口先打开系统目录选择器并识别目录，识别完成后才显示创建按钮。
    await waitFor(() => expect(inspectWorkspaceSelection).toHaveBeenCalled());
    const create = await screen.findByRole("button", { name: "创建会话" }, { timeout: 4000 });
    fireEvent.click(create);

    await waitFor(() => expect(openConversation).toHaveBeenCalled(), {
      timeout: 4000,
    });
    await waitFor(() => expect(openConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        selectionToken: "token-notes",
        workspace: { kind: "directory" },
      }),
    ));
    await waitFor(() => expect(subscription.aborted).toBe(true));
    expect(cancelConversationRun).not.toHaveBeenCalled();
  });

  it("keeps the selected Git worktree directory as the default workspace", async () => {
    vi.mocked(inspectWorkspaceSelection).mockResolvedValueOnce({
      projectKey: "git:/repo/.git",
      projectType: "git",
      selectedPath: "/repo-feature",
      selectedCheckoutRoot: "/repo-feature",
      mainWorkspace: "/repo",
      selectionKind: "worktree",
      selectionToken: "token-worktree",
    });
    vi.mocked(getProjectBranches).mockResolvedValueOnce({
      branches: ["main", "feat/worktree"],
      remotes: ["origin"],
      remoteBranches: [],
      recommendedBranch: "main",
      recommendationSource: "origin/HEAD",
    });
    vi.mocked(getProjectWorktrees).mockResolvedValueOnce({
      projectKey: "git:/repo/.git",
      mainWorkspace: "/repo",
      worktrees: [{
        path: "/repo-feature",
        branch: "feat/worktree",
        commit: "c1",
        kind: "worktree",
        available: true,
      }],
    });

    render(<MemoryRouter><App /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));

    const create = await screen.findByRole("button", { name: "创建会话" }, { timeout: 4000 });
    fireEvent.click(create);

    await waitFor(() => expect(openConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        selectionToken: "token-worktree",
        workspace: { kind: "existing_worktree", path: "/repo-feature" },
      }),
    ));
  });
});
