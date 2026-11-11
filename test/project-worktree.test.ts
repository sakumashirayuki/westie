import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import type { ConversationOpenService } from "../src/application/conversation-open-service.js";
import { ConversationService } from "../src/application/conversation-service.js";
import { createProjectServices } from "../src/application/project-services.js";
import { ConversationRunService } from "../src/application/conversation-run-service.js";
import { InMemoryInteractionBroker } from "../src/application/interaction-broker.js";
import { RunRegistry } from "../src/application/run-registry.js";
import {
  deriveWorkspaceKind,
  GitWorkspaceStatusSource,
} from "../src/application/workspace-status.js";
import { GitProcessRunner } from "../src/infrastructure/git-process-runner.js";
import {
  GitProjectService,
  projectDirectoryName,
} from "../src/application/git-project-service.js";
import { ProjectInspection } from "../src/application/project-inspection.js";
import { AgentController } from "../src/http/agent-controller.js";
import { ProjectWorkspaceRoutes } from "../src/http/project-workspace-routes.js";
import { WorkspaceProjectsRoutes } from "../src/http/workspace-projects-route.js";
import {
  initializeSqliteSchema,
  openSqliteDatabase,
  SQLiteWorktreeOperationStore,
} from "../src/infrastructure/sqlite/index.js";
import { SQLiteConversationStore } from "../src/infrastructure/sqlite/sqlite-conversation-store.js";
import type { ConversationProjectAssignment } from "../src/application/conversation-store.js";
import { HostSandboxRunner } from "../src/sandbox/host-sandbox-runner.js";
import { createAgentServer } from "../src/server.js";

interface GitFixture {
  readonly directory: string;
  readonly repository: string;
  readonly commonDir: string;
  readonly projectKey: string;
  readonly initialCommit: string;
}

/**
 * 用真实 Git 建一个带 origin/HEAD 的小仓库：main 跟踪 origin/main，
 * 另有一个功能分支 feat/base。测试不需要网络，remote 只建本地引用。
 */
async function createGitFixture(t: TestContext): Promise<GitFixture> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agent-project-worktree-")),
  );
  const repository = join(directory, "app");
  const remote = join(directory, "origin.git");
  await mkdir(repository);
  await git(directory, ["init", "--quiet", "--bare", remote]);
  await git(repository, ["init", "--quiet", "-b", "main"]);
  await git(repository, ["config", "user.email", "test@example.com"]);
  await git(repository, ["config", "user.name", "Test"]);
  await writeFile(join(repository, "README.md"), "# fixture\n");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "--quiet", "-m", "init"]);
  await git(repository, ["remote", "add", "origin", remote]);
  await git(repository, ["push", "--quiet", "origin", "main"]);
  await git(repository, ["branch", "--set-upstream-to=origin/main", "main"]);
  await git(repository, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
  await git(repository, ["branch", "feat/base"]);
  const initialCommit = (await git(repository, ["rev-parse", "HEAD"])).trim();
  const commonDir = await realpath(
    join(repository, (await git(repository, ["rev-parse", "--git-common-dir"]))
      .trim()),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    repository,
    commonDir,
    projectKey: `git:${commonDir}`,
    initialCommit,
  };
}

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd }, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

interface ApiFixture {
  readonly origin: string;
  readonly service: ConversationService;
  readonly openService: ConversationOpenService;
  readonly operations: SQLiteWorktreeOperationStore;
  readonly database: ReturnType<typeof openSqliteDatabase>;
  readonly store: SQLiteConversationStore;
  readonly worktreeRoot: string;
  readonly registerProject: (assignment: ConversationProjectAssignment) => void;
  /** 直接写操作日志，模拟「进程在 Git 启动前中断」。 */
  readonly operationsStore: SQLiteWorktreeOperationStore;
  /** 直接签选择令牌，模拟「选择器已确认该目录」。 */
  readonly issueSelectionToken: (path: string) => Promise<string>;
  readonly pickedPath: () => string;
  readonly setPickedPath: (path: string) => void;
}

async function createApiFixture(
  t: TestContext,
  worktreeRoot: string,
): Promise<ApiFixture> {
  const database = openSqliteDatabase(":memory:");
  initializeSqliteSchema(database);
  const store = new SQLiteConversationStore(database);
  const operations = new SQLiteWorktreeOperationStore(database);
  const workspaceRuntimeProvider = {
    async get(workspaceRoot: string, executionMode: "workspace_sandbox" | "full_access") {
      return {
        workspaceRoot,
        executionMode,
        sandboxRunner: new HostSandboxRunner(),
        tools: [],
      };
    },
  };
  const projectServices = createProjectServices({
    conversationStore: store,
    workspaceRuntimeProvider,
    worktreeOperations: operations,
    worktreeRoot,
  });
  const service = new ConversationService(store, {
    statusSource: projectServices.statusDependencies,
  });
  const openService = projectServices.createOpenService(service);
  let pickedPath = "";
  const routes = new WorkspaceProjectsRoutes({
    conversationService: service,
    conversationOpenService: openService,
    selectionTokens: projectServices.selectionTokens,
    projectInspection: projectServices.projectInspection,
    git: projectServices.git,
    hostDirectoryPicker: {
      async pickDirectory() {
        return pickedPath === ""
          ? { status: "cancelled" }
          : { status: "selected", path: pickedPath };
      },
    },
  });
  const runService = new ConversationRunService({
    conversationStore: store,
    loadWorkspaceInstructions: async () => undefined,
    workspaceRuntimeProvider,
    provider: {
      model: "test-model",
      async *stream() {
        throw new Error("Provider should not be called.");
      },
    },
  });
  const server = createAgentServer(
    new AgentController({
      conversationService: service,
      conversationRunService: runService,
      registry: new RunRegistry({ runService }),
      interactionBroker: new InMemoryInteractionBroker(),
      workspaceProjectsRoutes: routes,
      projectWorkspaceRoutes: new ProjectWorkspaceRoutes({
        conversationOpenService: openService,
      }),
      conversationOpenService: openService,
    }),
  );
  const origin = await listen(t, server);
  t.after(() => store.close());
  const registerProject = (assignment: ConversationProjectAssignment): void => {
    // 已登记项目来自「曾经通过目录选择器创建过会话」；测试直接写入同样的归属，
    // 避免为每个用例重复走一次系统选择器。
    store.createConversation(
      assignment.projectRoot,
      "workspace_sandbox",
      assignment,
      "main",
    );

  };
  return {
    origin,
    operationsStore: operations,
    issueSelectionToken: async (path: string) => {
      const identity = await projectServices.projectInspection
        .inspectSelectedDirectory(path);
      return projectServices.selectionTokens.issue({
        selectedPath: identity.selectedPath,
        checkout: identity.checkout,
      });
    },
    registerProject,
    service,
    openService,
    operations,
    database,
    store,
    worktreeRoot,
    pickedPath: () => pickedPath,
    setPickedPath: (path: string) => {
      pickedPath = path;
    },
  };
}

