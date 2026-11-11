# 架构决策

## 项目定位

这是一个刻意保持最小的、无应用框架 Agent Harness，用来验证完整的 Agentic Loop，而不是通用 Agent SDK。

## 原生 Tool Calling 与 canonical transcript

Harness 不再要求模型返回自定义 Thought + Action JSON。Provider 负责把厂商事件归一化为正文或单个工具调用，并保留厂商生成的 opaque call ID；Agent Loop 只消费统一的 `ProviderTurn`，继续负责参数校验、权限、审批和工具执行。

内部 transcript 使用 user、assistant 正文、assistant tool call、tool result 四种 canonical message。OpenAI 和 DeepSeek 在各自边界映射原生消息与调用 ID，持久化层保存完整 canonical message，避免跨 Provider API 形状泄漏到核心层。上下文摘要属于 Provider 输入投影，不增加 canonical message 类型，也不覆盖原消息。

普通 ToolResult 回传模型前会被标记为不可信数据，system instruction 同时声明其不能改变任务目标、授予权限或授权后续操作。成功的内建 `skill` 结果由同一个 Provider 边界包装为 `workspace_skill_instructions`，只获得 workspace 工作流程语义；Skill 仍不能修改工具权限、execution mode、workspace 边界或 sandbox。这只强化模型输入边界，不改变确定性的工具权限策略；Full Access 仍按既有规则直接允许工具。

## System Prompt 由应用层统一拼装

`system-prompt.ts` 统一拼装 Harness 基础行为、ToolResult 信任规则和可选的 workspace 指令。`ProviderRequest` 携带完整 `systemPrompt`；OpenAI 将其映射到 Responses `instructions`，DeepSeek 将其映射为首条 system message。Provider 只处理协议映射。

ConversationRunService 在每个 Run 开始时从已校验的 `runtime.workspaceRoot` 读取根 `AGENTS.md`，并为当前 Run 生成固定 system prompt。它在首次 Provider 调用前把完整快照写入 `runs.system_prompt`。下一 Run 重新读取文件。该内容不进入 canonical transcript；只读诊断默认输出字节数，`--include-content` 输出完整内容。

ConversationRunService 同时在每个 Run 发现 `.agents/skills`，生成当前 Run 的精简 catalog 和 `skill(name)` 工具。发现同时覆盖 workspace 与用户级（`~/.agents/skills`）两个来源：按名合并、同名 workspace 覆盖用户级（被覆盖的用户级条目输出 `SKILL_SHADOWED`）。workspace 侧的符号链接与边界检查一字不改；用户级目录在用户自己的主目录里，允许根目录与 Skill 目录是符号链接（安装器 / dotfiles 的常见做法），但 `SKILL.md` 始终不能是符号链接、必须留在 canonical Skill 目录内。catalog 里 workspace 条目排前面、永不裁剪，超 32 KiB 只从用户级尾部省略。`skill` 结果带 `source` 与 `directory`，Provider 序列化时同时识别新的四键形状与历史 transcript 里的旧两键形状。两者共享同一份稳定裁剪后的 Registry；没有合法 Skill 时都省略。Registry 不进入跨 Run 的 WorkspaceRuntime 缓存。完整 `SKILL.md` 仍作为普通 canonical ToolResult 持久化，Provider 序列化时根据成功的内建 `skill` 结果建立 workspace 指令边界；历史 transcript 不做 Skill 特殊过滤。

ContextBuilder 将固定请求层与当前 Run 历史分开预算。固定 system prompt、AGENTS.md、Skill catalog 和工具 schema 始终从当前 Run 快照重新组装；ContextCompactor 只摘要已闭合的 Tool Call/Tool Result 对。Provider 视图的段序为：累计摘要的 synthetic user 消息 → 覆盖范围内受保护内容（未结束 Turn 的 user 消息与每个 Skill 最新的成功调用对，按原索引顺序）→ 覆盖点之后的尾部（原样、连续）。未结束 Turn 由 transcript 里最后一条 assistant 最终回答（content 非 null）之后的 user 消息推导，不依赖 turns 表。累计摘要带 Harness 固定前缀说明其属于同一会话的历史（可能跨多个 Turn），以最后出现的 user 消息作为当前指令，不能授权工具或改变任务。摘要输入把历史包在 `<history>` 里，并在历史之后重复一遍任务；输出缺少任何一个规定标题（`SUMMARY_HEADINGS`）即视为压缩失败，不采用。

## Sub Agent 是同步的嵌套 Run

