import { describe, expect, it } from "vitest";

import {
  availabilityLabel,
  branchLabel,
  canSubmitProjectOpen,
  groupConversationsByProject,
  workspaceKindLabel,
} from "./project-groups";
import {
  UNKNOWN_WORKSPACE_STATUS,
  type ConversationSummary,
  type WorkspaceStatus,
} from "./run-client";

function summary(
  id: string,
  updatedAt: string,
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id,
    revision: 0,
    executionMode: "workspace_sandbox",
    title: null,
    createdAt: updatedAt,
    updatedAt,
    workspace: { name: `project-${id}` },
    project: null,
    archived: false,
    ...overrides,
  };
}

const gitProject = {
  key: "git:/repo/.git",
  root: "/repo",
  name: "repo",
};

describe("groupConversationsByProject", () => {
  it("groups main checkouts and worktrees of the same repository", () => {
    const groups = groupConversationsByProject([
      summary("main", "2026-10-01T00:00:00.000Z", {
        project: gitProject,
      }),
      summary("worktree", "2026-10-02T00:00:00.000Z", {
        project: gitProject,
      }),
      summary("other", "2026-10-03T00:00:00.000Z", {
        project: { key: "dir:/notes", root: "/notes", name: "notes" },
      }),
    ]);

    expect(groups).toHaveLength(2);
    // 项目按组内最新活动排序：notes 最新，其次 repo。
    expect(groups[0]?.name).toBe("notes");
    expect(groups[1]?.name).toBe("repo");
    expect(groups[1]?.root).toBe("/repo");
    expect(groups[1]?.conversations.map((item) => item.id)).toEqual([
      "worktree",
      "main",
    ]);
  });

  it("keeps unidentified conversations visible with their original directory", () => {
    const groups = groupConversationsByProject([
      summary("legacy", "2026-10-01T00:00:00.000Z"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: "unidentified:legacy",
      name: "未识别",
      root: null,
      project: null,
    });
  });

  it("sorts conversations by updatedAt then id descending", () => {
    const groups = groupConversationsByProject([
      summary("a", "2026-10-01T00:00:00.000Z", { project: gitProject }),
      summary("b", "2026-10-01T00:00:00.000Z", { project: gitProject }),
    ]);
    expect(groups[0]?.conversations.map((item) => item.id)).toEqual(["b", "a"]);
  });
});

describe("workspace labels", () => {
  it("describes each workspace kind", () => {
    expect(workspaceKindLabel("main")).toBe("主目录");
    expect(workspaceKindLabel("worktree")).toBe("Worktree");
    expect(workspaceKindLabel("subdirectory")).toBe("子目录");
    expect(workspaceKindLabel("directory")).toBe("目录");
    expect(workspaceKindLabel("unknown")).toBe("目录未确认");
  });

  it("shows branches, detached HEAD and unknown state without guessing", () => {
    expect(branchLabel({ status: "branch", name: "feat/x" })).toBe("feat/x");
    expect(branchLabel({ status: "detached", commit: "0123456789abcdef" })).toBe(
      "detached HEAD · 0123456",
    );
    expect(branchLabel({ status: "unknown" })).toBe("分支未知");
  });

  it("reports unavailable directories", () => {
    expect(availabilityLabel({ status: "available" })).toBeNull();
    expect(availabilityLabel({ status: "missing" })).toBe("目录不存在");
    expect(
      availabilityLabel({ status: "unreadable", reason: "权限不足" }),
    ).toBe("目录不可访问：权限不足");
  });

  it("blocks submission without a branch or full access confirmation", () => {
    expect(canSubmitProjectOpen({ kind: "main" }, "full_access", false))
      .toBe(false);
    expect(canSubmitProjectOpen({ kind: "main" }, "full_access", true)).toBe(true);
    expect(
      canSubmitProjectOpen(
        { kind: "new_worktree", createMode: "new", baseRefKind: "local", baseBranch: "main", baseRemote: null, branch: "" },
        "workspace_sandbox",
        false,
      ),
    ).toBe(false);
    expect(
      canSubmitProjectOpen(
        { kind: "new_worktree", createMode: "new", baseRefKind: "local", baseBranch: "main", baseRemote: null, branch: "feat/a" },
        "workspace_sandbox",
        false,
      ),
    ).toBe(true);
    // 检出已有分支：不要求起点，只要求选择要检出的分支。
    expect(
      canSubmitProjectOpen(
        { kind: "new_worktree", createMode: "existing", baseRefKind: "local", baseBranch: "", baseRemote: null, branch: "" },
        "workspace_sandbox",
        false,
      ),
    ).toBe(false);
    expect(
      canSubmitProjectOpen(
        { kind: "new_worktree", createMode: "existing", baseRefKind: "local", baseBranch: "", baseRemote: null, branch: "feat/base" },
        "workspace_sandbox",
        false,
      ),
    ).toBe(true);
    expect(
      canSubmitProjectOpen({ kind: "existing_worktree", path: "" }, "workspace_sandbox", false),
    ).toBe(false);
  });
});
