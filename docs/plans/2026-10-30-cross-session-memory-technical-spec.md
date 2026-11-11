# 跨会话记忆技术方案

本方案配合 [跨会话记忆需求](./2026-10-30-cross-session-memory-spec.md)。目标是在同一仓库的不同 worktree 中共享本机记忆，支持用户明确要求记住、修改和忘记，并对手工写大的索引提供可见的截断提示和按需读取。文中限制值是实施初值，评测后调整。

## 当前实现

当前基线为 `821d919`。创建会话时，`src/application/workspace-runtime.ts` 对工作区做 `realpath`，Run 绑定 workspace 与执行模式。`ProjectInspection` 和 `GitProjectService` 已识别项目：Git 项目使用 `git:<canonical common dir>`，普通目录使用 `dir:<canonical directory>`。会话持久化 `project_key`、`project_root` 和 `workspace_kind`；尚未识别的历史会话在读取详情或列表时尝试回填。`src/application/conversation-run-service.ts` 在 Run 开始读取当前会话 transcript、工作区指引、Skills 和 MCP 工具，分别装配父、子 Agent 的 system prompt 和工具。`src/application/context-builder.ts` 按模型预算投影当前会话 transcript；没有跨会话长期记忆。

`src/runtime.ts` 创建基于 workspace 的文件工具。`src/tools/path.ts` 在 `workspace_sandbox` 模式限制普通文件工具的工作区外访问。工具调用经 `ToolRegistry`、`AuthorizedToolExecutor` 和默认权限策略（`src/tool-permissions.ts`）；未知工具默认拒绝。主、子 Agent 当前共用 `baseTools`，必须在组装子 Agent 前后分别构造工具列表，才能让子 Agent 不获得记忆工具。

`src/agent-events.ts` 定义 Run 事件，`src/run-stream.ts` 包装事件并提供流游标；前端 `web/src/events.ts`、`web/src/run-client.ts` 和 `web/src/run-state.ts` 校验和消费事件。`run.started` 的 `data` 当前为空。会话、Run 与 transcript 保存在 SQLite；默认数据库路径相对服务启动目录解析，可由 `AGENT_DATABASE_PATH` 指定（`src/server-config.ts`）。

## 问题与目标

用户在 worktree A 要求“记住”后，在同一仓库 worktree B 的新会话中无法取得这条记忆。工作区绝对路径不能作为共享身份。用户可自行编辑文件，因此索引大小和并发修改都需要明确行为。

运行示例：用户说“记住集成测试需要 Redis”；父 Agent 将一条记忆写入仓库记忆目录。下一次同仓库会话启动时收到索引，并在相关任务中读取详情。用户说“忘记 Redis 的要求”，Agent 定位并修改对应文件。工具写成功后才向用户报告成功。

第一版仅在用户明确提出“记住 / 修改 / 忘记”时写记忆。人工编辑文件始终可用。独立 clone、跨机器同步、自动提取及全局用户记忆不在范围。

## 当前与目标架构

架构图中箭头表示调用或数据流，不表示进程父子关系。

```text
当前：
浏览器 ─HTTP/SSE─> Harness 服务 ─请求─> 模型
                     ├─ SQLite：会话与 Run
                     └─ workspace：指引和工具文件（工具沙箱边界）

目标：
浏览器 ─HTTP/SSE─> Harness 服务 ─请求─> 模型                [复用]
                     ├─ SQLite：会话与 Run                  [复用]
                     ├─ workspace：指引和工具文件           [复用，沙箱边界不变]
                     └─ memory store：仓库外 Markdown       [新增，服务进程访问]
                           ↑ 父 Agent 通过受控工具读取和写入
```

进程树只表达父子关系；不把浏览器、模型服务或已有沙箱子进程画成新增的 Git 子进程。

```text
当前：
Harness 服务进程
├─ Git 查询子进程（项目识别按需启动）
└─ 现有工具执行子进程（按工具需要启动）

目标：
Harness 服务进程
├─ Git 查询子进程（项目识别按需启动，复用）
└─ 现有工具执行子进程（复用）
```