async function listen(t: TestContext, server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => error === undefined ? resolve() : reject(error))
      ),
  );
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function postJson(
  origin: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? {} : JSON.parse(text) as Record<string, unknown>,
  };
}

test("inspect recognizes a worktree checkout and issues a selection token", async (t) => {
  const fixture = await createGitFixture(t);
  const worktreeRoot = join(fixture.directory, "worktrees");
  const api = await createApiFixture(t, worktreeRoot);

  // 外部创建的已有 worktree：应当被识别为同一项目下的 worktree 根。
  const externalWorktree = join(fixture.directory, "app-feature");
  await git(fixture.repository, [
    "worktree",
    "add",
    "--quiet",
    "-b",
    "feat/external",
    externalWorktree,
  ]);
  await mkdir(join(externalWorktree, "src"));
  api.setPickedPath(join(externalWorktree, "src"));

  const inspected = await postJson(
    api.origin,
    "/v1/agent/conversations:select-workspace",
    { action: "inspect" },
  );
  assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
  assert.equal(inspected.body.projectKey, fixture.projectKey);
  assert.equal(inspected.body.projectType, "git");
  assert.equal(inspected.body.mainWorkspace, fixture.repository);
  assert.equal(inspected.body.selectedCheckoutRoot, externalWorktree);
  // 选择的是 checkout 内的子目录：保留精确路径，类型为 subdirectory。
  assert.equal(inspected.body.selectedPath, join(externalWorktree, "src"));
  assert.equal(inspected.body.selectionKind, "subdirectory");
  assert.equal(typeof inspected.body.selectionToken, "string");

  // 识别不创建会话。
  const listed = await api.service.listConversations();
  assert.equal(listed.items.length, 0);
});

test("inspect reports a plain directory without Git options", async (t) => {
  const fixture = await createGitFixture(t);
  const api = await createApiFixture(t, join(fixture.directory, "worktrees"));
  const plain = join(fixture.directory, "notes");
  await mkdir(plain);
  api.setPickedPath(plain);

  const inspected = await postJson(
    api.origin,
    "/v1/agent/conversations:select-workspace",
    { action: "inspect" },
  );
  assert.equal(inspected.status, 200);
  assert.equal(inspected.body.projectType, "directory");
  assert.equal(inspected.body.projectKey, `dir:${plain}`);
  assert.equal(inspected.body.mainWorkspace, plain);
  assert.equal(inspected.body.selectedCheckoutRoot, null);
  assert.equal(inspected.body.selectionKind, "directory");
});

test("opening a session from an existing project groups worktrees under one project", async (t) => {
  const fixture = await createGitFixture(t);
  const worktreeRoot = join(fixture.directory, "worktrees");
  const api = await createApiFixture(t, worktreeRoot);
  api.setPickedPath(fixture.repository);

  const inspected = await postJson(
    api.origin,
    "/v1/agent/conversations:select-workspace",
    { action: "inspect" },
  );
  const selectionToken = inspected.body.selectionToken as string;
  assert.equal(inspected.body.selectionKind, "main");

  // 第一次选择使用令牌在主目录创建会话，令牌随后被消费。
  // 创建后项目已登记，后续请求改用 projectKey。
  const mainSession = await postJson(
    api.origin,
    "/v1/agent/conversations:open",
    {
      selectionToken,
      executionMode: "workspace_sandbox",
      workspace: { kind: "main" },
    },
  );
  assert.equal(mainSession.status, 201);
  const mainWorkspace = mainSession.body.workspace as { canonicalPath: string };
  assert.equal(mainWorkspace.canonicalPath, fixture.repository);

  const reused = await postJson(api.origin, "/v1/agent/conversations:open", {
    selectionToken,
    executionMode: "workspace_sandbox",
    workspace: { kind: "main" },
  });
  assert.equal(reused.status, 409);
  assert.equal(
    (reused.body.error as { code: string }).code,
    "PROJECT_SELECTION_INVALID",
  );

  // 分支接口：main 的 upstream 指向 origin/main，因此推荐本地 main。
  const branches = await fetch(
    `${api.origin}/v1/agent/projects/branches?projectKey=${
      encodeURIComponent(fixture.projectKey)
    }`,
  );
  assert.equal(branches.status, 200);
  assert.deepEqual(await branches.json(), {
    branches: ["feat/base", "main"],
    // 远端分支来自本机已有的 refs/remotes；main 已被本地分支占用。
    remotes: ["origin"],
    remoteBranches: [
      { remote: "origin", name: "main", hasLocalBranch: true },
    ],
    recommendedBranch: "main",
    recommendationSource: "origin/HEAD",
  });

  // 新建 worktree：目录固定在 worktree 根目录下的项目哈希目录里。
  const operationId = "0f0f0f0f-1111-4222-8333-444455556666";
  const created = await postJson(api.origin, "/v1/agent/conversations:open", {
    projectKey: fixture.projectKey,
    executionMode: "workspace_sandbox",
    workspace: {
      kind: "new_worktree",
      baseBranch: "main",
      branch: "feat/evaluation",
      operationId,
    },
  });
  assert.equal(created.status, 201);
  const worktreePath = (created.body.workspace as { canonicalPath: string })
    .canonicalPath;
  assert.ok(worktreePath.startsWith(worktreeRoot));
  assert.ok(worktreePath.endsWith(operationId));
  const worktreeDirectory = worktreePath.slice(0, worktreePath.length - operationId.length - 1);
  assert.equal(
    (await git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(),
    "feat/evaluation",
  );
  assert.equal(
    (await git(worktreePath, ["rev-parse", "HEAD"])).trim(),
    fixture.initialCommit,
  );

  // 重复提交同一个 operationId 返回同一个会话，不重新执行 Git。
  const replayed = await postJson(api.origin, "/v1/agent/conversations:open", {
    projectKey: fixture.projectKey,
    executionMode: "workspace_sandbox",
    workspace: {
      kind: "new_worktree",
      baseBranch: "main",
      branch: "feat/evaluation",
      operationId,
    },
  });
  assert.equal(replayed.status, 201);
  assert.equal(replayed.body.id, created.body.id);

  const operation = await fetch(
    `${api.origin}/v1/agent/worktree-operations/${operationId}`,
  );
  assert.equal(operation.status, 200);
  assert.deepEqual(await operation.json(), {
    operationId,
    status: "completed",
    projectKey: fixture.projectKey,
    projectRoot: fixture.repository,
    targetPath: worktreePath,
    branch: "feat/evaluation",
    baseBranch: "main",
    baseRemote: null,
    baseCommit: fixture.initialCommit,
    executionMode: "workspace_sandbox",
    conversationId: created.body.id,
    inspection: null,
  });

  // 两个会话都在同一项目下，且工作目录类型与分支各自正确。
  const sessions = await fetch(`${api.origin}/v1/agent/conversations`);
  assert.equal(sessions.status, 200);
  const items = (await sessions.json() as {
    items: {
      id: string;
      project: { key: string; name: string } | null;
    }[];
  }).items;
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((item) => item.project?.key),
    [fixture.projectKey, fixture.projectKey],
  );
  assert.equal(items[0]?.project?.name, "app");
  const mainDetail = await fetch(
    `${api.origin}/v1/agent/conversations/${mainSession.body.id as string}`,
  );
  assert.deepEqual(
    (await mainDetail.json() as { workspaceStatus: unknown }).workspaceStatus,
    {
      kind: "main",
      branch: { status: "branch", name: "main" },
      availability: { status: "available" },
    },
  );
  const worktreeDetail = await fetch(
    `${api.origin}/v1/agent/conversations/${created.body.id as string}`,
  );
  assert.deepEqual(
    (await worktreeDetail.json() as { workspaceStatus: unknown }).workspaceStatus,
    {
      kind: "worktree",
      branch: { status: "branch", name: "feat/evaluation" },
      availability: { status: "available" },
    },
  );

  // worktree 列表包含主目录与新建的 worktree。
  const worktrees = await fetch(
    `${api.origin}/v1/agent/projects/worktrees?projectKey=${
      encodeURIComponent(fixture.projectKey)
    }`,
  );
  assert.equal(worktrees.status, 200);
  const listed = await worktrees.json() as {
    mainWorkspace: string;
    worktrees: { path: string; branch: string | null; kind: string }[];
  };
  assert.equal(listed.mainWorkspace, fixture.repository);
  assert.deepEqual(
    listed.worktrees.map((entry) => [entry.path, entry.branch, entry.kind]),
    [
      [fixture.repository, "main", "main"],
      [worktreePath, "feat/evaluation", "worktree"],
    ],
  );
});

