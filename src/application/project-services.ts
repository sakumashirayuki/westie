/**
 * 新建会话的项目与会话装配：把 Git 读取、目录识别、worktree 创建和操作日志
 * 组合成接口层需要的服务。宿主装配在 `server-bootstrap.ts`，测试可传入自定义
 * Git 可执行文件或 worktree 根目录，不需要真实 `~/.westie`。
 */
import { ConversationOpenService } from "./conversation-open-service.js";
import type { ConversationService } from "./conversation-service.js";
import type { ConversationStore } from "./conversation-store.js";
import { GitProjectService } from "./git-project-service.js";
import { ProjectInspection } from "./project-inspection.js";
import { SelectionTokenStore } from "./project-selection-tokens.js";
import type { WorkspaceRuntimeProvider } from "./workspace-runtime.js";
import { GitWorkspaceStatusSource } from "./workspace-status.js";
import type { WorkspaceStatusDependencies } from "./conversation-service.js";
import { GitProcessRunner } from "../infrastructure/git-process-runner.js";
import type { SQLiteWorktreeOperationStore } from "../infrastructure/sqlite/worktree-operation-store.js";
import { WorktreeCreator } from "./worktree-creation.js";

/** 选择令牌有效时间，与产品方案一致：5 分钟。 */
const SELECTION_TOKEN_TTL_MS = 5 * 60 * 1000;

export interface ProjectServicesOptions {
  readonly conversationStore: ConversationStore;
  readonly workspaceRuntimeProvider: WorkspaceRuntimeProvider;
  readonly worktreeOperations: SQLiteWorktreeOperationStore;
  /** 覆盖 Git 可执行文件，测试用它避免依赖宿主安装。 */
  readonly gitExecutable?: string;
  /**
   * 覆盖 `~/.westie/worktrees`，测试用它把 worktree 建在临时目录里。
   * 缺省使用 `GitProjectService` 的默认根目录。
   */
  readonly worktreeRoot?: string;
}

export interface ProjectServices {
  readonly git: GitProjectService;
  readonly gitRunner: GitProcessRunner;
  readonly projectInspection: ProjectInspection;
  readonly worktreeCreator: WorktreeCreator;
  readonly worktreeOperations: SQLiteWorktreeOperationStore;
  readonly selectionTokens: SelectionTokenStore;
  /** 会话读取时使用的项目识别与目录探测依赖。 */
  readonly statusDependencies: WorkspaceStatusDependencies;
  /** 创建会话服务；已完成的操作通过会话服务读取详情。 */
  createOpenService(conversationService: ConversationService): ConversationOpenService;
}

export function createProjectServices(
  options: ProjectServicesOptions,
): ProjectServices {
  const gitRunner = new GitProcessRunner(
    options.gitExecutable === undefined
      ? {}
      : { executable: options.gitExecutable },
  );
  const git = new GitProjectService(gitRunner, options.worktreeRoot);
  const projectInspection = new ProjectInspection(git);
  const worktreeCreator = new WorktreeCreator(git, gitRunner);
  const selectionTokens = new SelectionTokenStore(SELECTION_TOKEN_TTL_MS);
  const statusSource = new GitWorkspaceStatusSource(git);

  return {
    git,
    gitRunner,
    projectInspection,
    worktreeCreator,
    worktreeOperations: options.worktreeOperations,
    selectionTokens,
    statusDependencies: {
      createProbeCache: (projectKey) =>
        statusSource.createCache(projectKey),
      identifyProject: async (canonicalPath) => {
        const inspection = await projectInspection
          .inspect(canonicalPath)
          .catch(() => null);
        // 识别失败（目录不可访问、Git 不可用/超时/输出超限）由 ProjectInspection
        // 返回 null：保留「未识别」并在下次刷新重试。只有确认不在 Git 仓库内的
        // 普通目录才写成 dir:。
        return inspection?.assignment ?? null;
      },
    },
    createOpenService(conversationService) {
      return new ConversationOpenService({
        conversationService,
        conversationStore: options.conversationStore,
        workspaceRuntimeProvider: options.workspaceRuntimeProvider,
        git,
        gitRunner,
        projectInspection,
        worktreeCreator,
        worktreeOperations: options.worktreeOperations,
        selectionTokens,
      });
    },
  };
}