`agent` 工具（`tools/agent.ts`）在应用层装配：ConversationRunService 把本 Run 的工具集去掉 `agent` 本身、加上子 Run 角色段落的 system prompt、同一个 `AuthorizedToolExecutor`、一个新的 `ContextBuilder` 和一个写库回调交给它。执行时它对 `streamAgentRun` 再做一次普通调用，子 Run 的 transcript 只有 `task` 一条 user 消息，`ToolPermissionContext` 沿用父 Run 的 `workspaceRoot`、`executionMode`、`conversationId`，只换 `runId`，因此会话级授权双向生效，审批经共享 Broker 处理。嵌套深度固定为 1。

子 Run 是同步工具调用：父 Run 在整批工具返回前不再调模型，并行只发生在同一批次内（`agent` 属于 `PARALLEL_TOOL_NAMES`）。并发上限 5 按 Run 各自计，没有进程级上限。Codex 式的异步 spawn / wait / 通知模型留作后续方案。

子 Run 的事件经 `ToolExecutionContext.onSubAgentEvent` 交给批执行器，由它包成 `subagent.event` 转发；批执行器的串行与并行路径合并为一个带并发度参数的实现。

子 Run 按自己的 `runId` 单独持久化：会话主线 `transcript_messages` 保持线性，只含父 Run 的消息；子 Run 结束时它的终态、system prompt 和完整 transcript 在一个事务里写入 `sub_agent_runs` 与 `sub_agent_transcript_messages`，靠 `parent_run_id` 与 `tool_call_id` 关联回父 Run。子 Run 的每次模型调用以 `sub_agent` 记入父 Run 的 `run_model_calls`，`sub_agent_run_id` 指向具体子 Run。不复用 `runs` 与 `transcript_messages` 的原因是同一张表装两种含义后，每条读主线的查询都要记得排除子 Run，漏一处子 Run 读过的文件就静默回到主线；独立的表让这个错误在结构上犯不出来。子 Run 的压缩记录和事件不持久化。

## OpenAI 与 DeepSeek 保持独立 Provider

OpenAI 使用 Responses API 原生 function call；DeepSeek 使用 OpenAI 兼容 SDK 的 Chat Completions 原生 tool call。二者只是共用 SDK 客户端，并不共享流事件和消息契约，因此保留独立 Provider 映射，不通过替换 `baseURL` 合并。

瞬时故障的重试放在 Provider 层的装饰器 `RetryingProvider` 里，而不是放在 Agent Loop 或 SDK 里。两个 Provider 仍然只描述「一次请求」：它们用 `classifyProviderError` 把失败归类，可重试的抛 `ProviderTransientError`，由 `StreamAttempt` 负责流 idle 超时。装饰器负责退避、`Retry-After` 和总等待上限，在两次尝试之间向流里插入 `retrying` 事件。这样父 Run、子 Run 和上下文摘要只要包一层就都能获得重试能力。不直接打开 SDK 的 `maxRetries`，是因为它只覆盖流开始之前的失败，等待不可取消，`Retry-After` 没有上限，而且整个过程对 UI 不可见。

两个 Provider 都请求禁用并行工具调用；DeepSeek 还显式关闭 thinking。DeepSeek 仍可能返回多个 tool call，适配器只接收 index 0，其余调用不执行、不持久化，首个 ToolResult 返回后由模型重新决策，从而维持每轮单工具的核心协议。Provider 仍拒绝缺失调用 ID、空答案和不完整输出。DeepSeek 的原生 tool call 可能伴随正文片段，适配器以 `finish_reason=tool_calls` 为准接受工具调用；正文只形成流式预览，不写入 canonical transcript。工具参数仍由 `ToolRegistry` 的 Zod schema 在执行前校验。

## 服务端分层

服务端采用以 Conversation 为聚合根的分层架构：

- `domain/` 定义 Conversation、Turn、Run 的公开领域类型和业务异常。Turn 和 Run 不各自建立 Service，避免跨 Service 修改同一聚合。
- `application/ConversationService` 提供创建、查询 Conversation 的用例边界。
- `application/ConversationRunService` 编排 `beginRun → Agent Loop → complete/fail/cancelRun`，并保证 Store 提交完成后才产生 `run.completed`。
- `application/ConversationStore` 是 Repository 端口；生产与测试统一使用 `infrastructure/sqlite/SQLiteConversationStore`，测试通过 SQLite `:memory:` 隔离，不再维护第二套内存 Store。
- `application/ContextBuilder` 在每次 Provider 请求前计算硬上限、触发阈值和受保护内容占用，调用 ContextCompactor 构造当前 Run 的 Provider 视图，再选择完整的历史 Run。
- `application/ContextCompactor` 负责完整工具调用对边界、最新 Skill 保护组、累计摘要调用与 synthetic user message。摘要调用复用当前 Provider，关闭工具，使用独立固定 prompt，不进入 Agent Loop 或公开 SSE。
- `application/ConversationStore` 提供 completed Run 摘要和按需 transcript 读取，并在 Run 终态事务中保存完整 canonical transcript 与已采用压缩记录；它不决定压缩范围。
- `http/AgentController` 只处理路由、请求校验、HTTP 错误映射、连接取消和 SSE 输出。
- `server.ts` 只把 Controller 这类请求 Handler 适配为 Node HTTP Server，并提供未处理异常的 500 fallback。
- `server-bootstrap.ts` 的 `startAgentServer` 是唯一生产 composition root，`server-main.ts` 只调用它；它显式绑定 `ConversationStore → SQLiteConversationStore`，并直接构造 Conversation Service、Run Service、Interaction Broker、权限执行器、Controller 和 HTTP Server；同时负责数据库生命周期。

