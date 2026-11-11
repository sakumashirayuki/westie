import { describe, expect, it } from "vitest";

import {
  buildOpenRequest,
  initialProjectOpenState,
  openProjectState,
  projectOpenReducer,
} from "./project-open-state";
import type {
  ProjectBranches,
  ProjectSelectionInspection,
  ProjectWorktrees,
} from "./run-client";

const gitProject = {
  projectKey: "git:/repo/.git",
  name: "repo",
  root: "/repo",
  projectType: "git" as const,
  selection: null,
};

const plainProject = {
  projectKey: "dir:/notes",
  name: "notes",
  root: "/notes",
  projectType: "directory" as const,
  selection: null,
};

function selection(
  overrides: Partial<ProjectSelectionInspection> = {},
): ProjectSelectionInspection {
  return {
    projectKey: "git:/repo/.git",
    projectType: "git",
    selectedPath: "/repo",
    selectedCheckoutRoot: "/repo",
    mainWorkspace: "/repo",
    selectionKind: "main",
    selectionToken: "token-1",
    ...overrides,
  };
}

const branches: ProjectBranches = {
  branches: ["feat/x", "main"],
  remotes: ["origin"],
  remoteBranches: [{ remote: "origin", name: "release", hasLocalBranch: false }],
  recommendedBranch: "main",
  recommendationSource: "origin/HEAD",
};

const worktrees: ProjectWorktrees = {
  projectKey: "git:/repo/.git",
  mainWorkspace: "/repo",
  worktrees: [
    { path: "/repo", branch: "main", commit: "c1", kind: "main", available: true },
  ],
};

