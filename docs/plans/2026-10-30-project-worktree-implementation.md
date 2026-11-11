# Worktree 与项目分组实施记录

状态：已实施。对应[产品方案](./2026-10-29-project-worktree-product-spec.md)与[技术方案](./2026-10-29-project-worktree-technical-spec.md)。本文记录落地后的实际结构、与方案不一致的地方及验证结果。

## 当前实现

新建会话仍从侧栏进入。用户先通过 macOS 系统目录选择器选择目录并确认执行模式，服务端用 realpath、目录校验和 runtime 初始化完成创建，会话固定在所选目录。

实施后：

- `conversations` 有 **11 个物理列**：`id, revision, workspace_root, execution_mode, active_run_id, created_at, updated_at, title, project_key, project_root, workspace_kind`。后三列由迁移 2 增加，存量行为 NULL。
- 新增 `worktree_operations`（10 列：`id, project_key, project_root, target_path, branch, base_branch, base_commit, execution_mode, status, conversation_id`），记录 worktree 创建操作。
- 服务端新增项目识别（`GitProjectService` + `ProjectInspection`）、宿主 Git 进程入口（`GitProcessRunner`）、worktree 创建（`WorktreeCreator`）与创建编排（`ConversationOpenService`）。
- `ConversationService.listConversations` / `getConversation` / `renameConversation` 变为异步：读取时会补全项目归属（缺失时识别并回填）与工作目录实时状态（分支、可用性、目录类型）。
- 前端侧栏改为「项目 → 会话」两级；新建会话页面替换原执行模式弹窗；当前项目区域显示工作目录类型、分支、完整路径与执行模式。

## 与方案的差异

| 方案 | 实施 | 原因 |
| --- | --- | --- |
| `conversations` 目标 10 列（`project_key, project_root`） | 11 列，增加 `workspace_kind TEXT NULL`（CHECK 只允许 `main/worktree/subdirectory/directory`） | 侧栏要区分主目录与 worktree；历史会话这一列可空，读取时由实时 Git 状态推断并回填一次，之后稳定 |
| 项目查询路径 `/v1/agent/projects/{projectKey}/branches` | `/v1/agent/projects/branches?projectKey=<opaque>` 与 `/v1/agent/projects/worktrees?projectKey=<opaque>` | 项目 key 是 `git:<绝对路径>`，含 `/`，放进路径段只能整体编码，可读性差 |
| `selectionToken` 通过 `X-Project-Selection` 头传给两个 GET | 两个 GET 只用 `projectKey` | 已登记项目本身来自会话记录，读取分支与 worktree 是只读操作；选择令牌只在创建请求里使用 |
| 响应里的 `workspace.kind/branch/availability` | 摘要与详情多出 `project`、`workspaceStatus{kind, branch, availability}`，另有内部字段 `workspaceKind`（不下发） | 同一条记录既有持久化归属又有实时状态，分开表达避免把缓存值当实时值 |
| 创建请求在 Git 启动前登记 `prepared`，再 `started` | 同方案：`prepared` → `started` → `completed`，失败/中断 → `needs_inspection`；服务启动时把未完成操作统一转 `needs_inspection` | — |
| 响应丢失后前端以 `operationId` 查询 | `GET /v1/agent/worktree-operations/{operationId}`；重复提交同一 ID 直接返回已有状态 | 两种入口都覆盖，前端只用重复提交（逻辑更少） |
| 所有宿主操作要求 loopback | 沿用 `isTrustedHostActionOrigin`（同源 loopback 或 `CORS_ALLOW_ORIGIN` 允许的 Origin），Full Access 追加 loopback 检查 | 与现有 `conversations:select-workspace` 及 `docs/runtime-boundaries.md` 一致，不破坏跨域前端配置；技术方案相应段落已改写 |
| 懒回填只写两列 | 归属与目录类型在同一条 `UPDATE ... WHERE project_key IS NULL AND project_root IS NULL AND workspace_kind IS NULL` 内写入 | 两列要么都写、要么都不写，并发回填不会写出「有归属无类型」的中间状态 |
| 令牌签发后 Git 不可读 | 令牌记录了「确认时是 Git 项目」，重新识别只读到普通目录时按「未识别」创建会话，不写成 `dir:` | 避免 Git 短暂不可用就把项目永久改判为普通目录 |

## 关键规则

