import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ProjectOpenState } from "../project-open-state";
import { ProjectOpenDialog } from "./ProjectOpenDialog";

function render(state: ProjectOpenState): string {
  return renderToStaticMarkup(createElement(ProjectOpenDialog, {
    state,
    onCancel: vi.fn(),
    onInspect: vi.fn(),
    onModeChange: vi.fn(),
    onFullAccessConfirmationChange: vi.fn(),
    onChoiceChange: vi.fn(),
    onBaseBranchChange: vi.fn(),
    onBranchChange: vi.fn(),
    onSelectCreateMode: vi.fn(),
    onSubmit: vi.fn(),
  }));
}

const registered: ProjectOpenState = {
  status: "ready",
  executionMode: "workspace_sandbox",
  fullAccessConfirmed: false,
  project: {
    projectKey: "git:/repo/.git",
    name: "repo",
    root: "/repo",
    projectType: "git",
    selection: null,
  },
  choice: { kind: "main" },
  selectedPath: null,
  newBranch: "",
  loadSequence: 1,
  branches: {
    remotes: ["origin"],
    branches: ["feat/x", "main"],
    remoteBranches: [
      { remote: "origin", name: "feat/x", hasLocalBranch: true },
      { remote: "origin", name: "release", hasLocalBranch: false },
    ],
    recommendedBranch: "main",
    recommendationSource: "origin/HEAD",
  },
  worktrees: {
    projectKey: "git:/repo/.git",
    mainWorkspace: "/repo",
    worktrees: [
      { path: "/repo", branch: "main", commit: "c1", kind: "main", available: true },
      {
        path: "/repo-feature",
        branch: "feat/x",
        commit: "c1",
        kind: "worktree",
        available: false,
      },
    ],
  },
  loadError: null,
};