项目归属已持久化时，Run 准备阶段直接使用会话身份；归属为空时复用 `ProjectInspection` 和 `GitProcessRunner` 识别当前工作目录。Git 查询异步等待，沿用现有每次查询 10 秒超时和输出限制；Run 取消时中止查询并等待子进程退出。等待只影响该 Run 的准备，不阻塞其他请求，也不启动后台任务。文件工具由服务进程执行，使用目录限定的存储接口。

## 记忆归属与数据

### 例子

```text
workspace A: /repo/app
workspace B: /repo/worktrees/fix
两者 Git common directory 的 realpath: /repo/app/.git
→ 现有 projectKey = "git:/repo/app/.git"
→ 目录名 = sha256(UTF8(projectKey))
→ ~/.my-agent-harness/memory/<目录名>/MEMORY.md
```

用户数据是 UTF-8 Markdown，文件为唯一权威数据：

```text
MEMORY.md: - 集成测试需要 Redis；详情见 testing.md

testing.md: # 集成测试
            执行测试前启动 Redis。
```

`MEMORY.md` 为启动索引；其他 `.md` 为详情，文件名可由 Agent 选择。每个文件可包含多条内容；忘记一条时读取并重写包含它的文件，只有用户要求删除整个文件时才删除文件。更新详情与索引是两次写操作，失败时保留已成功写入的文件，报告部分完成，不假定原子跨文件事务。