- 项目身份：`git:<realpath(git common dir)>` 或 `dir:<realpath(目录)>`。多个 clone 的 common dir 不同，属于不同项目；linked worktree 共享 common dir。
- 主工作目录取 `git worktree list --porcelain -z` 中第一条非 bare 记录。输出按 NUL 切分字段，路径可包含空格。
- 推荐起始分支：存在 `origin`（或唯一 remote）且 `refs/remotes/<remote>/HEAD` 存在时，取唯一 upstream 指向它的本地分支；否则不预选。不 fetch。
- worktree 目标路径：`<worktree root>/<项目 key 的 FNV-1a 哈希>/<operationId>`，默认 root 为 `~/.westie/worktrees`；测试用 `startAgentServer({ worktreeRoot })` 覆盖。
- Git 调用全部 argv 方式，`GIT_TERMINAL_PROMPT=0`；查询超时 10 秒、创建 120 秒、每流输出上限 1 MiB、并发上限 4；超时/取消后等待进程退出并标记 `needs_inspection`。
- 选择令牌只在服务端内存，5 分钟过期，创建成功后消费；令牌绑定 realpath 后的精确路径，客户端不能提交任意路径。
- 目录选择接口 `POST /v1/agent/conversations:select-workspace` 只接受 `{"action":"inspect"}`，只识别目录并签发令牌；会话统一通过 `POST /v1/agent/conversations:open` 创建。

## 审查修复（MR !46 第二轮）

- 创建成功后用 `succeeded` 动作回到 `closed`，对话框与页面不再锁死。
- 选择器识别结果按 `selectionKind` 设默认工作目录（主目录 / 已有 worktree / 子目录 / 普通目录）。
- 首次选择、尚未登记的项目统一用 `selectionToken`（创建请求与分支 / worktree 查询）；定向 GET 支持 `?selectionToken=`。
- 侧栏项目 `＋` 只在 `projectType === "directory"` 时跳过 Git 读取；`dir:` 项目只提供「所选目录」选项。
- 令牌分支允许 `checkout === null`：普通目录按 `dir:` 创建，Git 暂时不可读按未识别归属创建。
- `--git-common-dir`、`HEAD` 查询与 `git worktree list` 的进程失败统一转 `GitRepositoryError("unavailable")`；列表逐条降级，详情与 Run 入口不会因单条 Git 失败整页 500。
- `conversations:open` 与目录识别接入 `watchClientDisconnect`，取消或断连后中止 Git 并按 `needs_inspection` 落库；`prepared` 但未启动 Git 的操作用同一 commit 重新推进。
- 文档：宿主操作要求可信 Origin，Full Access 追加 loopback（与 `docs/runtime-boundaries.md` 和跨域回归测试一致）。

## 验证

已运行（`MY_AGENT_HARNESS_SANDBOX=full-access-tagged`）：

- `npm run check:server`、`npm run check:web`、`npm run build`：通过。
- 服务端 `node --test dist/test/*.test.js`：730 通过，26 失败。失败全部落在 `test/macos-seatbelt-sandbox-runner.test.js`（25 个）与 `test/runtime.test.js` 中「registers the default tools without duplicate names」（1 个），原因都是该环境无法初始化 macOS Seatbelt（`SANDBOX_UNAVAILABLE`），按测试规范标记**待宿主验证**。
- 新增 `test/project-worktree.test.ts`（真实 Git fixture）：目录识别、普通目录、主目录与 worktree 会话归组、分支推荐、worktree 重建幂等、分支冲突、未登记项目、来源校验、重启恢复与操作日志约束。
- `sqlite-migrations.test.ts` 覆盖 0→1→2、1→2、全新库列结构与 CHECK 约束。
- 前端 `npm --prefix web test`：284 通过。

待宿主验证：

- 桌面宿主中的真实目录选择器与实际 `git worktree add` 交互。
- Seatbelt 相关用例（上条）。

## 遗留

- 未实现：worktree 自动清理、依赖安装、未提交文件复制、合并/PR 管理、会话内切换目录、初始化脚本。
- 前端未实现「刷新后用 operationId 查询」：经确认不作为首版范围，技术方案已同步改写，不再要求 `sessionStorage` 暂存与页面自动恢复。创建请求失败时展示服务端返回的目标路径与原因；服务端已支持同一 `operationId` 的幂等重试与 `GET /v1/agent/worktree-operations/{operationId}` 查询，需要确认现场时由用户自行查询操作状态。
- 旧请求体 `{ "executionMode": ... }` 已移除；前端和服务端统一使用目录识别令牌与 `conversations:open` 创建会话。历史会话仍可能缺少项目归属，读取时按现有回填逻辑补齐。

