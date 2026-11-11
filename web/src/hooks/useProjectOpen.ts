import { useCallback, useReducer, useRef } from "react";

import { workspaceSelectionErrorMessage } from "../error-messages";
import type { ProjectContext, ProjectOpenState } from "../project-open-state";
import {
  initialProjectOpenState,
  projectOpenReducer,
  projectTypeOf,
} from "../project-open-state";
import {
  getProjectBranches,
  getProjectWorktrees,
  inspectWorkspaceSelection,
  openConversation,
  type ConversationDetail,
  type ProjectBranches,
  type ProjectSelectionInspection,
  type ProjectWorktrees,
} from "../run-client";

export type ProjectOpenAction = Parameters<typeof projectOpenReducer>[1];

/** 侧栏项目入口传入的最小项目信息。 */
export interface SidebarProjectInput {
  readonly key: string;
  readonly name: string;
  readonly root: string;
}

export interface ProjectOpenOptions {
  /** 此刻是否不允许打开项目（运行中、正在删除会话等）。 */
  readonly isBlocked: () => boolean;
  /** 选好目录、服务端建好会话之后调用，由页面切换到这个会话。 */
  readonly onOpened: (conversation: ConversationDetail) => void;
}

/**
 * 新建会话流程：选择项目与工作目录 → 读取分支与已有 worktree → 选择执行模式 →
 * 提交创建。前端不创建文件、不执行 Git；目录识别和 Git 操作都在服务端。
 *
 * 首次通过目录选择器确认的项目用选择令牌完成读取与创建（它可能还没登记），
 * 从侧栏项目进入的已登记项目用项目 key。
 */
export function useProjectOpen({ isBlocked, onOpened }: ProjectOpenOptions) {
  const [state, dispatch] = useReducer(projectOpenReducer, initialProjectOpenState);
  // 上一次请求的序号：只有最新一次读取的响应会写入状态。
  const sequenceRef = useRef(0);
  const submittingRef = useRef(false);
  // 提交时读取最新状态：调用方从渲染闭包里取出 state 可能落后一次 dispatch。
  const stateRef = useRef(state);
  stateRef.current = state;

  /** 读取项目的分支与 worktree 列表；普通目录直接给空列表。 */
  const loadProject = useCallback(async (
    project: ProjectContext,
    inspection: ProjectSelectionInspection | null = null,
  ) => {
    const sequence = sequenceRef.current + 1;
    sequenceRef.current = sequence;
    dispatch(inspection === null
      ? { type: "open_project", project }
      : { type: "inspect", project, selection: inspection });
    if (project.projectType !== "git") {
      dispatch({
        type: "loaded",
        branches: emptyBranches(),
        worktrees: emptyWorktrees(project.root),
        sequence,
      });
      return;
    }
    const query = project.selection !== null
      ? { selectionToken: project.selection.selectionToken }
      : { projectKey: project.projectKey };
    try {
      const [branches, worktrees] = await Promise.all([
        getProjectBranches(query),
        getProjectWorktrees(query),
      ]);
      dispatch({ type: "loaded", branches, worktrees, sequence });
    } catch (error) {
      dispatch({
        type: "load_failed",
        error: workspaceSelectionErrorMessage(error),
        sequence,
      });
    }
  }, []);

  /** 从侧栏项目旁的 `＋` 进入：直接使用该项目，按项目类型给出默认工作目录。 */
  const openProject = useCallback(
    (project: SidebarProjectInput) => {
      void loadProject({
        projectKey: project.key,
        name: project.name,
        root: project.root,
        projectType: projectTypeOf(project.key),
        selection: null,
      });
    },
    [loadProject],
  );

  /** 全局入口：打开系统目录选择器并识别目录，识别后不立即创建会话。 */
  const inspectDirectory = useCallback(async () => {
    if (isBlocked()) return;
    dispatch({ type: "open" });
    let selection: ProjectSelectionInspection;
    try {
      selection = await inspectWorkspaceSelection();
    } catch (error) {
      dispatch({ type: "fail", error: workspaceSelectionErrorMessage(error) });
      return;
    }
    await loadProject(projectContextFromSelection(selection), selection);
  }, [isBlocked, loadProject]);

  /** 提交创建请求；成功后关闭页面并打开新会话。 */
  const submit = useCallback(
    async (buildRequest: (state: ProjectOpenState) => Parameters<typeof openConversation>[0] | null) => {
      if (isBlocked() || submittingRef.current) return;
      const current = stateRef.current;
      if (
        current.status !== "choosing" &&
        current.status !== "ready" &&
        current.status !== "error"
      ) {
        return;
      }
      const operationId = current.choice.kind === "new_worktree"
        ? newOperationId()
        : null;
      submittingRef.current = true;
      dispatch({ type: "submitting", operationId });
      // 用刚算出的提交状态构造请求：operationId 与请求里的完全一致。
      const submitting: ProjectOpenState = {
        ...current,
        status: "submitting",
        operationId,
      };
      const request = buildRequest(submitting);
      if (request === null) {
        submittingRef.current = false;
        dispatch({ type: "fail", error: "新建会话的参数不完整。" });
        return;
      }
      try {
        const result = await openConversation(request);
        if (result.kind === "needs_inspection") {
          submittingRef.current = false;
          dispatch({
            type: "fail",
            error:
              `worktree 创建没有完成：${result.operation.reason}` +
              `（目标目录 ${result.operation.targetPath}）。` +
              "请检查该目录与分支后再试。",
          });
          return;
        }
        dispatch({ type: "succeeded" });
        onOpened(result.conversation);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          submittingRef.current = false;
          return;
        }
        dispatch({ type: "fail", error: workspaceSelectionErrorMessage(error) });
      } finally {
        submittingRef.current = false;
      }
    },
    [isBlocked, onOpened],
  );

  return {
    state,
    dispatch,
    openProject,
    inspectDirectory,
    loadProject,
    submit,
    reset: () => dispatch({ type: "close" }),
  };
}

/**
 * 目录选择器识别结果 → 新建会话页的项目上下文。项目的展示名与锚点取主工作
 * 目录；Git 不可用时退回所选目录。
 */
export function projectContextFromSelection(
  selection: ProjectSelectionInspection,
): ProjectContext {
  const root = selection.mainWorkspace ?? selection.selectedPath;
  const projectKey = selection.projectKey ?? "";
  return {
    projectKey,
    name: lastPathSegment(root),
    root,
    projectType: selection.projectType,
    selection,
  };
}

function lastPathSegment(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function emptyBranches(): ProjectBranches {
  return {
    branches: [],
    remotes: [],
    remoteBranches: [],
    recommendedBranch: null,
    recommendationSource: null,
  };
}

function emptyWorktrees(root: string): ProjectWorktrees {
  return { projectKey: "", mainWorkspace: root, worktrees: [] };
}

/** 生成 worktree 创建操作的 ID；它同时用于定位目标目录和查询结果。 */
export function newOperationId(): string {
  return crypto.randomUUID();
}
