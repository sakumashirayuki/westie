import type {
  ExecutionMode,
  OpenWorkspaceRequest,
  ProjectBranches,
  ProjectSelectionInspection,
  ProjectWorktrees,
} from "./run-client";
import type { WorkspaceChoice } from "./project-groups";

/** 新建会话页里已识别项目的上下文。 */
export interface ProjectContext {
  readonly projectKey: string;
  readonly name: string;
  readonly root: string;
  /**
   * 项目类型。来自选择器识别结果时是 `git` / `directory` / `unknown`；
   * 从会话记录打开时按项目 key 前缀推断（`git:` / `dir:`）。
   */
  readonly projectType: "git" | "directory" | "unknown";
  /**
   * 本次选择器识别结果。有它时创建请求与分支/worktree 查询都改用令牌，
   * 因为该项目可能从未登记过。
   */
  readonly selection: ProjectSelectionInspection | null;
}

/** 按项目 key 前缀推断项目类型；key 为空表示尚未识别。 */
export function projectTypeOf(
  projectKey: string,
): "git" | "directory" | "unknown" {
  if (projectKey.startsWith("git:")) return "git";
  if (projectKey.startsWith("dir:")) return "directory";
  return "unknown";
}

/**
 * 新建会话页的状态机。
 *
 * `closed`：没有打开页面；`choosing`：正在选择项目与工作目录；`ready`：项目
 * 与目录信息已读取；`submitting`：正在提交创建请求。
 */
export type ProjectOpenState =
  | ProjectOpenBase & { readonly status: "closed" }
  | ProjectOpenBase & { readonly status: "choosing" }
  | ProjectOpenBase & {
      readonly status: "ready";
      readonly branches: ProjectBranches | null;
      readonly worktrees: ProjectWorktrees | null;
      /** 读取分支或 worktree 失败的原因；不影响其它选项。 */
      readonly loadError: string | null;
    }
  | ProjectOpenBase & {
      readonly status: "submitting";
      readonly operationId: string | null;
    }
  | ProjectOpenBase & { readonly status: "error"; readonly error: string };

interface ProjectOpenBase {
  readonly executionMode: ExecutionMode;
  readonly fullAccessConfirmed: boolean;
  readonly project: ProjectContext | null;
  readonly choice: WorkspaceChoice;
  /** 选择器里选中的精确路径，用于「刚才选中的目录」。 */
  readonly selectedPath: string | null;
  /** 新建 worktree 的目标分支；起始分支保存在 `choice` 里。 */
  readonly newBranch: string;
  /** 已处理到的分支 / worktree 读取序号，用于忽略过期的响应。 */
  readonly loadSequence: number;
}

export type ProjectOpenAction =
  | { type: "open" }
  | { type: "open_project"; project: ProjectContext }
  | { type: "close" }
  /** 创建成功：请求此刻不应再被取消，状态回到 closed。 */
  | { type: "succeeded" }
  | {
      type: "inspect";
      selection: ProjectSelectionInspection;
      project: ProjectContext;
    }
  | { type: "select_mode"; executionMode: ExecutionMode }
  | { type: "confirm_full_access"; confirmed: boolean }
  | { type: "select_choice"; choice: WorkspaceChoice }
  /** 输入目标分支名；撤销已标记的目录失败无需额外动作。 */
  | { type: "select_new_branch"; branch: string }
  /**
   * 切换新建 worktree 的模式：从起点创建新分支，或直接检出已有本地分支。
   * 切换时清空已选分支，避免把新分支名带到分支选择下拉里。
   */
  | { type: "select_create_mode"; createMode: "new" | "existing" }
  | {
      type: "select_base_branch";
      baseRefKind: "local" | "remote";
      baseBranch: string;
      /** 远端起点时的远端名；本地起点为 null。 */
      baseRemote: string | null;
    }
  | {
      type: "loaded";
      branches: ProjectBranches;
      worktrees: ProjectWorktrees;
      /** 读取发生的提交序号；比当前已处理的序号旧时忽略。 */
      sequence: number;
    }
  | { type: "load_failed"; error: string; sequence: number }
  | { type: "submitting"; operationId: string | null }
  | { type: "fail"; error: string };