现有 `GitProjectService.readProject` 使用 Git common directory 的 realpath 生成 `git:` 项目身份；`ProjectInspection` 在明确识别为普通目录时生成 `dir:` 身份。linked worktree 共享 common directory 的依据见 [Git worktree](https://git-scm.com/docs/git-worktree) 和 [git rev-parse](https://git-scm.com/docs/git-rev-parse)。本方案复用会话已有 `projectKey`，不重新定义项目身份；对完整 `projectKey` 的 UTF-8 字节计算 SHA-256，结果仅作为记忆目录名。

`beginRun` 在现有事务内读取的会话行已包含项目归属；扩展返回值 `BegunConversationRun`，携带 `projectKey`、`projectRoot` 和 `workspaceKind` 的现有值，不增加数据库列。项目归属非空时使用已保存的 key。归属为空时，复用 `ProjectInspection.inspect(workspaceRoot, signal)`；成功且符合已有工作区类型约束时，本 Run 使用其 `assignment.projectKey`。若已知工作区类型为 `main`、`worktree` 或 `subdirectory`，识别结果为 `dir:` 时视为不可用，避免错误落入普通目录记忆；Git 暂时不可用、超时、解析失败或工作区不可访问时记忆不可用。Run 不自行回填数据库；会话详情和列表沿用 `ConversationService` 已有的条件式懒回填。识别等待期间取消时中止 Run，不把取消作为空记忆。

工作区子目录按所属仓库共享；独立 clone 和仓库迁移后路径变化产生不同项目身份。归属尚未确认时不猜测目录 key，普通对话继续并提示记忆不可用。

| 配置 | 来源 | 必填 | 默认值 | 作用 |
| --- | --- | --- | --- | --- |
| `AGENT_MEMORY_ROOT` | 服务环境变量 | 否 | 服务账号 home 下 `.my-agent-harness/memory` | 记忆根目录，设置时必须为绝对路径；评测使用临时目录 |
| `projectKey` | 会话已保存的归属；缺失时复用 `ProjectInspection` | 是 | 无 | 现有 `git:` 或 `dir:` 身份，按其 UTF-8 字节计算 SHA-256 作为记忆目录名 |

启动配置校验失败时服务启动报错。目录懒创建，目录权限为用户私有；文件不进目标仓库 Git。存储路径不得由模型输入指定。

## Run 加载和记忆工具

### 启动加载

[Claude Code](https://code.claude.com/docs/en/memory) 使用仓库外的 Markdown 记忆目录，启动时加载有上限的索引，详情按需读取；[OpenClaw](https://docs.openclaw.ai/concepts/memory) 也将启动记忆和按需检索的详细内容分开。本方案采用可编辑文件和有界索引，第一版通过文件列表和分页读取详情。

父 Run 完成 workspace 解析后，并行启动现有指引、Skills、MCP、Stop Hook 加载与记忆身份/索引加载，全部完成后装配 prompt 与工具。记忆不可用不阻断普通会话，模型和用户都收到状态；明确要求写记忆时工具返回失败，不报成功。取消使用该 Run 的 AbortSignal。

索引以 UTF-8 字节计量：按 LF 分行，CRLF 保留为原文换行；最多 200 行、25 KiB。逐完整行累计，下一行会超任一上限时停止，并返回未加载的下一行号；首行超限时下一行是 1。文件原文不变；无效 UTF-8 报不可用。每个 Run 在启动时重新读取索引，Run 内保持快照；工具读取磁盘当前文件，下个 Run 获得最新索引。超限尾部可分页读到，但是否主动召回由模型行为决定。

#### 记忆进入模型请求的方式

| 参考 | 记忆进入上下文的方式 | 证据范围 |
| --- | --- | --- |
| [Claude Code](https://code.claude.com/docs/en/memory) | 会话开始加载 `MEMORY.md` 的一部分，主题文件按需读取 | 文档未明确说明 API 请求消息角色 |
| [OpenClaw](https://docs.openclaw.ai/concepts/agent) | 工作区 `MEMORY.md` 作为启动文件进入 system prompt 的 Project Context | 文档描述的是 OpenClaw 的工作区启动路径；其他运行路径参见其 [system prompt 文档](https://docs.openclaw.ai/concepts/system-prompt) |
| [Codex 开源记忆模块](https://github.com/openai/codex/blob/main/codex-rs/memories/README.md) | 记忆读取模块负责将记忆使用说明注入 developer 指令 | 该说明支持 developer 指令注入；不能据此推断本项目 provider 有同样的角色 |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/core/client.ts) | 获取分层记忆中用于 system instruction 的部分，交给 system prompt 构造；[构造代码](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/prompts/promptProvider.ts)将传入的记忆参与最终 prompt 组装 | 分层记忆的加载范围可能随配置和路径变化；不能据此推断所有记忆都以同一方式加载 |
| [Letta](https://docs.letta.com/v1-sdk/concepts/stateful-agents) | 附着在 Agent 上的 memory blocks 常驻于 system prompt | 这是有状态 Agent 的记忆机制，存储模型与本项目的 Markdown 文件不同 |
| [Cline 规则](https://github.com/cline/cline/blob/main/apps/cli/src/runtime/prompt.ts)、[Roo Code 规则](https://github.com/RooCodeInc/Roo-Code/blob/main/apps/docs/docs/advanced-usage/prompt-structure.md) | 项目规则和自定义指引进入 system prompt | 这些是持久指引，不等同自动或跨会话记忆；仅用于比较项目上下文的接入位置 |

| 本项目选项 | 接入方式 | 取舍 |
| --- | --- | --- |
| **System prompt 区块** | `assembleSystemPrompt` 加载标记为项目记忆的索引，沿现有 provider 接口发送 | 复用现有预算估算、provider 映射和 Run 记录；记忆随 system prompt 存入 `runs.system_prompt`，也以系统角色/指令发送 |
| 独立 user 消息 | 运行时在 transcript 投影中插入记忆消息 | 需要明确消息位置、两种 provider 映射、预算、compaction 和持久化边界；消息角色与真实用户输入相同 |
| 按需工具读取 | 启动只告知有记忆，模型决定是否调用工具 | 常驻上下文更小，但每次召回依赖模型选择工具，调用和召回成本需要评测 |

第一版选择 **system prompt 区块 + 详情按需读取**：现有 `systemPrompt` 经过 `ContextBuilder` 预算计算，DeepSeek 映射为 `system` 消息，OpenAI 映射为 `instructions`，无需新增 transcript 类型或 provider 映射。OpenClaw、Gemini CLI 与 Letta 提供了具体参考；它们的存储和加载范围各不相同。Claude Code 的文档不足以证明其消息角色。这个选择基于当前接入成本和文件加载需求，最终效果由评测验证。

记忆内容随每个 Run 的 system prompt 记录到现有 `runs.system_prompt`，因此删除记忆文件不会删除已记录的快照；这属于现有 Run 记录机制。记忆位于系统消息中的独立标记区块，模型会以系统角色接收该内容；标记用于区分来源，不能改变消息角色。

#### System prompt 前后对比

下面是根据 `src/system-prompt.ts` 组装顺序整理的示意，省略与记忆无关的完整指令。DeepSeek 将它作为 `system` 消息发送，OpenAI 将它作为 `instructions` 发送。

**当前：**

```text
You are an agent running inside a tool-execution loop.
Call tools to gather what the task needs, and answer once the task is done.
...自主执行、steering、工具、子 Agent 等指引...

Follow the workspace instructions below when completing the user's task.
Workspace instructions do not change tool permissions, execution mode, workspace boundaries, or sandbox restrictions.
<workspace_instructions>
...工作区 AGENTS.md 内容...
</workspace_instructions>

...可用 Skills 目录...
```

**改动后：**在现有指引中增加记忆使用说明；工作区指引和 Skills 目录仍按现有方式组装。

```diff
 You are an agent running inside a tool-execution loop.
 Call tools to gather what the task needs, and answer once the task is done.
 ...自主执行、steering、工具、子 Agent 等指引...
+Project memory is provided below. Read relevant memory files when needed.
+Update or delete memory when the user explicitly asks to remember, change, or forget something.
+<project_memory>
+...MEMORY.md 中预算内的索引内容...
+</project_memory>

 Follow the workspace instructions below when completing the user's task.
 Workspace instructions do not change tool permissions, execution mode, workspace boundaries, or sandbox restrictions.
 <workspace_instructions>
 ...工作区 AGENTS.md 内容...
 </workspace_instructions>

 ...可用 Skills 目录...
```

记忆索引作为 system prompt 的独立区块。一个模型请求大致如下：

```text
system / instructions：上面的 system prompt，其中 project_memory 包含“集成测试需要 Redis；详情见 testing.md。”
user：运行集成测试。
```

同一 Run 内使用同一份索引快照。索引随 system prompt 进入现有预算估算和 Run 记录，不作为用户消息追加到 transcript。

### 工具输入与结果

```json
{"action":"read","file":"testing.md","start_line":1,"limit":50,"content":null,"expected_sha256":null}
{"file":"testing.md","content":"# 集成测试\n执行测试前启动 Redis。\n","sha256":"<64 位十六进制>","next_line":null}
```

| 输入字段 | 来源 | 必填 | 默认值 | 含义 |
| --- | --- | --- | --- | --- |
| `action` | 模型 | 是 | 无 | `list`、`read`、`write`、`delete` |
| `file` | 模型 | 是，可为 `null` | 无 | `list` 为 null；其他动作填写单层 `.md` 文件名 |
| `start_line` | 模型 | 是，可为 `null` | null，read 时取 1 | 读取起始行，1 起算 |
| `limit` | 模型 | 是，可为 `null` | null，read 时取 50 | 最大读取行数 |
| `content` | 模型 | 是，可为 `null` | 无 | `write` 时为完整新内容，其他动作须为 null |
| `expected_sha256` | 模型 | 是，可为 `null` | 无 | 写已有文件或删除时是上次读取的文件内容 SHA-256 校验值；创建文件时为 null |

统一必填可空字段便于现有 provider 的 strict schema；按 action 校验组合。`list` 返回 `{files: string[]}`，包含 `MEMORY.md`，排序为文件名 UTF-8 字节序；无目录返回空数组。`read` 返回上例中的完整文件内容校验值和下次行号；`write` 返回 `{file, sha256}`，`delete` 返回 `{file, deleted: true}`。文件不存在返回 `FILE_NOT_FOUND`，无效输入返回 `INVALID_TOOL_INPUT`，校验值不符复用 `EDIT_CONFLICT`，I/O 和锁错误返回 `TOOL_EXECUTION_FAILED`；不在错误中返回任意外部路径内容。

| 对象 | 单位 | 上限 | 超限行为 |
| --- | --- | --- | --- |
| 启动索引 | 行 / UTF-8 字节 | 200 / 25 KiB | 保留文件，完整行截断，标记下一行 |
| read 单次 | 行 / UTF-8 字节 | 200 / 32 KiB | 返回完整行与下一行；单行超过 32 KiB 返回错误，提示用户拆行 |
| 工具 write 文件 | UTF-8 字节 | 1 MiB | 拒绝，原文件不变；人工写入不受此限 |
| Git 查询 | 秒 | 每次查询 10 | 沿用 `GitProcessRunner` 超时和清理；识别失败时记忆不可用 |
| 写入等待 | 秒 | 5 | 超时返回失败，不修改文件 |

只接受单层 `.md` 文件名，禁止分隔符、`.`、`..`、符号链接与非普通文件；在打开和替换时使用防符号链接检查，并将所有路径限定在已解析的项目记忆目录。JSON 返回值计入现有 `MAX_TOOL_OUTPUT_BYTES` 64 KiB；32 KiB 内容预算需包含 JSON 转义后的大小，必要时提前减少返回行，不依赖通用结果截断。`list` 数量过多时应返回清晰错误，不能静默省略文件。

### 并发与授权

第一版采用**进程内串行化和写前校验**：同一服务中，对同一记忆目录的写入和删除按顺序执行；每次操作取得执行位置后，再检查文件是否自 Agent 上次读取后发生变化。文件已变化时返回冲突，Agent 重新读取后再处理用户请求。

例如，会话 A 和 B 都读取了同一份 `MEMORY.md`。A 先保存后，B 进入写入流程时重新计算文件内容的 SHA-256 校验值；它与 B 读取时的 `expected_sha256` 不同，因此 B 的写入返回冲突，不覆盖 A 的修改。新建文件时，如果文件已由其他会话创建，也返回冲突。

当前界面允许用户在一个 Run 继续执行时切换或新建会话（`web/src/App.tsx`），`RunRegistry` 允许不同会话的 Run 同时运行（`src/application/run-registry.ts`）。因此，同一服务进程内的多个会话可能同时修改同一仓库的记忆。第一版由服务进程共享的记忆服务按记忆目录串行化 `write` 和 `delete` 的校验及文件操作；不同记忆目录互不阻塞，读取无需等待。等待超过 5 秒或取消时返回失败，不修改文件。单文件写入使用同目录临时文件和 rename，失败时清理临时文件，避免读取半成品。

桌面应用使用单实例锁并启动一个后端进程（`desktop/main.mjs`）；独立服务入口可以另行启动，但目前没有证据表明日常产品路径需要多个服务进程同时写同一记忆目录。因此，第一版不设独立 SQLite 锁库，也不承诺跨进程写入互斥。多个服务共用目录、外部编辑器写入，以及索引和详情之间的跨文件更新，均不受进程内串行化保护。是否需要跨进程保护，结合开源方案调研与实际运行需求再确定。

相关开源实现对不同写入路径的处理：

| 项目 | 保护的操作 | 做法及范围 |
| --- | --- | --- |
| [OpenClaw](https://github.com/openclaw/openclaw/blob/main/docs/concepts/memory-architecture.md) | 后台整理并重写 `MEMORY.md` | 整理开始时记录内容哈希，写回前复核；发生变化则放弃本次重写并采用追加回退，使用原子 rename。文档明确仍有校验与替换之间的竞争窗口 |
| [Codex](https://github.com/openai/codex/blob/main/codex-rs/memories/README.md) | 后台记忆提取和汇总 | 提取任务使用数据库租约；汇总任务在操作共享记忆目录前取得全局锁。该资料不能证明交互会话的每次记忆文件写入都使用同一锁 |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/auto-memory.md) | 后台 Auto Memory 提取 | 项目记忆目录中的锁文件协调多个 CLI 实例；提取结果先生成待审核 patch，批准后才应用。文档未说明普通交互式记忆文件编辑使用同一锁 |

OpenClaw 的内容哈希复核与本方案的校验方式可供比较；其场景是后台整理，不能直接推断交互式工具的并发保障。Codex 与 Gemini CLI 的后台任务锁解决多个整理任务竞争的问题，第一版不包含后台整理，暂不引入同等流程。

默认策略给 `memory` 工具允许规则，复用普通工具审计；模型可见性检查用空输入，因此不能只按 action 对单个工具名套静态可见性规则。写动作只在用户明确请求时由模型发起，系统提示词约束模型行为；当前服务端无法从自然语言可靠证明用户意图，不能把提示词当作强制授权检查。需要硬性强制该行为时，须另行设计显式用户动作或授权交互。子 Agent 不注册 `memory` 工具，也不加载父 Agent 记忆；父 Agent 委托时自行传递相关事实。

## 具体改动

| 文件 / 模块 | 改动 | 职责 |
| --- | --- | --- |
| `src/server-config.ts`、`src/server-bootstrap.ts` | 解析绝对记忆根目录并注入服务 | 配置和装配 |
| `src/application/conversation-store.ts`、`src/infrastructure/sqlite/sqlite-conversation-store.ts` | 扩展 `BegunConversationRun`，携带已有项目归属与工作区类型 | 复用会话行，不修改数据库 schema |
| `src/application/project-inspection.ts`、`src/application/project-services.ts` | 复用项目识别，供 Run 归属为空时调用 | 沿用 Git 身份、错误和取消语义 |
| 新增聚焦的 Markdown store 模块 | 由现有 projectKey 确定记忆目录，负责有限读取、文件写入及进程内串行化 | 文件存储；不新增项目身份模块或数据库表 |
| `src/tools/memory.ts` | 实现 `list/read/write/delete` 的 schema 与工具结果 | 绑定单个仓库 store，复用工具执行链 |
| `src/tool-permissions.ts` | 为 memory 增加默认规则 | 使工具可见并进入现有策略与审计 |
| `src/application/conversation-run-service.ts` | 准备记忆快照和父 Agent 工具；子 Agent 不接入 | 保持原 Run 生命周期 |
| `src/system-prompt.ts` | 在父 Agent 的 system prompt 中加入记忆说明与索引区块 | 复用现有预算估算和 provider 映射；随 Run 的 system prompt 记录 |
| `src/agent-events.ts`、流校验与 `web/src/events.ts`、`web/src/run-state.ts` | `run.started.data` 新增可选 `memory` 状态，展示加载不可用或截断 | 与现有 SSE 事件、重连和旧记录兼容 |

事件例子：`{"type":"run.started","data":{"memory":{"status":"truncated","nextLine":201}}}`。新增 `data.memory` 可选：`status` 为 `ready`、`truncated`、`unavailable`；`nextLine` 只在 `truncated` 必填，`unavailable` 返回稳定错误类别 `identity`、`read` 或 `encoding`，不携带绝对路径。旧事件缺字段时前端按无状态处理。

`ConversationRunService` 在读取记忆后将状态传入 `streamAgentRun`，再由 `src/agent-loop.ts` 的 `eventFactory.runStarted()` 传给 `AgentEventFactory.runStarted`，使用原有 seq 生成事件。`RunRegistry` 的 `#pump` 已把事件写入日志并交给 `RunSnapshotProjection.apply`；扩展 `src/application/run-snapshot.ts`，只在父 Run 的 `run.started` 中保存 memory 状态，`snapshot()` 将其作为 `RunSnapshotData.memory` 返回。旧 snapshot 缺字段时按无状态处理。`web/src/events.ts` 的事件与 snapshot 类型及解析规则同步增加可选字段；`web/src/run-state.ts` 在事件和 snapshot 两条路径写入同一状态，前端对 `truncated` 和 `unavailable` 展示提示。重连时沿用启动快照，不重新读取文件；常规回放使用原事件，日志截断后通过 snapshot 恢复。该状态只存在当前服务进程内的 Run 事件日志和 snapshot，不新增数据库字段；服务重启后的历史查看不保证重放提示。

### 现有接入点最小 diff

以下是基于现有代码的示意，展示接入顺序，非完整实现：

```diff
 const runtime = await this.#getWorkspaceRuntime(begunRun);
-const [workspaceInstructions, workspaceSkills, mcpResult, stopHookConfig] =
+const [workspaceInstructions, workspaceSkills, mcpResult, stopHookConfig, memory] =
   await Promise.all([
     this.options.loadWorkspaceInstructions(runtime.workspaceRoot),
     this.options.discoverWorkspaceSkills?.(runtime.workspaceRoot),
     this.#acquireMcpTools(runtime.workspaceRoot),
     this.#loadStopHookConfig(runtime.workspaceRoot),
+    this.options.memory.load(begunRun, command.signal),
   ]);
```

现有代码在 `baseTools` 构建后交给子 Agent，因此不能直接把 memory 加到 `baseTools`。构造父工具数组时追加 memory，子 Agent 继续使用原有 baseTools。`command.signal` 沿现有 Run 取消链传入项目识别和记忆加载；`memory.load` 是拟新增接口。

## 保持不变

SQLite schema、迁移、已有 transcript 内容和数据库持久化协议不变。忘记只删除或更新长期记忆，不删除历史 transcript 或已记录的 Run system prompt。workspace 文件工具、沙箱和 MCP 授权保持原样。记忆项目隔离按本机 Git common dir；独立 clone 不共享。

## 验收与评测

文件读写、仓库身份、截断、冲突和 provider 输入链采用单元与集成测试验证，真实临时仓库覆盖两个 worktree；身份验证同时覆盖已有 `projectKey`、历史会话归属为空、明确的普通目录和 Git 暂时不可用。真实模型评测独立检验用户明确写入、跨会话读取、修改、忘记、项目隔离及超限后召回；不将文件可读取等同模型成功召回。

固定运行中的 Harness 版本作为开发者，在包含本方案和依赖的目标 worktree 中实现功能；完成后从该 worktree 构建并启动新的 Harness 服务，使用隔离的 `AGENT_DATABASE_PATH` 与 `AGENT_MEMORY_ROOT` 验证新功能。已启动的开发服务不会因 workspace 源码变化而自动切换版本。目标 worktree 的方案文件需事先提供，依赖需按现有锁文件安装；worktree 创建不会自动复制未提交文件或安装依赖。

评测脚本 `provider.mjs` 当前为一次尝试创建一个 workspace 和一次 `harnessRun`；`src/harness.mjs` 的 `runConversation` 创建一个会话。评测需扩展顺序编排以创建同一仓库两个 linked worktree、两个会话，保存各 Run 事件、模型调用及记忆文件证据。每次 attempt 注入独立绝对 `AGENT_MEMORY_ROOT`。样本事实不出现在初始仓库或第二次提示中，分别检查 A 实际写入、B 实际读取/使用与两个身份一致。

| 场景 | 输入及验收 |
| --- | --- |
| 共享与隔离 | A 明确记住仅用户知道的虚构事实；B 同仓库新会话完成相关任务并正确使用；其他仓库不能获得事实 |
| 修改与忘记 | 更新后新会话使用新值；忘记后检查长期文件和后续加载不含旧条目，transcript 保留 |
| 手工超限 | 目标条目置于截断区；文件不变、状态可见且分页可读取；独立记录 Agent 实际召回结果 |
| 成本对照 | 固定模型、工具、任务；比较同样工具和配置下预置记忆与空目录，统计实际输入 Token、调用数、成功/失败/异常。空目录基线不是禁用记忆能力 |

重复次数和评测阈值在运行前固定；保存每次运行证据和失败原因，不以一次成功推断总体效果。仅评估提出的能力，不把单测通过视为模型行为通过。