test("a conflicting branch keeps user input and creates no session", async (t) => {
  const fixture = await createGitFixture(t);
  const api = await createApiFixture(t, join(fixture.directory, "worktrees"));
  api.setPickedPath(fixture.repository);
  const inspected = await postJson(
    api.origin,
    "/v1/agent/conversations:select-workspace",
    { action: "inspect" },
  );
  const created = await postJson(api.origin, "/v1/agent/conversations:open", {
    selectionToken: inspected.body.selectionToken,
    executionMode: "workspace_sandbox",
    workspace: { kind: "main" },
  });
  assert.equal(created.status, 201);

  const conflict = await postJson(api.origin, "/v1/agent/conversations:open", {
    projectKey: fixture.projectKey,
    executionMode: "workspace_sandbox",
    workspace: {
      kind: "new_worktree",
      baseBranch: "main",
      branch: "feat/base",
      operationId: "0f0f0f0f-1111-4222-8333-444455556666",
    },
  });
  assert.equal(conflict.status, 409);
  assert.equal(
    (conflict.body.error as { code: string }).code,
    "WORKTREE_BRANCH_INVALID",
  );
  assert.equal(
    (await api.service.listConversations()).items.length,
    1,
  );
});

test("checking out an existing local branch opens a worktree without a new branch", async (t) => {
  const fixture = await createGitFixture(t);
  const worktreeRoot = join(fixture.directory, "worktrees");
  const api = await createApiFixture(t, worktreeRoot);
  api.registerProject({
    projectKey: fixture.projectKey,
    projectRoot: fixture.repository,
  });

  // fixture 预置了本地分支 feat/base，且没有任何工作目录检出它。
  const operationId = "5e5e5e5e-6666-4777-8888-9999aaaabbbb";
  const created = await postJson(api.origin, "/v1/agent/conversations:open", {
    projectKey: fixture.projectKey,
    executionMode: "workspace_sandbox",
    workspace: {
      kind: "new_worktree",
      baseRefKind: "local",
      baseBranch: "feat/base",
      branch: "feat/base",
      checkoutExisting: true,
      operationId,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const worktreePath = (created.body.workspace as { canonicalPath: string })
    .canonicalPath;
  assert.ok(worktreePath.startsWith(worktreeRoot));
  // 新目录直接检出 feat/base，没有创建新分支。
  assert.equal(
    (await git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(),
    "feat/base",
  );
  assert.equal(
    (await git(worktreePath, ["rev-parse", "HEAD"])).trim(),
    fixture.initialCommit,
  );

  // 操作日志把被检出的分支同时记为分支名与起点，且没有远端起点。
  const operation = await fetch(
    `${api.origin}/v1/agent/worktree-operations/${operationId}`,
  );
  assert.equal(operation.status, 200);
  assert.deepEqual(await operation.json(), {
    operationId,
    status: "completed",
    projectKey: fixture.projectKey,
    projectRoot: fixture.repository,
    targetPath: worktreePath,
    branch: "feat/base",
    baseBranch: "feat/base",
    baseRemote: null,
    baseCommit: fixture.initialCommit,
    executionMode: "workspace_sandbox",
    conversationId: created.body.id,
    inspection: null,
  });

  // feat/base 已被新目录占用，再次检出必须被拒绝。
  const replayed = await postJson(api.origin, "/v1/agent/conversations:open", {
    projectKey: fixture.projectKey,
    executionMode: "workspace_sandbox",
    workspace: {
      kind: "new_worktree",
      baseRefKind: "local",
      baseBranch: "feat/base",
      branch: "feat/base",
      checkoutExisting: true,
      operationId: "6e6e6e6e-7777-4888-9999-aaaabbbbcccc",
    },
  });
  assert.equal(replayed.status, 409);
  assert.equal(
    (replayed.body.error as { code: string }).code,
    "WORKTREE_BRANCH_INVALID",
  );
});

test("checking out an existing branch rejects missing branches, occupied branches and remote bases", async (t) => {
  const fixture = await createGitFixture(t);
  const api = await createApiFixture(t, join(fixture.directory, "worktrees"));
  api.registerProject({
    projectKey: fixture.projectKey,
    projectRoot: fixture.repository,
  });

  // 本地不存在的分支：校验阶段拒绝，不产生会话。
  const missing = await postJson(api.origin, "/v1/agent/conversations:open", {
    projectKey: fixture.projectKey,
    executionMode: "workspace_sandbox",
    workspace: {
      kind: "new_worktree",
      baseRefKind: "local",
      baseBranch: "feat/never-existed",
      branch: "feat/never-existed",
      checkoutExisting: true,
      operationId: "7e7e7e7e-8888-4999-aaaa-bbbbccccdddd",
    },
  });
  assert.equal(missing.status, 409);
  assert.equal(
    (missing.body.error as { code: string }).code,
    "WORKTREE_BRANCH_INVALID",
  );

  // main 已在主工作目录检出：Git 不允许同一分支检出两次。
  const occupied = await postJson(api.origin, "/v1/agent/conversations:open", {
    projectKey: fixture.projectKey,
    executionMode: "workspace_sandbox",
    workspace: {
      kind: "new_worktree",
      baseRefKind: "local",
      baseBranch: "main",
      branch: "main",
      checkoutExisting: true,
      operationId: "8e8e8e8e-9999-4aaa-bbbb-ccccddddeeee",
    },
  });
  assert.equal(occupied.status, 409);
  assert.equal(
    (occupied.body.error as { code: string }).code,
    "WORKTREE_BRANCH_INVALID",
  );
  assert.match(
    (occupied.body.error as { message: string }).message,
    /已在工作目录/,
  );

  // 检出已有分支只支持本地分支：远端起点在参数校验阶段以 400 拒绝。
  const remote = await postJson(api.origin, "/v1/agent/conversations:open", {
    projectKey: fixture.projectKey,
    executionMode: "workspace_sandbox",
    workspace: {
      kind: "new_worktree",
      baseRefKind: "remote",
      baseRemote: "origin",
      baseBranch: "main",
      branch: "main",
      checkoutExisting: true,
      operationId: "9e9e9e9e-aaaa-4bbb-8ccc-ddddeeeeffff",
    },
  });
  assert.equal(remote.status, 400);
  assert.equal(
    (remote.body.error as { code: string }).code,
    "WORKTREE_BRANCH_INVALID",
  );

  // 所有失败都没有新增会话。
  assert.equal((await api.service.listConversations()).items.length, 1);
});

test("a prepared checkout operation resumes by checking out the existing branch", async (t) => {
  const fixture = await createGitFixture(t);
  const worktreeRoot = join(fixture.directory, "worktrees");
  const api = await createApiFixture(t, worktreeRoot);
  api.registerProject({
    projectKey: fixture.projectKey,
    projectRoot: fixture.repository,
  });
  const operationId = "aeaeaeae-bbbb-4ccc-9ddd-eeeeffff0000";
  const targetPath = join(worktreeRoot, "deadbeef", operationId);
  // 模拟检出已有分支的请求在启动 Git 前中断：起点与分支同名且分支已存在。
  api.operationsStore.prepare({
    id: operationId,
    projectKey: fixture.projectKey,
    projectRoot: fixture.repository,
    targetPath,
    branch: "feat/base",
    baseBranch: "feat/base",
    baseRemote: null,
    baseCommit: fixture.initialCommit,
    executionMode: "workspace_sandbox",
  });

  const created = await postJson(api.origin, "/v1/agent/conversations:open", {
    projectKey: fixture.projectKey,
    executionMode: "workspace_sandbox",
    workspace: {
      kind: "new_worktree",
      baseRefKind: "local",
      baseBranch: "feat/base",
      branch: "feat/base",
      checkoutExisting: true,
      operationId,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(
    (created.body.workspace as { canonicalPath: string }).canonicalPath,
    targetPath,
  );
  assert.equal(
    (await git(targetPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(),
    "feat/base",
  );
});

test("registered projects remain accessible beyond 2000 newer conversations", async (t) => {
  const fixture = await createGitFixture(t);
  const api = await createApiFixture(t, join(fixture.directory, "worktrees"));
  const insert = api.database.prepare(`
    INSERT INTO conversations (id, workspace_root, execution_mode, created_at, updated_at, project_key, project_root)
    VALUES (?, ?, 'workspace_sandbox', '2026-01-01', ?, ?, ?)
  `);
  insert.run("old-project", fixture.repository, "2026-01-01", fixture.projectKey, fixture.repository);
  for (let i = 0; i < 2001; i += 1) {
    insert.run(`new-${i}`, "/other", "2026-02-01", "dir:/other", "/other");
  }
  const response = await fetch(
    `${api.origin}/v1/agent/projects/branches?projectKey=${encodeURIComponent(fixture.projectKey)}`,
  );
  assert.equal(response.status, 200);
  const body = await response.json() as { branches: string[] };
  assert.ok(body.branches.includes("main"));
  assert.equal(await api.openService.findRegisteredProject("git:missing"), undefined);
  insert.run("new-project", "/new-project", "2026-03-01", fixture.projectKey, "/new-project");
  assert.deepEqual(await api.openService.findRegisteredProject(fixture.projectKey), {
    key: fixture.projectKey,
    root: "/new-project",
  });
  const plan = api.database.prepare(`EXPLAIN QUERY PLAN SELECT project_key, project_root
    FROM conversations WHERE project_key = ? ORDER BY updated_at DESC, id DESC LIMIT 1`).all(fixture.projectKey);
  assert.match(JSON.stringify(plan), /conversations_project_key_updated_at_id_idx/);
});

test("unknown projects and untrusted origins are rejected", async (t) => {
  const fixture = await createGitFixture(t);
  const api = await createApiFixture(t, join(fixture.directory, "worktrees"));
  api.registerProject({
    projectKey: fixture.projectKey,
    projectRoot: fixture.repository,
  });
  const created = await postJson(api.origin, "/v1/agent/conversations:open", {
    projectKey: fixture.projectKey,
    executionMode: "workspace_sandbox",
    workspace: { kind: "main" },
  });
  assert.equal(created.status, 201);

  const missingProject = await fetch(
    `${api.origin}/v1/agent/projects/branches?projectKey=${
      encodeURIComponent(`git:${join(fixture.directory, "missing", ".git")}`)
    }`,
  );
  assert.equal(missingProject.status, 404);

  const untrusted = await fetch(
    `${api.origin}/v1/agent/projects/branches?projectKey=${
      encodeURIComponent(fixture.projectKey)
    }`,
    { headers: { origin: "https://example.com" } },
  );
  assert.equal(untrusted.status, 403);

  const invalidBody = await postJson(
    api.origin,
    "/v1/agent/conversations:open",
    {
      projectKey: fixture.projectKey,
      executionMode: "workspace_sandbox",
      workspace: { kind: "existing_worktree", path: 42 },
    },
  );
  assert.equal(invalidBody.status, 422);
});

test("restart recovery turns unfinished operations into needs_inspection", async (t) => {
  const fixture = await createGitFixture(t);
  const worktreeRoot = join(fixture.directory, "worktrees");
  const api = await createApiFixture(t, worktreeRoot);
  api.registerProject({
    projectKey: fixture.projectKey,
    projectRoot: fixture.repository,
  });
  const operationId = "0f0f0f0f-1111-4222-8333-444455556666";
  const targetPath = join(worktreeRoot, "deadbeef", operationId);
  api.operations.prepare({
    id: operationId,
    projectKey: fixture.projectKey,
    projectRoot: fixture.repository,
    targetPath,
    branch: "feat/interrupted",
    baseBranch: "main",
    baseRemote: null,
    baseCommit: fixture.initialCommit,
    executionMode: "workspace_sandbox",
  });
  assert.equal(api.operations.markStarted(operationId), true);

  // 服务启动时的恢复：未完成的 prepared / started 操作统一转为需要检查。
  assert.equal(api.operations.markInterruptedOperations(), 1);

  const operation = await fetch(
    `${api.origin}/v1/agent/worktree-operations/${operationId}`,
  );
  assert.equal(operation.status, 200);
  const body = await operation.json() as {
    status: string;
    inspection: { directoryExists: boolean; registered: boolean };
  };
  assert.equal(body.status, "needs_inspection");
  assert.deepEqual(body.inspection, {
    directoryExists: false,
    registered: false,
    registeredBranch: null,
  });

  // 用同一个 operationId 重试不再执行 Git，直接报告需要检查。
  const retried = await postJson(api.origin, "/v1/agent/conversations:open", {
    projectKey: fixture.projectKey,
    executionMode: "workspace_sandbox",
    workspace: {
      kind: "new_worktree",
      baseBranch: "main",
      branch: "feat/interrupted",
      operationId,
    },
  });
  assert.equal(retried.status, 500);
  assert.equal(
    (retried.body.error as { code: string }).code,
    "WORKTREE_NEEDS_INSPECTION",
  );
  // 中断的创建不会产生会话；登记项目的那条会话仍然可见。
  assert.equal((await api.service.listConversations()).items.length, 1);
});

test("the stored operation log keeps prepared operations at their base commit", () => {
  const database = openSqliteDatabase(":memory:");
  initializeSqliteSchema(database);
  const operations = new SQLiteWorktreeOperationStore(database);
  const prepared = operations.prepare({
    id: "0f0f0f0f-1111-4222-8333-444455556666",
    projectKey: "git:/tmp/app/.git",
    projectRoot: "/tmp/app",
    targetPath: "/tmp/worktrees/abc/0f0f0f0f-1111-4222-8333-444455556666",
    branch: "feat/evaluation",
    baseBranch: "main",
    baseRemote: null,
    baseCommit: "a".repeat(40),
    executionMode: "workspace_sandbox",
  });
  assert.equal(prepared.created, true);
  assert.equal(prepared.record.status, "prepared");

  // 同一 id 再次登记不覆盖已固定的起点 commit。
  const duplicate = operations.prepare({
    id: "0f0f0f0f-1111-4222-8333-444455556666",
    projectKey: "git:/tmp/app/.git",
    projectRoot: "/tmp/app",
    targetPath: "/tmp/worktrees/abc/other",
    branch: "feat/other",
    baseBranch: "main",
    baseRemote: null,
    baseCommit: "b".repeat(40),
    executionMode: "workspace_sandbox",
  });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.record.baseCommit, "a".repeat(40));
  assert.equal(duplicate.record.branch, "feat/evaluation");

  // 目标路径唯一：另一个操作不能占用同一目录。
  assert.throws(() =>
    operations.prepare({
      id: "1f0f0f0f-1111-4222-8333-444455556666",
      projectKey: "git:/tmp/app/.git",
      projectRoot: "/tmp/app",
      targetPath: "/tmp/worktrees/abc/0f0f0f0f-1111-4222-8333-444455556666",
      branch: "feat/third",
      baseBranch: "main",
      baseRemote: null,
      baseCommit: "c".repeat(40),
      executionMode: "workspace_sandbox",
    })
  );

  assert.equal(operations.markStarted(duplicate.record.id), true);
  assert.equal(operations.markStarted(duplicate.record.id), false);
  database.close();
});

test("workspace kind falls back to stored values when Git is unreadable", () => {
  const probe = {
    availability: { status: "available" } as const,
    branch: { status: "unknown" } as const,
    checkoutRoot: null,
    checkoutKind: null,
    insideManagedWorktreeRoot: true,
  };
  assert.equal(
    deriveWorkspaceKind(
      { canonicalPath: "/tmp/worktrees/x/y", knownKind: "worktree" },
      probe,
    ),
    "worktree",
  );
  assert.equal(
    deriveWorkspaceKind({ canonicalPath: "/tmp/plain" }, probe),
    "worktree",
  );
  assert.equal(
    deriveWorkspaceKind(
      { canonicalPath: "/tmp/plain" },
      { ...probe, insideManagedWorktreeRoot: false },
    ),
    "directory",
  );
  assert.equal(
    deriveWorkspaceKind(
      { canonicalPath: "/tmp/repo/src" },
      {
        ...probe,
        checkoutRoot: "/tmp/repo",
        checkoutKind: "main",
        insideManagedWorktreeRoot: false,
      },
    ),
    "subdirectory",
  );
});

test("a first-time selected Git project reads branches and worktrees with the token", async (t) => {
  const fixture = await createGitFixture(t);
  const api = await createApiFixture(t, join(fixture.directory, "worktrees"));
  api.setPickedPath(fixture.repository);
  const inspected = await postJson(
    api.origin,
    "/v1/agent/conversations:select-workspace",
    { action: "inspect" },
  );
  const token = inspected.body.selectionToken as string;

  // 项目尚未登记（没有会话记录），只靠令牌也能读分支与 worktree。
  const branches = await fetch(
    `${api.origin}/v1/agent/projects/branches?selectionToken=${encodeURIComponent(token)}`,
  );
  assert.equal(branches.status, 200);
  assert.equal(
    (await branches.json() as { recommendedBranch: string }).recommendedBranch,
    "main",
  );
  const worktrees = await fetch(
    `${api.origin}/v1/agent/projects/worktrees?selectionToken=${encodeURIComponent(token)}`,
  );
  assert.equal(worktrees.status, 200);
  assert.equal(
    (await worktrees.json() as { mainWorkspace: string }).mainWorkspace,
    fixture.repository,
  );

  // 令牌 + main 创建会话：服务端按令牌解析项目并写入归属。
  const created = await postJson(api.origin, "/v1/agent/conversations:open", {
    selectionToken: token,
    executionMode: "workspace_sandbox",
    workspace: { kind: "main" },
  });
  assert.equal(created.status, 201);
  assert.equal(
    (created.body.project as { key: string }).key,
    fixture.projectKey,
  );

  const neither = await fetch(`${api.origin}/v1/agent/projects/branches`);
  assert.equal(neither.status, 400);
});

test("a plain directory selected from the picker can create a session", async (t) => {
  const fixture = await createGitFixture(t);
  const api = await createApiFixture(t, join(fixture.directory, "worktrees"));
  const plain = join(fixture.directory, "notes");
  await mkdir(plain);
  api.setPickedPath(plain);
  const inspected = await postJson(
    api.origin,
    "/v1/agent/conversations:select-workspace",
    { action: "inspect" },
  );
  assert.equal(inspected.body.projectType, "directory");

  // 普通目录不属于 Git：分支与 worktree 查询返回空列表，不报错。
  const branches = await fetch(
    `${api.origin}/v1/agent/projects/branches?selectionToken=${
      encodeURIComponent(inspected.body.selectionToken as string)
    }`,
  );
  assert.equal(branches.status, 200);
  assert.deepEqual(await branches.json(), {
    branches: [],
    remotes: [],
    remoteBranches: [],
    recommendedBranch: null,
    recommendationSource: null,
  });

  const created = await postJson(api.origin, "/v1/agent/conversations:open", {
    selectionToken: inspected.body.selectionToken,
    executionMode: "workspace_sandbox",
    workspace: { kind: "directory" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(
    (created.body.workspace as { canonicalPath: string }).canonicalPath,
    plain,
  );
  assert.deepEqual(created.body.project, {
    key: `dir:${plain}`,
    root: plain,
    name: "notes",
  });

  // 历史上可能存在未写入项目归属的普通目录会话；刷新列表时应持久补齐。
  const legacy = api.store.createConversation(
    plain,
    "workspace_sandbox",
  );
  const listed = await fetch(`${api.origin}/v1/agent/conversations`);
  assert.equal(listed.status, 200);
  const listedLegacy = (await listed.json() as {
    items: { id: string; project: { key: string } | null }[];
  }).items.find((item) => item.id === legacy.id);
  assert.deepEqual(listedLegacy?.project, {
    key: `dir:${plain}`,
    root: plain,
    name: "notes",
  });
  const persisted = api.store.getConversation(legacy.id);
  assert.equal(persisted.project?.key, `dir:${plain}`);
  assert.equal(persisted?.workspaceKind, "directory");

  // 已登记的普通目录项目也能再开一个会话。
  const again = await postJson(api.origin, "/v1/agent/conversations:open", {
    projectKey: `dir:${plain}`,
    executionMode: "workspace_sandbox",
    workspace: { kind: "directory" },
  });
  assert.equal(again.status, 201);
});

test("a directory whose Git identity cannot be read keeps an unidentified session", async (t) => {
  const fixture = await createGitFixture(t);
  const worktreeRoot = join(fixture.directory, "worktrees");
  const api = await createApiFixture(t, worktreeRoot);
  const repository = join(fixture.directory, "fresh");
  await mkdir(repository);
  await git(repository, ["init", "--quiet", "-b", "main"]);
  await git(repository, ["config", "user.email", "test@example.com"]);
  await git(repository, ["config", "user.name", "Test"]);
  await writeFile(join(repository, "README.md"), "# fresh\n");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "--quiet", "-m", "init"]);
  const repositoryCommonDir = await realpath(
    join(repository, (await git(repository, ["rev-parse", "--git-common-dir"])).trim()),
  );
  // 用绝对路径直接签令牌：模拟「选择器已确认该目录，随后 Git 元数据才不可用」。
  const token = await api.issueSelectionToken(repository);

  // 令牌签发后 Git 元数据被移走：重新识别只能看到「目录不在 Git 仓库内」，
  // 但令牌已经记录过这是一个 Git 项目。属于「Git 暂时没读到」，按未识别归属
  // 创建会话，不把它写成普通目录（dir:）。
  await rename(join(repository, ".git"), join(repository, ".git-moved"));
  const created = await postJson(api.origin, "/v1/agent/conversations:open", {
    selectionToken: token,
    executionMode: "workspace_sandbox",
    workspace: { kind: "selected_directory" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.project, null);
  assert.equal(created.body.workspaceKind, "main");

  // 列表首次读取会再识别一次（Git 仍不可读则保持 NULL），这里只检查最终归属。
  const listed = await fetch(`${api.origin}/v1/agent/conversations`);
  const items = (await listed.json() as {
    items: { project: { key: string } | null; workspace: { name: string } }[];
  }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.project, null);
  const detail = await fetch(
    `${api.origin}/v1/agent/conversations/${created.body.id as string}`,
  );
  assert.equal(detail.status, 200);
  assert.equal(
    (await detail.json() as { workspace: { canonicalPath: string } }).workspace
      .canonicalPath,
    repository,
  );

  // 兼容旧版本已经写入的占位 directory 类型。
  api.database.prepare(
    "UPDATE conversations SET workspace_kind = 'directory' WHERE id = $id",
  ).run({ $id: created.body.id as string });
  const gitTypedLegacy = api.store.createConversation(
    repository,
    "workspace_sandbox",
    undefined,
    "main",
  );

  // Git 恢复后，原先的占位 directory 类型必须重新探测并持久修复为项目归属。
  await rename(join(repository, ".git-moved"), join(repository, ".git"));
  const recovered = await fetch(`${api.origin}/v1/agent/conversations`);
  const recoveredItems = (await recovered.json() as {
    items: { project: { key: string } | null }[];
  }).items;
  assert.equal(recoveredItems[0]?.project?.key, `git:${repositoryCommonDir}`);
  const persisted = api.store.getConversation(created.body.id as string);
  assert.equal(persisted.project?.key, `git:${repositoryCommonDir}`);
  assert.equal(persisted.workspaceKind, "main");
  const gitTypedPersisted = api.store.getConversation(gitTypedLegacy.id);
  assert.equal(gitTypedPersisted.project?.key, `git:${repositoryCommonDir}`);
  assert.equal(gitTypedPersisted.workspaceKind, "main");
});

test("a Git process failure while listing worktrees degrades one session", async (t) => {
  const fixture = await createGitFixture(t);
  const api = await createApiFixture(t, join(fixture.directory, "worktrees"));
  api.setPickedPath(fixture.repository);
  const inspected = await postJson(
    api.origin,
    "/v1/agent/conversations:select-workspace",
    { action: "inspect" },
  );
  const created = await postJson(api.origin, "/v1/agent/conversations:open", {
    selectionToken: inspected.body.selectionToken,
    executionMode: "workspace_sandbox",
    workspace: { kind: "main" },
  });
  assert.equal(created.status, 201);

  // `worktree list` 进程失败（超时、输出超限、被杀）：只让这一条降级为未知
  // 状态，列表与详情仍然可用。
  const runner = new GitProcessRunner({
    executable: failingWrapper(fixture, "worktree", "list"),
  });
  const git = new GitProjectService(runner, join(fixture.directory, "worktrees"));
  const service = new ConversationService(
    api.store,
    {
      statusSource: {
        createProbeCache: (projectKey) =>
          new GitWorkspaceStatusSource(git).createCache(projectKey),
        identifyProject: async () => null,
      },
    },
  );

  const page = await service.listConversations();
  assert.equal(page.items.length, 1);
  assert.deepEqual(page.items[0]?.workspaceStatus.branch, { status: "unknown" });
  assert.deepEqual(page.items[0]?.workspaceStatus.availability, {
    status: "available",
  });
  const detail = await service.getConversation(created.body.id as string);
  assert.deepEqual(detail.workspaceStatus.branch, { status: "unknown" });
});

test("a failing git worktree list never turns a project into a plain directory", async (t) => {
  const fixture = await createGitFixture(t);
  const runner = new GitProcessRunner({
    executable: failingWrapper(fixture, "worktree", "list"),
  });
  const git = new GitProjectService(runner, join(fixture.directory, "worktrees"));
  const inspection = new ProjectInspection(git);
  // Git 进程失败属于「暂时无法判断」：识别返回 null（保留未识别），
  // 不会签发 dir: 归属。
  assert.equal(await inspection.inspect(fixture.repository), null);
  await assert.rejects(
    inspection.verify({ projectKey: fixture.projectKey, projectRoot: fixture.repository }),
  );
});

/**
 * 生成一个 shell 包装脚本：指定子命令失败（模拟超时/被杀），其余原样执行。
 * 用固定可执行文件避免 GitProjectService 内部走默认 `git`。
 */
function failingWrapper(
  fixture: GitFixture,
  command: string,
  subcommand: string,
): string {
  const script = join(fixture.directory, `user-bin-${command}-${subcommand}`);
  mkdirSync(script, { recursive: true });
  const wrapperPath = join(script, "git");
  writeFileSync(
    wrapperPath,
    `#!/bin/sh
if [ "$1" = "${command}" ] && [ "$2" = "${subcommand}" ]; then
  echo "simulated failure" >&2
  exit 1
fi
exec /usr/bin/git "$@"
`,
    { mode: 0o755 },
  );
  return wrapperPath;
}

test("a prepared operation whose request died resumes with the same base commit", async (t) => {
  const fixture = await createGitFixture(t);
  const worktreeRoot = join(fixture.directory, "worktrees");
  const api = await createApiFixture(t, worktreeRoot);
  api.registerProject({
    projectKey: fixture.projectKey,
    projectRoot: fixture.repository,
  });
  const operationId = "0f0f0f0f-1111-4222-8333-444455556666";
  const targetPath = join(worktreeRoot, "deadbeef", operationId);
  // 上一次请求在登记 prepared 之后、启动 Git 之前中断。
  api.operationsStore.prepare({
    id: operationId,
    projectKey: fixture.projectKey,
    projectRoot: fixture.repository,
    targetPath,
    branch: "feat/resumed",
    baseBranch: "main",
    baseRemote: null,
    baseCommit: fixture.initialCommit,
    executionMode: "workspace_sandbox",
  });

  const created = await postJson(api.origin, "/v1/agent/conversations:open", {
    projectKey: fixture.projectKey,
    executionMode: "workspace_sandbox",
    workspace: {
      kind: "new_worktree",
      baseBranch: "main",
      branch: "feat/resumed",
      operationId,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(
    (created.body.workspace as { canonicalPath: string }).canonicalPath,
    targetPath,
  );
  assert.equal(
    (await git(targetPath, ["rev-parse", "HEAD"])).trim(),
    fixture.initialCommit,
  );
});

/**
 * 远端起点用例：`origin` 上有 `feat/remote`，本机从未 fetch 过它（只有 ref
 * 不存在），用来验证创建前的 `git fetch` 与起点固定。
 */
async function pushRemoteOnlyBranch(
  fixture: GitFixture,
  branch: string,
): Promise<string> {
  // 用第二个工作目录推一个新 commit，避免改动主目录的 main。
  const worktree = join(fixture.directory, "remote-committer");
  await git(fixture.repository, [
    "worktree",
    "add",
    "--quiet",
    "-b",
    "committer",
    worktree,
  ]);
  await writeFile(join(worktree, "REMOTE.md"), `# ${branch}\n`);
  await git(worktree, ["add", "REMOTE.md"]);
  await git(worktree, ["commit", "--quiet", "-m", `remote ${branch}`]);
  await git(worktree, ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
  const commit = (await git(worktree, ["rev-parse", "HEAD"])).trim();
  await git(fixture.repository, ["worktree", "remove", "--force", worktree]);
  // push 会顺带更新本机的 refs/remotes/origin/<branch>；删掉它才等于「本机从未
  // fetch 过这个远端分支」。
  await git(fixture.repository, [
    "update-ref",
    "-d",
    `refs/remotes/origin/${branch}`,
  ]);
  assert.equal(
    (await git(fixture.repository, ["rev-parse", "--verify", `refs/remotes/origin/${branch}`])
      .catch(() => "")).trim(),
    "",
  );
  return commit;
}

test("a remote branch that is not fetched locally becomes the new worktree base", async (t) => {
  const fixture = await createGitFixture(t);
  const worktreeRoot = join(fixture.directory, "worktrees");
  const api = await createApiFixture(t, worktreeRoot);
  api.registerProject({
    projectKey: fixture.projectKey,
    projectRoot: fixture.repository,
  });
  const remoteCommit = await pushRemoteOnlyBranch(fixture, "feat/remote");
  // 目标目录固定在 worktree 根目录下的项目哈希目录里。
  const projectDirectory = join(worktreeRoot, projectDirectoryName(fixture.projectKey));

  const operationId = "1e1e1e1e-2222-4333-8444-555566667777";
  const created = await postJson(api.origin, "/v1/agent/conversations:open", {
    projectKey: fixture.projectKey,
    executionMode: "workspace_sandbox",
    workspace: {
      kind: "new_worktree",
      baseRefKind: "remote",
      baseRemote: "origin",
      baseBranch: "feat/remote",
      branch: "feat/from-remote",
      operationId,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const worktreePath = (created.body.workspace as { canonicalPath: string })
    .canonicalPath;
  assert.equal(worktreePath, join(projectDirectory, operationId));

  // 起点是 fetch 之后的远端 commit，新分支跟踪该远端分支。
  assert.equal(
    (await git(worktreePath, ["rev-parse", "HEAD"])).trim(),
    remoteCommit,
  );
  assert.equal(
    (await git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(),
    "feat/from-remote",
  );
  // 起点是 `<remote>/<branch>` 形式的 ref 时 Git 会设置同名 upstream
  // （`refs/heads/feat/remote`）；这里是已固定的 commit，因此不再设置。
  assert.equal(
    (await git(worktreePath, ["rev-parse", "--abbrev-ref", "@{upstream}"])
      .catch(() => "")).trim(),
    "",
  );

  // 刷新后的远端 ref 让该分支出现在分支列表里；本地新分支已占用同名。
  const branches = await fetch(
    `${api.origin}/v1/agent/projects/branches?projectKey=${
      encodeURIComponent(fixture.projectKey)
    }`,
  );
  const body = await branches.json() as {
    remoteBranches: { remote: string; name: string; hasLocalBranch: boolean }[];
  };
  assert.deepEqual(
    body.remoteBranches.filter((entry) => entry.name === "feat/remote"),
    [{ remote: "origin", name: "feat/remote", hasLocalBranch: false }],
  );

  // 操作日志保留远端起点：base_branch 在库里是 origin/feat/remote。
  const operation = await fetch(
    `${api.origin}/v1/agent/worktree-operations/${operationId}`,
  );
  assert.deepEqual(await operation.json(), {
    operationId,
    status: "completed",
    projectKey: fixture.projectKey,
    projectRoot: fixture.repository,
    targetPath: worktreePath,
    branch: "feat/from-remote",
    baseBranch: "origin/feat/remote",
    baseRemote: "origin",
    baseCommit: remoteCommit,
    executionMode: "workspace_sandbox",
    conversationId: created.body.id,
    inspection: null,
  });
});

test("a remote base fails before any write when the fetch cannot find the branch", async (t) => {
  const fixture = await createGitFixture(t);
  const worktreeRoot = join(fixture.directory, "worktrees");
  const api = await createApiFixture(t, worktreeRoot);
  api.registerProject({
    projectKey: fixture.projectKey,
    projectRoot: fixture.repository,
  });

  const projectDirectory = join(worktreeRoot, projectDirectoryName(fixture.projectKey));
  const operationId = "2e2e2e2e-2222-4333-8444-555566667777";
  const failed = await postJson(api.origin, "/v1/agent/conversations:open", {
    projectKey: fixture.projectKey,
    executionMode: "workspace_sandbox",
    workspace: {
      kind: "new_worktree",
      baseRefKind: "remote",
      baseRemote: "origin",
      baseBranch: "feat/missing",
      branch: "feat/never",
      operationId,
    },
  });
  assert.equal(failed.status, 409);
  assert.equal(
    (failed.body.error as { code: string }).code,
    "WORKTREE_FETCH_FAILED",
  );
  // 拉取失败不产生操作记录、目录或本地分支，用户可以直接重试。
  assert.equal(api.operations.read(operationId), undefined);
  assert.equal(
    await realpath(join(projectDirectory, operationId))
      .then(() => true, () => false),
    false,
  );
  assert.equal(
    (await git(fixture.repository, ["rev-parse", "--verify", "refs/heads/feat/never"])
      .catch(() => "")).trim(),
    "",
  );
});

test("a remote base requires the remote name", async (t) => {
  const fixture = await createGitFixture(t);
  const api = await createApiFixture(t, join(fixture.directory, "worktrees"));
  api.registerProject({
    projectKey: fixture.projectKey,
    projectRoot: fixture.repository,
  });

  const missingRemote = await postJson(
    api.origin,
    "/v1/agent/conversations:open",
    {
      projectKey: fixture.projectKey,
      executionMode: "workspace_sandbox",
      workspace: {
        kind: "new_worktree",
        baseRefKind: "remote",
        baseBranch: "feat/remote",
        branch: "feat/new",
        operationId: "3e3e3e3e-2222-4333-8444-555566667777",
      },
    },
  );
  assert.equal(missingRemote.status, 400);
  assert.equal(
    (missingRemote.body.error as { code: string }).code,
    "WORKTREE_BRANCH_INVALID",
  );

  // 同一 operationId 换了起点位置属于参数冲突，不复用旧操作。
  const first = await postJson(api.origin, "/v1/agent/conversations:open", {
    projectKey: fixture.projectKey,
    executionMode: "workspace_sandbox",
    workspace: {
      kind: "new_worktree",
      baseRefKind: "local",
      baseBranch: "main",
      branch: "feat/conflicted",
      operationId: "4e4e4e4e-2222-4333-8444-555566667777",
    },
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const conflict = await postJson(api.origin, "/v1/agent/conversations:open", {
    projectKey: fixture.projectKey,
    executionMode: "workspace_sandbox",
    workspace: {
      kind: "new_worktree",
      baseRefKind: "remote",
      baseRemote: "origin",
      baseBranch: "main",
      branch: "feat/conflicted",
      operationId: "4e4e4e4e-2222-4333-8444-555566667777",
    },
  });
  assert.equal(conflict.status, 409);
  assert.equal(
    (conflict.body.error as { code: string }).code,
    "WORKTREE_OPERATION_CONFLICT",
  );
});

test("configured remotes are listed even without local remote-tracking refs", async (t) => {
  const fixture = await createGitFixture(t);
  const api = await createApiFixture(t, join(fixture.directory, "worktrees"));
  api.registerProject({
    projectKey: fixture.projectKey,
    projectRoot: fixture.repository,
  });
  const secondRemote = join(fixture.directory, "second.git");
  await git(fixture.directory, ["init", "--quiet", "--bare", secondRemote]);
  await git(fixture.repository, ["remote", "add", "upstream", secondRemote]);

  const response = await fetch(
    `${api.origin}/v1/agent/projects/branches?projectKey=${
      encodeURIComponent(fixture.projectKey)
    }`,
  );
  assert.equal(response.status, 200);
  const body = await response.json() as {
    remotes: string[];
    remoteBranches: { remote: string; name: string }[];
  };
  // upstream 还没有任何远端分支引用，但已配置的 remote 必须出现在列表里，
  // 界面才能让用户选它并手填分支名。
  assert.deepEqual(body.remotes, ["origin", "upstream"]);
  assert.equal(
    body.remoteBranches.some((entry) => entry.remote === "upstream"),
    false,
  );
});