export const initialProjectOpenState: ProjectOpenState = {
  status: "closed",
  executionMode: "workspace_sandbox",
  fullAccessConfirmed: false,
  project: null,
  choice: { kind: "main" },
  selectedPath: null,
  newBranch: "",
  loadSequence: 0,
};

const CHOSING_DEFAULTS: Omit<ProjectOpenBase, "error"> = {
  executionMode: "workspace_sandbox" as ExecutionMode,
  fullAccessConfirmed: false,
  project: null,
  choice: { kind: "main" } as WorkspaceChoice,
  selectedPath: null,
  newBranch: "",
  loadSequence: 0,
};

/** 从侧栏项目旁的 `＋` 进入：直接使用该项目，按项目类型给出默认工作目录。 */
export function openProjectState(project: ProjectContext): ProjectOpenState {
  return {
    status: "choosing",
    ...CHOSING_DEFAULTS,
    project,
    choice: project.projectType === "directory"
      ? { kind: "directory" }
      : { kind: "main" },
  };
}

/**
 * 默认工作目录：沿用选择器里选中的精确位置；普通目录与 Git 不可用的目录
 * 固定使用该目录本身。
 */
function defaultChoiceForProject(
  project: ProjectContext,
  selectionKind: "main" | "worktree" | "subdirectory" | "directory" | "unknown",
  selectedPath: string,
): WorkspaceChoice {
  if (project.projectType !== "git") {
    return project.projectType === "directory"
      ? { kind: "directory" }
      : { kind: "selected_directory" };
  }
  if (selectionKind === "worktree") {
    return { kind: "existing_worktree", path: selectedPath };
  }
  return choiceForSelection(selectionKind);
}

export function projectOpenReducer(
  state: ProjectOpenState,
  action: ProjectOpenAction,
): ProjectOpenState {
  switch (action.type) {
    case "open":
      if (state.status === "submitting") return state;
      // 读取序号只递增：旧请求的响应不会覆盖新页面的选择。
      return { status: "choosing", ...CHOSING_DEFAULTS, loadSequence: state.loadSequence };
    case "open_project":
      if (state.status === "submitting") return state;
      return { ...openProjectState(action.project), loadSequence: state.loadSequence };
    case "close":
      return state.status === "submitting" ? state : initialProjectOpenState;
    case "succeeded":
      return initialProjectOpenState;
    case "inspect":
      return {
        status: "choosing",
        ...CHOSING_DEFAULTS,
        loadSequence: state.loadSequence,
        executionMode: state.executionMode,
        fullAccessConfirmed: state.fullAccessConfirmed,
        project: action.project,
        choice: defaultChoiceForProject(
          action.project,
          action.selection.selectionKind,
          action.selection.selectedPath,
        ),
        selectedPath: action.selection.selectedPath,
      };
    case "select_mode":
      if (state.status === "closed" || state.status === "submitting") return state;
      // 切换模式清除 Full Access 确认，避免沿用上一次的确认。
      return {
        ...state,
        executionMode: action.executionMode,
        fullAccessConfirmed: false,
      };
    case "confirm_full_access":
      if (state.status === "closed" || state.status === "submitting") return state;
      return { ...state, fullAccessConfirmed: action.confirmed };
    case "select_choice":
      if (state.status === "closed" || state.status === "submitting") return state;
      return { ...state, choice: action.choice };
    case "select_new_branch":
      if (state.status === "closed" || state.status === "submitting") return state;
      return {
        ...state,
        newBranch: action.branch,
        choice: state.choice.kind === "new_worktree"
          ? { ...state.choice, branch: action.branch }
          : state.choice,
      };
    case "select_create_mode":
      if (state.status === "closed" || state.status === "submitting") return state;
      if (state.choice.kind !== "new_worktree") return state;
      if (state.choice.createMode === action.createMode) return state;
      // 切到检出模式清空起点；切回创建模式时预选推荐的本地起始分支。
      const recommended = state.status === "ready"
        ? state.branches?.recommendedBranch ?? ""
        : "";
      return {
        ...state,
        newBranch: "",
        choice: {
          ...state.choice,
          createMode: action.createMode,
          branch: "",
          baseRefKind: "local",
          baseBranch: action.createMode === "new" ? recommended : "",
          baseRemote: null,
        },
      };
    case "select_base_branch":
      if (state.status === "closed" || state.status === "submitting") return state;
      return {
        ...state,
        choice: state.choice.kind === "new_worktree"
          ? {
              ...state.choice,
              baseRefKind: action.baseRefKind,
              baseBranch: action.baseBranch,
              baseRemote: action.baseRemote,
            }
          : state.choice,
      };
    case "loaded":
      if (state.status === "closed" || state.status === "submitting") return state;
      if (action.sequence < state.loadSequence) return state;
      return {
        ...state,
        status: "ready",
        loadSequence: action.sequence,
        branches: action.branches,
        worktrees: action.worktrees,
        loadError: null,
        ...(state.choice.kind === "new_worktree" &&
            state.choice.createMode === "new" &&
            state.choice.baseBranch === ""
          ? {
              choice: {
                kind: "new_worktree" as const,
                createMode: "new" as const,
                baseRefKind: "local" as const,
                baseBranch: action.branches.recommendedBranch ?? "",
                baseRemote: null,
                branch: state.choice.branch,
              },
            }
          : {}),
      };
    case "load_failed":
      if (state.status === "closed" || state.status === "submitting") return state;
      if (action.sequence < state.loadSequence) return state;
      return {
        ...state,
        status: "ready",
        loadSequence: action.sequence,
        branches: null,
        worktrees: null,
        loadError: action.error,
      };
    case "submitting":
      if (state.status === "closed" || state.status === "submitting") return state;
      if (state.executionMode === "full_access" && !state.fullAccessConfirmed) {
        return state;
      }
      return {
        ...state,
        status: "submitting",
        operationId: action.operationId,
      };
    case "fail":
      if (state.status === "closed") return state;
      return { ...state, status: "error", error: action.error };
  }
}

