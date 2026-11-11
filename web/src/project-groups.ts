import type {
  ConversationProject,
  ConversationSummary,
  WorkspaceBranch,
  WorkspaceStatus,
} from "./run-client";

/** 侧栏里的一个项目分组；未识别的会话单独成组。 */
export interface SidebarProjectGroup {
  /** 分组 key：已识别项目用 `project.key`，未识别会话用 `unidentified:<id>`。 */
  readonly key: string;
  readonly name: string;
  readonly root: string | null;
  readonly project: ConversationProject | null;
  /** 组内会话，按全局列表同样的 `(updatedAt, id)` 倒序。 */
  readonly conversations: readonly ConversationSummary[];
}

/**
 * 把已加载的会话按项目分组。项目排序取组内最大的 `updatedAt`，与列表的全局
 * 排序一致；未识别归属的会话不会被隐藏，各自成组并显示原目录。
 */
export function groupConversationsByProject(
  conversations: readonly ConversationSummary[],
): SidebarProjectGroup[] {
  const groups = new Map<string, SidebarProjectGroup>();
  for (const conversation of conversations) {
    const key = conversation.project?.key ?? `unidentified:${conversation.id}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        name: conversation.project?.name ?? "未识别",
        root: conversation.project?.root ?? null,
        project: conversation.project,
        conversations: [conversation],
      });
      continue;
    }
    groups.set(key, {
      ...existing,
      conversations: [...existing.conversations, conversation],
    });
  }
  const result = Array.from(groups.values()).map((group) => ({
    ...group,
    conversations: [...group.conversations].sort(compareConversations),
  }));
  return result.sort(compareGroups);
}

function compareGroups(
  left: SidebarProjectGroup,
  right: SidebarProjectGroup,
): number {
  const leftLatest = left.conversations[0]?.updatedAt ?? "";
  const rightLatest = right.conversations[0]?.updatedAt ?? "";
  if (leftLatest !== rightLatest) return leftLatest > rightLatest ? -1 : 1;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

/** 与服务端 `ORDER BY updated_at DESC, id DESC` 一致。 */
function compareConversations(
  left: ConversationSummary,
  right: ConversationSummary,
): number {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt > right.updatedAt ? -1 : 1;
  }
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

/** 目录类型的中文标签；未识别时为「目录」，未知为「目录未确认」。 */
export function workspaceKindLabel(kind: WorkspaceStatus["kind"]): string {
  switch (kind) {
    case "main":
      return "主目录";
    case "worktree":
      return "Worktree";
    case "subdirectory":
      return "子目录";
    case "directory":
      return "目录";
    case "unknown":
      return "目录未确认";
  }
}

/** 分支显示：detached HEAD 与无法读取都明确说明，不显示过时的分支。 */
export function branchLabel(branch: WorkspaceBranch): string {
  switch (branch.status) {
    case "branch":
      return branch.name;
    case "detached":
      return branch.commit === null
        ? "detached HEAD"
        : `detached HEAD · ${branch.commit.slice(0, 7)}`;
    case "unknown":
      return "分支未知";
  }
}

/** 目录不可用说明；可用时为 null。 */
export function availabilityLabel(
  availability: WorkspaceStatus["availability"],
): string | null {
  if (availability.status === "available") return null;
  if (availability.status === "missing") return "目录不存在";
  return `目录不可访问：${availability.reason}`;
}

/** 会话详情里的项目名；未识别时回退到目录名。 */
export function projectDisplayName(
  conversation: Pick<ConversationSummary, "project" | "workspace">,
): string {
  return conversation.project?.name ?? conversation.workspace.name;
}

/** 新建会话页的目录选项。 */
export type WorkspaceChoice =
  | { readonly kind: "main" }
  | { readonly kind: "existing_worktree"; readonly path: string }
  | {
      readonly kind: "new_worktree";
      /**
       * `new`：从起始分支创建新分支；`existing`：直接检出已存在且未被其他
       * worktree 占用的本地分支。
       */
      readonly createMode: "new" | "existing";
      /** 起点位置：本地分支，或 `baseRemote` 上的远端分支。 */
      readonly baseRefKind: "local" | "remote";
      /** 起点分支名；远端起点时不带远端前缀。 */
      readonly baseBranch: string;
      /** 起点所在远端；本地起点为 null。 */
      readonly baseRemote: string | null;
      /** 创建模式下是新分支名；检出模式下是要检出的已有本地分支名。 */
      readonly branch: string;
    }
  | { readonly kind: "selected_directory" }
  | { readonly kind: "directory" };

/** 新建会话页的默认目录选项：沿用选择器里选中的精确位置。 */
export function defaultWorkspaceChoice(
  selectionKind: "main" | "worktree" | "subdirectory" | "directory" | "unknown",
): WorkspaceChoice["kind"] {
  switch (selectionKind) {
    case "main":
      return "main";
    case "worktree":
      return "existing_worktree";
    case "subdirectory":
    case "unknown":
      return "selected_directory";
    case "directory":
      return "directory";
  }
}

/** 打开新会话前必须满足的条件：Full Access 需勾选确认、新建 worktree 需填分支。 */
export function canSubmitProjectOpen(
  choice: WorkspaceChoice,
  executionMode: "workspace_sandbox" | "full_access",
  fullAccessConfirmed: boolean,
): boolean {
  if (executionMode === "full_access" && !fullAccessConfirmed) return false;
  if (choice.kind === "new_worktree") {
    // 检出已有分支模式只要求选择该分支；创建模式还要求选择起点。
    if (choice.createMode === "existing") return choice.branch.trim() !== "";
    return choice.baseBranch.trim() !== "" && choice.branch.trim() !== "";
  }
  if (choice.kind === "existing_worktree") return choice.path !== "";
  return true;
}