## 追加：远端分支作为起点（迁移 4）

起点不再限定本地分支：用户可以直接选择远端分支，服务端在创建前 `git fetch` 该分支，用刷新后的 commit 作为起点。

服务端：

- `GitProjectService.listBranches` 额外返回 `remotes: string[]`（来自 `git remote`，即使该 remote 还没有任何远端分支 ref 也列出）与 `remoteBranches: { remote, name, hasLocalBranch }[]`，来自本机已有的 `refs/remotes/<remote>/<branch>`（跳过 `<remote>/HEAD`）；远端名可能含 `/`，按已配置 remote 名最长匹配切分。`hasLocalBranch` 标记同名本地分支已存在，前端把这类远端分支置灰。
- `POST /v1/agent/conversations:open` 的 `new_worktree` 增加可选 `baseRefKind`（`local` | `remote`）与 `baseRemote`。省略 `baseRefKind` 的旧请求按 `local`；`remote` 缺少 `baseRemote` 返回 400 `WORKTREE_BRANCH_INVALID`。
- `WorktreeCreator.prepare` 先解析起点：本地起点解析 `refs/heads/<branch>`；远端起点经新增的 `GitRemoteFetcher`（`src/application/git-remote-fetch.ts`）执行 `git fetch --quiet <remote> +refs/heads/<branch>:refs/remotes/<remote>/<branch>`（固定超时 60 s，`GIT_FETCH_TIMEOUT_MS`），再解析 `refs/remotes/<remote>/<branch>`。fetch 只更新远端 ref，失败时不创建目录、不登记操作，返回 409 `WORKTREE_FETCH_FAILED`，用户可直接重试。
- `git worktree add` 的起点是已固定的 commit（不再传分支 ref）。起点形如 `<remote>/<branch>` 时 Git 会自动设置 upstream，但这里固定 commit，因此新分支没有 upstream；需要跟踪远端时由用户自行 `git branch --set-upstream-to`。
- `worktree_operations` 增加 `base_remote TEXT NULL`（远端起点为远端名，本地起点为 NULL），`base_branch` 存本地分支名或 `<remote>/<branch>`。迁移 4 用重命名 + 重建表的方式把列放到与新建表一致的位置（SQLite 只能追加列），存量行 `base_remote` 为 NULL；目标 `user_version = 4`。

前端：

- 起始分支下拉分「本地分支」与「远端 <remote>」两组；远端组里 `hasLocalBranch` 的分支不可选。选择远端起点时显示「创建前会先执行 git fetch」。
- 下拉只枚举本机已有的远端 ref，因此另提供「其他远端分支」入口：先选远端（选项来自 `git remote`，由 `branches.remotes` 下发，与该远端是否已有远端分支 ref 无关，默认 `origin`），再填分支名（datalist 补全该远端已 fetch 的分支）。远端的发现不依赖本地引用；远端上的新分支在本机 fetch 之前无法枚举，只能由用户填写。填写后走同一条创建前 fetch 路径，远端没有该分支时返回 `WORKTREE_FETCH_FAILED` 且不产生目录或分支。清空分支名时保留所选远端（起点仍为该远端，等待重新输入）。「新建 worktree」的可选条件是有可选分支**或**有已配置的远端，因此 detached HEAD、本地分支与远端引用都为空但配置了 remote 的仓库仍可使用手填入口。
- `NewWorktreeRequest` 增加 `baseRefKind` 与可选 `baseRemote`。

验证（`MY_AGENT_HARNESS_SANDBOX=full-access-tagged`）：

- `npm run check:server`、`npm run check:web`、`npm run test:server`：通过（`# tests 765`，沙箱相关 26 个失败仍为 `SANDBOX_UNAVAILABLE`，见上节）。
- `node --test dist/test/project-worktree.test.js`：19 通过。新增用例包括「已配置的 remote 在没有任何远端分支引用时仍由分支接口列出」，以及：远端分支（本机 ref 已删除）作为起点并验证 fetch 后的 commit；远端分支不存在时 fetch 失败且无写入；远端起点缺少远端名与同一 operationId 换起点位置的冲突。
- `test/sqlite-migrations.test.ts`：新增 3→4 迁移用例，覆盖全部迁移路径的“迁移后与新建库结构一致”比较改为按列名排序比较。
- 前端 `npm --prefix web test`：294 通过（新增远端起点下拉、手填远端分支、远端选择器不依赖本地引用、清空分支名保留远端、无分支但有远端时仍可取「新建 worktree」的用例）。