describe("projectOpenReducer", () => {
  it("opens with the sandbox-safe default and no project selected", () => {
    const state = projectOpenReducer(initialProjectOpenState, { type: "open" });
    expect(state).toMatchObject({
      status: "choosing",
      executionMode: "workspace_sandbox",
      fullAccessConfirmed: false,
      project: null,
      choice: { kind: "main" },
    });
  });

  it("uses the sidebar project context with the main directory preselected", () => {
    const state = projectOpenReducer(initialProjectOpenState, {
      type: "open_project",
      project: gitProject,
    });
    expect(state).toMatchObject({ status: "choosing", project: gitProject });
    expect(state.choice).toEqual({ kind: "main" });
  });

  it("keeps the exact selected path when the picker returns a subdirectory", () => {
    const state = projectOpenReducer(initialProjectOpenState, {
      type: "inspect",
      project: gitProject,
      selection: selection({
        selectedPath: "/repo/src",
        selectionKind: "subdirectory",
      }),
    });
    expect(state.choice).toEqual({ kind: "selected_directory" });
    expect(state.selectedPath).toBe("/repo/src");
  });

  it("preselects the recommended local branch and ignores stale loads", () => {
    let state = projectOpenReducer(initialProjectOpenState, {
      type: "open_project",
      project: gitProject,
    });
    state = projectOpenReducer(state, {
      type: "select_choice",
      choice: { kind: "new_worktree", createMode: "new", baseRefKind: "local", baseBranch: "", baseRemote: null, branch: "" },
    });
    state = projectOpenReducer(state, {
      type: "loaded",
      branches,
      worktrees,
      sequence: 1,
    });
    expect(state.status).toBe("ready");
    if (state.status !== "ready") throw new Error("expected ready");
    expect(state.choice).toEqual({
      kind: "new_worktree",
      createMode: "new",
      baseRefKind: "local",
      baseBranch: "main",
      baseRemote: null,
      branch: "",
    });

    const stale = projectOpenReducer(state, {
      type: "load_failed",
      error: "旧请求失败",
      sequence: 0,
    });
    expect(stale).toBe(state);
  });

  it("requires a fresh confirmation before submitting full access", () => {
    let state = projectOpenReducer(initialProjectOpenState, {
      type: "open_project",
      project: gitProject,
    });
    state = projectOpenReducer(state, {
      type: "select_mode",
      executionMode: "full_access",
    });
    expect(state.fullAccessConfirmed).toBe(false);

    const unconfirmed = projectOpenReducer(state, {
      type: "submitting",
      operationId: null,
    });
    expect(unconfirmed.status).toBe("choosing");

    state = projectOpenReducer(state, {
      type: "confirm_full_access",
      confirmed: true,
    });
    // 切回 Sandbox 清除确认状态。
    const backToSandbox = projectOpenReducer(state, {
      type: "select_mode",
      executionMode: "workspace_sandbox",
    });
    expect(backToSandbox.fullAccessConfirmed).toBe(false);
  });

  it("locks changes while submitting and keeps input on failure", () => {
    let state = projectOpenReducer(initialProjectOpenState, {
      type: "open_project",
      project: gitProject,
    });
    state = projectOpenReducer(state, {
      type: "loaded",
      branches,
      worktrees,
      sequence: 1,
    });
    state = projectOpenReducer(state, {
      type: "select_choice",
      choice: { kind: "new_worktree", createMode: "new", baseRefKind: "local", baseBranch: "main", baseRemote: null, branch: "feat/a" },
    });
    state = projectOpenReducer(state, {
      type: "submitting",
      operationId: "op-1",
    });
    expect(state.status).toBe("submitting");
    expect(projectOpenReducer(state, { type: "close" })).toBe(state);

    const failed = projectOpenReducer(state, {
      type: "fail",
      error: "分支已存在。",
    });
    expect(failed).toMatchObject({
      status: "error",
      error: "分支已存在。",
    });
    if (failed.status !== "error") throw new Error("expected error");
    expect(failed.choice).toEqual({
      kind: "new_worktree",
      createMode: "new",
      baseRefKind: "local",
      baseBranch: "main",
      baseRemote: null,
      branch: "feat/a",
    });
  });

  it("keeps the chosen remote when the branch name is cleared", () => {
    let state = projectOpenReducer(initialProjectOpenState, {
      type: "open_project",
      project: gitProject,
    });
    state = projectOpenReducer(state, {
      type: "select_choice",
      choice: {
        kind: "new_worktree",
        createMode: "new",
        baseRefKind: "local",
        baseBranch: "main",
        baseRemote: null,
        branch: "",
      },
    });
    state = projectOpenReducer(state, {
      type: "select_base_branch",
      baseRefKind: "remote",
      baseBranch: "feat/remote",
      baseRemote: "upstream",
    });
    // 清空分支名只清空分支名，起点远端保留。
    state = projectOpenReducer(state, {
      type: "select_base_branch",
      baseRefKind: "remote",
      baseBranch: "",
      baseRemote: "upstream",
    });
    expect(state.choice).toEqual({
      kind: "new_worktree",
      createMode: "new",
      baseRefKind: "remote",
      baseBranch: "",
      baseRemote: "upstream",
      branch: "",
    });
  });

  it("builds a project-key request for registered projects", () => {
    let state = projectOpenReducer(initialProjectOpenState, {
      type: "open_project",
      project: gitProject,
    });
    state = projectOpenReducer(state, { type: "submitting", operationId: null });
    expect(buildOpenRequest(state)).toEqual({
      projectKey: "git:/repo/.git",
      executionMode: "workspace_sandbox",
      workspace: { kind: "main" },
    });
  });

  it("uses the selection token for the freshly selected directory", () => {
    const project = {
      ...gitProject,
      selection: selection({
        selectedPath: "/repo/src",
        selectionKind: "subdirectory",
      }),
    };
    let state = projectOpenReducer(initialProjectOpenState, {
      type: "inspect",
      project,
      selection: project.selection,
    });
    state = projectOpenReducer(state, {
      type: "submitting",
      operationId: null,
    });
    expect(buildOpenRequest(state)).toEqual({
      selectionToken: "token-1",
      executionMode: "workspace_sandbox",
      workspace: { kind: "selected_directory" },
    });
  });

  it("sends the operation id for a new worktree", () => {
    let state = projectOpenReducer(initialProjectOpenState, {
      type: "open_project",
      project: gitProject,
    });
    state = projectOpenReducer(state, {
      type: "select_choice",
      choice: { kind: "new_worktree", createMode: "new", baseRefKind: "local", baseBranch: "main", baseRemote: null, branch: "feat/a" },
    });
    state = projectOpenReducer(state, {
      type: "submitting",
      operationId: "c88235f4-10e0-40f5-8ab2-4129b674eb72",
    });
    expect(buildOpenRequest(state)).toEqual({
      projectKey: "git:/repo/.git",
      executionMode: "workspace_sandbox",
      workspace: {
        kind: "new_worktree",
        baseRefKind: "local",
        baseBranch: "main",
        branch: "feat/a",
        operationId: "c88235f4-10e0-40f5-8ab2-4129b674eb72",
      },
    });
  });

  it("checks out an existing local branch without a new branch name", () => {
    let state = projectOpenReducer(initialProjectOpenState, {
      type: "open_project",
      project: gitProject,
    });
    state = projectOpenReducer(state, {
      type: "loaded",
      branches,
      worktrees,
      sequence: 1,
    });
    state = projectOpenReducer(state, {
      type: "select_choice",
      choice: {
        kind: "new_worktree",
        createMode: "new",
        baseRefKind: "local",
        baseBranch: "main",
        baseRemote: null,
        branch: "feat/a",
      },
    });
    // 切到检出已有分支：清空已填的新分支名和起点。
    state = projectOpenReducer(state, {
      type: "select_create_mode",
      createMode: "existing",
    });
    if (state.choice.kind !== "new_worktree") throw new Error("expected new worktree");
    expect(state.choice.createMode).toBe("existing");
    expect(state.choice.branch).toBe("");
    expect(state.choice.baseBranch).toBe("");

    // 切回创建模式：恢复推荐起点，清空检出分支。
    state = projectOpenReducer(state, {
      type: "select_create_mode",
      createMode: "new",
    });
    if (state.choice.kind !== "new_worktree") throw new Error("expected new worktree");
    expect(state.choice.createMode).toBe("new");
    expect(state.choice.branch).toBe("");
    expect(state.choice.baseBranch).toBe("main");

    // 再切到检出模式并选择已有的 feat/base。
    state = projectOpenReducer(state, {
      type: "select_create_mode",
      createMode: "existing",
    });
    state = projectOpenReducer(state, {
      type: "select_new_branch",
      branch: "feat/base",
    });
    state = projectOpenReducer(state, {
      type: "submitting",
      operationId: "c88235f4-10e0-40f5-8ab2-4129b674eb72",
    });
    expect(buildOpenRequest(state)).toEqual({
      projectKey: "git:/repo/.git",
      executionMode: "workspace_sandbox",
      workspace: {
        kind: "new_worktree",
        baseRefKind: "local",
        baseBranch: "feat/base",
        branch: "feat/base",
        checkoutExisting: true,
        operationId: "c88235f4-10e0-40f5-8ab2-4129b674eb72",
      },
    });
  });

  it("treats a plain directory project as a directory session", () => {
    const state = openProjectState(plainProject);
    expect(state.choice).toEqual({ kind: "directory" });
    const submitted = projectOpenReducer(state, {
      type: "submitting",
      operationId: null,
    });
    expect(buildOpenRequest(submitted)).toEqual({
      projectKey: "dir:/notes",
      executionMode: "workspace_sandbox",
      workspace: { kind: "directory" },
    });
  });
});