`agent-loop.ts` 负责消费 Provider 流、校验完成的 ProviderTurn、Tool 编排和单个 Run 的内部 transcript；`provider-protocol.ts` 定义厂商无关接口，`transcript.ts` 统一消息 schema、序列化与字节口径，`agent-events.ts` 负责公开事件类型、Run 内序号和展示数据投影。Tool 参数先经过 `ToolRegistry.prepare()` 校验和规范化，再由 `AuthorizedToolExecutor` 执行固定策略；需要确认时，Agent Loop 通过共享的 `InteractionBroker` 等待响应，不能在批准前进入真实工具执行。

核心执行发生业务错误时会抛出原始异常，因此 CLI 的 `runAgent()` 保留原有错误语义。公开的 `streamAgentRun()` 在边界处把业务错误转换为一个 `run.error` 并正常结束事件流，避免消费者同时处理“终止事件”和“随后抛出的同一异常”。主动取消不生成 `run.error`，仍以 abort reason 结束，因为此时 SSE 连接通常已经不可写。

工具批次被中断时的收尾放在 `agent-tool-batch.ts`：`executeAgentToolBatch` 捕获取消或内部异常后，把同一批里已经完成的真实结果与其余工具调用的 `TOOL_INTERRUPTED` 合成结果一起包进 `ToolBatchInterruptedError`（`cause` 是原始错误），而不是直接抛原始错误。agent loop 收到它先把这批结果补进 transcript 再向外抛 `cause`，落库的 transcript 因此始终成对。写库前（`beforeRunFailed` 与 `beforeRunCompleted` 路径）再跑一次 `validateTranscriptBatches` 做兜底断言：只有诊断、不修复，避免掩盖后续引入的同类 bug。transcript 校验失败会作为 `INVALID_TRANSCRIPT` 暴露，与模型输出非法的 `INVALID_MODEL_OUTPUT` 区分开。

## 本地工具与 Workspace

CLI 使用启动时固定的 workspace。产品 Web 通过宿主机 macOS 目录选择器创建 Conversation；服务端完成 canonicalize 和 Runtime 预热后才保存不可变 workspace 与 `executionMode`。`CachedWorkspaceRuntimeProvider` 按 canonical root + mode 缓存 Promise，并原子创建同一权限边界的 `read/write/edit/bash` 与 SeatbeltRunner；初始化失败会清除缓存以允许重试。Conversation Run 只能从 `BegunConversationRun` 的 root + mode 选择 Runtime，并把两者同时传入工具集合和权限上下文。

默认文件工具同时检查词法路径与 `realpath`，避免父目录穿越和符号链接逃逸。会话中的 `read` 可在执行前产生 `workspace_grant` 资源预检，由宿主机 macOS 文件选择器确认精确 canonical path；批准后同一个 PreparedToolCall 原地继续，授权只对当前 `conversationId + toolCallId` 消费一次。浏览器不提交本机路径，`write`、`edit`、`bash` 也不继承该授权。路径、编辑冲突、命令超时等预期失败使用白名单 Tool error code 回传；未知异常继续收敛成通用错误，避免泄露内部细节。

`bash` 固定以 workspace root 为 cwd，并通过 `SandboxRunner` 端口与进程启动机制解耦。当前生产装配只支持 macOS `MacOsSeatbeltSandboxRunner`：读取显式允许的系统运行时、开发工具链、workspace 和命令级临时 HOME；写入只允许 workspace 与临时 HOME；网络默认拒绝；子进程环境不包含 Harness 的模型 API Key。Seatbelt 不可用或策略预检失败时 fail closed，不提供宿主执行降级。

`HostSandboxRunner` 只用于验证单元测试，不进入默认运行时装配。workspace sandbox 仍对每次 Bash 调用要求“允许一次”确认；Full Access 在创建 Conversation 时一次性明确确认，之后所有工具直接允许。Full Access 的 permissive Seatbelt profile 不承担访问隔离，只保留进程指纹、资源限制和后台进程清理。服务仍不提供身份认证或持久化等待。