function choiceForSelection(
  selectionKind: "main" | "worktree" | "subdirectory" | "directory" | "unknown",
): WorkspaceChoice {
  switch (selectionKind) {
    case "main":
      return { kind: "main" };
    case "worktree":
      return { kind: "existing_worktree", path: "" };
    case "directory":
      return { kind: "directory" };
    case "subdirectory":
    case "unknown":
      return { kind: "selected_directory" };
  }
}

/** 提交时构造的请求；`selected_directory` 使用令牌绑定的选中路径。 */
export function buildOpenRequest(
  state: ProjectOpenState,
): { executionMode: ExecutionMode; projectKey?: string; selectionToken?: string; workspace: OpenWorkspaceRequest } | null {
  if (state.status !== "submitting" || state.project === null) return null;
  // 本次选择尚未登记时只能用令牌：projectKey 查找依赖已有会话记录。
  const base = state.project.selection !== null
    ? { selectionToken: state.project.selection.selectionToken }
    : { projectKey: state.project.projectKey };
  switch (state.choice.kind) {
    case "main":
      return { executionMode: state.executionMode, ...base, workspace: { kind: "main" } };
    case "existing_worktree":
      return {
        executionMode: state.executionMode,
        ...base,
        workspace: { kind: "existing_worktree", path: state.choice.path },
      };
    case "new_worktree":
      if (state.operationId === null) return null;
      if (state.choice.createMode === "existing") {
        return {
          executionMode: state.executionMode,
          ...base,
          workspace: {
            kind: "new_worktree",
            // 服务端在 checkoutExisting 时以 branch 作为本地起点，忽略 baseBranch。
            baseRefKind: "local",
            baseBranch: state.choice.branch,
            branch: state.choice.branch,
            checkoutExisting: true,
            operationId: state.operationId,
          },
        };
      }
      return {
        executionMode: state.executionMode,
        ...base,
        workspace: {
          kind: "new_worktree",
          baseRefKind: state.choice.baseRefKind,
          baseBranch: state.choice.baseBranch,
          ...(state.choice.baseRemote === null
            ? {}
            : { baseRemote: state.choice.baseRemote }),
          branch: state.choice.branch,
          operationId: state.operationId,
        },
      };
    case "selected_directory":
      return {
        executionMode: state.executionMode,
        ...base,
        workspace: { kind: "selected_directory" },
      };
    case "directory":
      return { executionMode: state.executionMode, ...base, workspace: { kind: "directory" } };
  }
}