describe("project open regressions", () => {
  it("closes the dialog after a successful creation", () => {
    let state = projectOpenReducer(initialProjectOpenState, {
      type: "open_project",
      project: gitProject,
    });
    state = projectOpenReducer(state, {
      type: "submitting",
      operationId: null,
    });
    // 提交中取消仍被忽略，避免请求进行中关掉页面。
    expect(projectOpenReducer(state, { type: "close" })).toBe(state);
    // 创建成功后页面必须回到 closed，否则对话框与整个页面会一直锁住。
    expect(projectOpenReducer(state, { type: "succeeded" }).status).toBe(
      "closed",
    );
  });

  it("defaults to the directory chosen in the picker", () => {
    const gitSelection = selection({ selectedPath: "/repo", selectionKind: "main" });
    const gitState = projectOpenReducer(initialProjectOpenState, {
      type: "inspect",
      project: { ...gitProject, selection: gitSelection },
      selection: gitSelection,
    });
    expect(gitState.choice).toEqual({ kind: "main" });

    const worktreeSelection = selection({
      selectedPath: "/repo-feature",
      selectedCheckoutRoot: "/repo-feature",
      selectionKind: "worktree",
    });
    const worktreeState = projectOpenReducer(initialProjectOpenState, {
      type: "inspect",
      project: { ...gitProject, selection: worktreeSelection },
      selection: worktreeSelection,
    });
    expect(worktreeState.choice).toEqual({ kind: "existing_worktree", path: "/repo-feature" });

    const userSelectedState = projectOpenReducer(worktreeState, {
      type: "select_choice",
      choice: { kind: "main" },
    });
    expect(projectOpenReducer(userSelectedState, {
      type: "loaded",
      branches,
      worktrees: worktrees,
      sequence: 1,
    }).choice).toEqual({ kind: "main" });

    const subdirectorySelection = selection({
      selectedPath: "/repo/src",
      selectionKind: "subdirectory",
    });
    const subdirectoryState = projectOpenReducer(initialProjectOpenState, {
      type: "inspect",
      project: { ...gitProject, selection: subdirectorySelection },
      selection: subdirectorySelection,
    });
    expect(subdirectoryState.choice).toEqual({ kind: "selected_directory" });

    const directorySelection = selection({
      projectKey: "dir:/notes",
      projectType: "directory",
      selectedPath: "/notes",
      selectedCheckoutRoot: null,
      mainWorkspace: "/notes",
      selectionKind: "directory",
    });
    const directoryState = projectOpenReducer(initialProjectOpenState, {
      type: "inspect",
      project: {
        projectKey: "dir:/notes",
        name: "notes",
        root: "/notes",
        projectType: "directory",
        selection: directorySelection,
      },
      selection: directorySelection,
    });
    expect(directoryState.choice).toEqual({ kind: "directory" });
  });

  it("sends the selection token for a first-time selected Git project", () => {
    const gitSelection = selection({ selectedPath: "/repo", selectionKind: "main" });
    let state = projectOpenReducer(initialProjectOpenState, {
      type: "inspect",
      project: { ...gitProject, selection: gitSelection },
      selection: gitSelection,
    });
    state = projectOpenReducer(state, { type: "submitting", operationId: null });
    // 新项目还没登记，只能靠令牌创建；服务端按令牌解析项目身份。
    expect(buildOpenRequest(state)).toEqual({
      selectionToken: "token-1",
      executionMode: "workspace_sandbox",
      workspace: { kind: "main" },
    });
  });
});