describe("ProjectOpenDialog", () => {
  it("lists the main directory and worktrees for a registered project", () => {
    const html = render(registered);

    expect(html).toContain("主目录");
    expect(html).toContain("已有 worktree");
    expect(html).toContain("新建 worktree");
    expect(html).toContain("/repo");
    expect(html).toMatch(/<input[^>]*checked=""[^>]*value="workspace_sandbox"/);
    // Full Access 默认不选，也不显示确认框。
    expect(html).not.toContain("完全文件与网络访问权限");
  });

  it("shows the recommended branch and the worktree caveats", () => {
    const html = render({
      ...registered,
      choice: { kind: "new_worktree", createMode: "new", baseRefKind: "local", baseBranch: "main", baseRemote: null, branch: "feat/a" },
      newBranch: "feat/a",
    });

    expect(html).toContain("推荐 main（来自 origin/HEAD）");
    expect(html).toContain("不会复制到新目录");
    expect(html).toContain("宿主 Git 操作");
    expect(html).toContain("~/.westie/worktrees");
  });

  it("lists local branches for checkout and disables branches already checked out", () => {
    const html = render({
      ...registered,
      choice: {
        kind: "new_worktree",
        createMode: "existing",
        baseRefKind: "local",
        baseBranch: "",
        baseRemote: null,
        branch: "feat/free",
      },
      branches: {
        remotes: ["origin"],
        branches: ["feat/x", "feat/free", "main"],
        remoteBranches: [
          { remote: "origin", name: "feat/x", hasLocalBranch: true },
          { remote: "origin", name: "release", hasLocalBranch: false },
        ],
        recommendedBranch: "main",
        recommendationSource: "origin/HEAD",
      },
      worktrees: {
        projectKey: "git:/repo/.git",
        mainWorkspace: "/Users/demo/repo",
        worktrees: [
          { path: "/Users/demo/repo", branch: "main", commit: "c1", kind: "main", available: true },
          {
            path: "/Users/demo/repo-feature",
            branch: "feat/x",
            commit: "c1",
            kind: "worktree",
            available: false,
          },
        ],
      },
    });

    expect(html).toContain("分支方式");
    expect(html).toContain("检出已有分支");
    expect(html).toContain("已有分支");
    // 未被占用的本地分支可选中。
    expect(html).toMatch(/<option value="feat\/free" selected="">/);
    // main 在主目录检出、feat/x 在另一个 worktree 检出：均禁用并标注缩写后的目录。
    expect(html).toMatch(/<option value="main" disabled="">[\s\S]*?（已在 ~\/repo 检出）/);
    expect(html).toMatch(/<option value="feat\/x" disabled="">[\s\S]*?（已在 ~\/repo-feature 检出）/);
    // 检出模式不展示创建模式的起点下拉与新分支输入。
    expect(html).not.toContain("请选择起始分支");
    expect(html).not.toContain('id="new-worktree-base-remote-options"');
    expect(html).not.toContain('placeholder="feat/example"');
  });

  it("lists remote bases apart from local branches and explains the fetch", () => {
    const html = render({
      ...registered,
      choice: {
        kind: "new_worktree",
        createMode: "new",
        baseRefKind: "remote",
        baseBranch: "release",
        baseRemote: "origin",
        branch: "feat/a",
      },
      newBranch: "feat/a",
    });

    expect(html).toContain("本地分支");
    expect(html).toContain("远端 origin");
    expect(html).toContain("origin/release");
    // 已被同名本地分支占用的远端分支不可选。
    expect(html).toMatch(/<option value="remote:origin:feat\/x" disabled="">/);
    expect(html).toMatch(/<option value="remote:origin:release" selected="">/);
    expect(html).toContain("创建前会先执行 git fetch");
  });

  it("accepts a remote branch name that is not fetched on this host", () => {
    const html = render({
      ...registered,
      choice: {
        kind: "new_worktree",
        createMode: "new",
        baseRefKind: "remote",
        baseBranch: "feat/remote-only",
        baseRemote: "origin",
        branch: "feat/a",
      },
      newBranch: "feat/a",
    });

    // 下拉里只有本机已 fetch 的 origin/release，手填入口负责其余远端分支。
    expect(html).toContain("其他远端分支");
    expect(html).toMatch(/<option value="origin" selected="">/);
    expect(html).toMatch(/<input[^>]*value="feat\/remote-only"/);
    expect(html).toMatch(/<datalist id="new-worktree-base-remote-options">/);
    // JSX 换行会插入空白，这里只校验关键片段。
    expect(html).toContain("创建前会从 origin/&lt;分支名&gt; 拉取并");
  });

  it("offers a remote picker that does not depend on local remote refs", () => {
    // 仓库配置了 origin 与 upstream，但本机只有 upstream 的远端分支引用。
    const html = render({
      ...registered,
      choice: { kind: "new_worktree", createMode: "new", baseRefKind: "local", baseBranch: "", baseRemote: null, branch: "" },
      branches: {
        branches: ["main"],
        remotes: ["origin", "upstream"],
        remoteBranches: [{ remote: "upstream", name: "release", hasLocalBranch: false }],
        recommendedBranch: null,
        recommendationSource: null,
      },
    });

    // 远端下拉来自已配置的 remote，占位项提示只使用下拉里已有的远端分支。
    expect(html).toMatch(/<option value="">使用下拉里已有的远端分支<\/option>/);
    // 默认远端是 origin，因此它被预选。
    expect(html).toMatch(/<option value="origin" selected="">origin<\/option>/);
    expect(html).toMatch(/<option value="upstream">upstream<\/option>/);
    // 未选择远端时手填框不出现。
    expect(html).not.toContain("其他远端分支</label>");

    const picked = render({
      ...registered,
      choice: {
        kind: "new_worktree",
        createMode: "new",
        baseRefKind: "remote",
        baseBranch: "feat/brand-new",
        baseRemote: "origin",
        branch: "",
      },
      branches: {
        branches: ["main"],
        remotes: ["origin", "upstream"],
        remoteBranches: [{ remote: "upstream", name: "release", hasLocalBranch: false }],
        recommendedBranch: null,
        recommendationSource: null,
      },
    });

    // 即使 origin 没有任何本地远端分支引用，也能选中 origin 并填写新分支。
    expect(picked).toMatch(/<option value="origin" selected="">/);
    expect(picked).toMatch(/<input[^>]*value="feat\/brand-new"/);
    expect(picked).toContain("创建前会从 origin/&lt;分支名&gt; 拉取并");
  });

  it("keeps the chosen remote when the branch name is cleared", () => {
    // 选中 upstream 并把分支名清空：起点仍是远端 upstream，等待重新输入。
    const html = render({
      ...registered,
      choice: {
        kind: "new_worktree",
        createMode: "new",
        baseRefKind: "remote",
        baseBranch: "",
        baseRemote: "upstream",
        branch: "",
      },
      branches: {
        branches: ["main"],
        remotes: ["origin", "upstream"],
        remoteBranches: [],
        recommendedBranch: null,
        recommendationSource: null,
      },
    });

    expect(html).toMatch(/<option value="upstream" selected="">/);
    expect(html).toMatch(/<input[^>]*value=""/);
    expect(html).toContain("创建前会从 upstream/&lt;分支名&gt; 拉取并");
  });

  it("allows a new worktree from a configured remote without any branch refs", () => {
    // detached HEAD：本地分支与远端分支引用都为空，但配置了 remote。
    const html = render({
      ...registered,
      choice: { kind: "main" },
      branches: {
        branches: [],
        remotes: ["origin"],
        remoteBranches: [],
        recommendedBranch: null,
        recommendationSource: null,
      },
    });

    const option = html.match(
      /<label class="[^"]*"><input type="radio" [^>]*name="workspace-kind"[^>]*>[\s\S]*?<strong class="text-sm">新建 worktree<\/strong><span[^>]*>([^<]*)<\/span>/,
    );
    expect(option?.[1]).toBe("从本地或远端分支创建独立工作目录。");
    expect(html).not.toContain("没有可用的分支，也没有已配置的远端");
  });

  it("disables a new worktree only when no branch and no remote exist", () => {
    const html = render({
      ...registered,
      choice: { kind: "main" },
      branches: {
        branches: [],
        remotes: [],
        remoteBranches: [],
        recommendedBranch: null,
        recommendationSource: null,
      },
    });

    expect(html).toContain("没有可用的分支，也没有已配置的远端");
  });

  it("gates full access behind an explicit confirmation", () => {
    const html = render({
      ...registered,
      executionMode: "full_access",
      fullAccessConfirmed: false,
    });

    expect(html).toContain("我了解 Agent 将拥有完全文件与网络访问权限");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>创建会话<\/button>/);
  });

  it("offers the exact selected subdirectory", () => {
    const html = render({
      ...registered,
      project: {
        ...registered.project!,
        selection: {
          projectKey: "git:/repo/.git",
          projectType: "git",
          selectedPath: "/repo/src",
          selectedCheckoutRoot: "/repo",
          mainWorkspace: "/repo",
          selectionKind: "subdirectory",
          selectionToken: "token-1",
        },
      },
      choice: { kind: "selected_directory" },
      selectedPath: "/repo/src",
    });

    expect(html).toContain("刚才选中的目录");
    expect(html).toContain("所选路径：/repo/src");
  });

  it("hides Git options for a plain directory", () => {
    const html = render({
      ...registered,
      project: {
        projectKey: "dir:/notes",
        name: "notes",
        root: "/notes",
        projectType: "directory",
        selection: {
          projectKey: "dir:/notes",
          projectType: "directory",
          selectedPath: "/notes",
          selectedCheckoutRoot: null,
          mainWorkspace: "/notes",
          selectionKind: "directory",
          selectionToken: "token-2",
        },
      },
      choice: { kind: "directory" },
      branches: null,
      worktrees: null,
    });

    expect(html).toContain("只能使用该目录创建会话");
    expect(html).not.toContain("新建 worktree");
    expect(html).not.toContain("已有 worktree");
  });
});
