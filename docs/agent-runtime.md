# Agent 运行机制

## 运行环境与资源限制

当前运行时只支持 macOS。创建 Conversation Runtime 时会预检 Seatbelt；平台不支持、`sandbox-exec` 不存在或策略无法初始化时会直接失败，不会降级为宿主执行。HTTP 服务仍无身份认证，应保持绑定在 `127.0.0.1`；Full Access 在非 loopback 绑定下不可创建或运行。

命令结束、超时、取消或输出超限时，Runner 会终止原进程组，并由 macOS helper 按每个 Run 独有的 Seatbelt 权限指纹清理继承策略的后代；`setpgrp`、`setsid` 和双重 fork 不会改变该指纹，并发 Run 使用彼此隔离的指纹。helper 无法运行或清理不收敛时会以 `PROCESS_CONTAINMENT_FAILED` 失败，不会静默返回成功。该实现依赖 macOS `sandbox_check`/`libproc` SPI，属于本机 Seatbelt MVP 的增强进程树清理，不等同于 Endpoint Security 或 VM 提供的内核级强对抗收容，也不应作为多租户隔离边界。

每次 Bash Run 还应用宿主固定的资源策略，默认限制为 120 秒聚合 CPU 时间、2 GiB 聚合物理内存、128 个存活进程和 2 GiB 聚合逻辑写入；这些值不由 Agent 输入控制。宿主 helper 每 10 ms 按同一个 Seatbelt 指纹采样并在超限时终止整棵已识别进程树，同时通过 `RLIMIT_CPU` 和 `RLIMIT_FSIZE` 增加单进程 CPU、单文件大小的内核级后备限制。超限分别返回 `COMMAND_CPU_LIMIT_EXCEEDED`、`COMMAND_MEMORY_LIMIT_EXCEEDED`、`COMMAND_PROCESS_LIMIT_EXCEEDED` 或 `COMMAND_DISK_WRITE_LIMIT_EXCEEDED`；监督器异常返回 `RESOURCE_LIMIT_ENFORCEMENT_FAILED`。

macOS 原生没有面向普通进程的 per-Run cgroup。上述 CPU、内存、进程数和逻辑写入是主动采样式配额，存在采样间隔内超调，也可能漏记两个采样点之间创建并退出的极短命后代；磁盘指标表示进程逻辑写入量，不是 workspace 最终占用空间。它适合防止常见失控命令，不应被解释为 VM 或容器级严格硬配额。

## 协议

Harness 使用统一的 `ProviderTurn` 接收每轮模型结果：正文回答为 `final`，工具调用为携带 1–4 个厂商原生调用 ID 的 `tool_calls`。Provider 在流式阶段分别产生正文增量、带调用索引的工具参数增量和一个完成事件；Agent Loop 不再解析自定义 Thought + Action JSON。

一次双工具调用在 canonical transcript 中固定写成两条消息：assistant 消息的 `toolCalls` 保存两个调用，紧随其后的 tool 消息用 `results` 保存两个结果。两个数组长度相同，调用 ID、工具名和顺序严格对应。OpenAI 把批次展开为多个 `function_call` / `function_call_output`，DeepSeek 把它映射为一个含多个 tool call 的 assistant 消息和多个 tool 消息。调用 ID 始终使用厂商返回的 opaque ID，Harness 不生成或伪造。

Agent Loop 只并行执行同一批次中全部属于 `read`、`grep` 的调用，上限为 4。准备、参数校验、权限和资源授权仍按调用顺序执行；实际读取并行启动。`tool.completed` 按真实完成顺序发送，canonical `results` 始终按原始调用顺序写入。混合批次和其他工具继续串行执行。普通工具失败只占据自己的结果位置；取消或致命错误保留未闭合 assistant 批次，不写部分 tool 结果消息。

一个 Run 默认最多执行 512 个模型步骤，`POST .../runs:stream` 的 `maxSteps` 上限同为 512。`maxSteps` 不小于 2 时，最后一个步骤保留给交接：Harness 在该步把工具集置空，并在 Provider 视图末尾追加一条要求交接的 synthetic user message，模型只能输出正文。该步产生的回答按正常终态写入，`run.completed` 的 `stopReason` 为 `step_limit`，正常自主回答时为 `final`。因此 `maxSteps` 为 N 时最多执行 N-1 个工具步骤。模型在交接步仍然返回工具调用时，Run 以 `MAX_STEPS_EXCEEDED` 失败。

普通 ToolResult 在 Provider 边界会被包裹为 `untrusted_tool_result`，并配合 system instruction 明确声明其内容是不可信数据、不能授权操作或改变用户目标。成功的内建 `skill` 结果是唯一例外，会被包装为 `workspace_skill_instructions`；该信任只允许模型遵循 Skill 工作流程，不能改变用户目标、工具权限、execution mode、workspace 边界或 sandbox。这是提示层的最小纵深防御，不改变现有 Tool 权限与审批策略；Full Access 仍不会因为该改动增加逐次审批。

Harness 在每个 Run 开始时读取该 Conversation 绑定的 canonical workspace 根目录下的 `AGENTS.md`，并与基础行为、自主性契约和 ToolResult 信任规则拼成一份 Provider 无关的 system prompt。Conversation Run 在首次 Provider 调用前把完整快照写入 `runs.system_prompt`。同一 Run 的所有模型步骤复用该快照，下一 Run 重新读取文件。CLI 使用启动时的 `process.cwd()` 作为 workspace root。当前仅支持根目录普通文件，缺失或空文件等同于没有 workspace 指令；文件上限为 64 KiB，要求严格 UTF-8，并拒绝符号链接。

自主性契约明确 Run 的经济学：final answer 会结束整个 Run、用户必须重新输入才能继续，所以提问的代价是一次完整往返，而多一次工具调用只占一个步骤。据此要求模型自己完成只读调查而不是申请许可、在多种理解导致同样工作时直接按最可能的一种做并说明假设、不得以「下一步 A/B/C 请选择」结尾。只有三种情况才停下来问：不同理解导致实质不同的产出且证据无法判定、下一步操作破坏性或不可逆或对 workspace 之外可见、被只有用户能提供的东西阻塞；且提问前必须先完成不依赖该答案的部分。

每个 Run 还会发现两处 Skill：workspace 的 `<workspace>/.agents/skills/<name>/SKILL.md` 和用户级的 `~/.agents/skills/<name>/SKILL.md`。两个来源按名合并，同名时 workspace 覆盖用户级，被覆盖的用户级条目输出 `SKILL_SHADOWED` 诊断（不算错误）。发现阶段只读取 YAML frontmatter，将合法 Skill 的 `name + description` 以最多 32 KiB 的精简 catalog 注入 system prompt；模型匹配任务后调用 `skill(name)` 加载完整文件，结果里带 `source` 与 `directory`（canonical 目录绝对路径），Skill 里的相对路径按 `directory` 解析。Skill 目录只扫描一层，名称必须与目录名一致，完整文件上限为 64 KiB，要求严格 UTF-8。

两条来源的边界不同：workspace 侧的 Skill 根目录、Skill 目录都必须留在 workspace 内且不能是符号链接；用户级目录在用户自己的主目录里，允许根目录和 Skill 目录是符号链接（这是安装器和 dotfiles 的常见做法），但 `SKILL.md` 本身始终不能是符号链接、必须留在 canonical Skill 目录内。catalog 超限时 workspace 条目在前、永不裁剪，只会从用户级尾部省略，诊断列出被省略的名称。非法 Skill 会被跳过并输出结构化诊断。Skill Registry 不进入 `WorkspaceRuntime` 缓存，下一 Run 会重新发现。Skill 引用的 references、assets、scripts 继续通过普通工具访问，并沿用原权限和不可信结果边界；`workspace_sandbox` 下读用户级 Skill 的支撑文件会像 workspace 外文件一样弹 read 授权，`full_access` 下无此限制。操作本机应用的 Skill（如 browser-cli）实际需要 `full_access`。

无状态 Run 默认只向 Provider 发送当前 user 消息和最近 4 组完整的 `assistant/tool` 步骤。会话 Run 在每次 Provider 请求前根据 `AGENT_MODEL_CONTEXT_TOKENS`、`AGENT_MODEL_MAX_OUTPUT_TOKENS`、system prompt、工具 schema、输出预留和安全余量构造 Provider 视图。请求达到硬输入上限的 80% 时，ContextBuilder 将当前 Run 中足够早的完整 Tool Call/Tool Result 对压缩成累计摘要，目标为 60% 的软预算；原始用户输入、每个 Skill 最新的成功调用对和未闭合调用保持原文。累计摘要以带固定说明前缀的 synthetic user message 放在原始用户输入之后。固定 system prompt、AGENTS.md、Skill catalog 和工具 schema 每次重新组装，不进入摘要。

压缩只改变 Provider 视图，Agent Loop 的 canonical transcript 始终完整。摘要调用使用同一个 Provider、`tools: []`、最多 2048 输出 token 和同一个 AbortSignal，不产生公开流式事件，也不计入 `maxSteps`。摘要失败且原始请求仍低于硬上限时继续使用原文；达到硬上限时返回 `CONTEXT_COMPACTION_FAILED`。不可压缩的固定层、当前用户输入、受保护 Skill 组和摘要预留已经达到硬上限时直接返回带占用明细的 `CONTEXT_LIMIT_EXCEEDED`。压缩后再从最新到最旧选择完整的成功 Run；`AGENT_MAX_HISTORY_TOKENS` 只进一步限制这些旧 Run。

历史 Run 的投影有三档：能装下时保留完整原文；原文装不下但有工具步骤时，把该 Run 降级为 3 条消息——原始用户输入、带固定说明前缀的历史摘要、最终回答原文——并写入 `run_history_summaries` 表供后续 Run 复用；连摘要投影也装不下或该 Run 没有工具步骤时，该 Run 及更旧的 Run 都不纳入，保持历史时间连续。历史摘要惰性生成，每个 `buildContext` 最多生成 1 条，失败时截断到该点而不终止 Run。发生降级或丢弃时，stderr 输出一行 `context.history_projection` JSONL，只含 ID 和计数。

每次 Provider 调用都会把真实 token 用量记入 `run_model_calls`：`step`（Agent Loop 的模型步骤）、`context_compaction`（Run 内累计摘要）、`history_summary`（跨 Run 历史摘要）三类调用各记一行。各调用的 `inputTokens` 包含命中缓存的部分，`cachedInputTokens` 是其中命中缓存的子集（恒不超过 `inputTokens`），`outputTokens` 包含推理 token，`reasoningTokens` 是其子集（恒不超过 `outputTokens`）。Provider 未返回可用 usage 时该行仍写入，四个计数一起记 NULL——调用发生这一事实不丢，成本未知也不会被伪装成 0；汇总时这类调用只计入 `unmeasuredCalls`，不参与求和。`run.completed` 事件与 CLI `run.usage` 诊断携带该 Run 的合计值；`run.error` 的 `usage` 是可选的，HTTP 层在 Run 事件流异常时补发的兜底 `run.error` 拿不到真实用量，省略该字段表示未知，而不是填 0。会话读出接口在每条 Run 上返回 `usage` 汇总，并在 Conversation 上返回全部 Run（含失败重试）的合计。

## 代码结构

- `src/agent-loop.ts`：与厂商无关的执行循环和 transcript
- `src/agent-tool-batch.ts`：工具批次的并行判定、执行编排和稳定结果排序
- `src/agent-tool-call.ts`：单次工具调用的参数准备、权限、交互、资源授权、执行与审计
- `src/provider-protocol.ts`：Provider turn、流事件和请求接口
- `src/transcript.ts`：canonical transcript schema、序列化和字节计算
- `src/stop-hook.ts`：完成检查端口、决策类型与检查错误
- `src/stop-hook-result.ts`：`source: "stop_hook"` 检查记录的构造、解析与模型边界序列化
- `src/infrastructure/workspace-stop-hook-config.ts`：`.agents/stop-hook.json` 的有界读取与校验
- `src/application/command-stop-hook.ts`：执行脚本、解析脚本输入输出、转换脚本错误
- `src/application/stop-hook-session.ts`：一次检查的编排——执行检查、转发检查事件、处理检查异常并写故障记录、写检查记录、执行补做次数上限，返回“放行 / 过期 / 继续”三种结论
- `src/system-prompt.ts`：Provider 无关的基础规则、自主性契约、ToolResult 信任规则和 workspace 指令拼装
- `src/agent-events.ts`：公开事件协议、事件序号和展示数据投影
- `src/run-usage.ts`：单次 Run 的模型调用用量日志、`seq` 分配与合计
- `src/domain/`：Conversation、Turn、Run 领域类型和业务异常
- `src/application/`：应用依赖装配、Conversation 用例、Run 生命周期编排、ContextBuilder 和 Store 端口
- `src/application/context-compactor.ts`：当前 Run 的完整工具对边界、累计摘要生成、Skill 保护组和 Provider 输入投影
- `src/application/run-history-summarizer.ts`：把一个已完成 Run 压成一条跨 Run 历史摘要
- `src/application/summary-request.ts`：Provider 摘要调用的共享守卫
- `src/application/interaction-broker.ts`、`workspace-grant-store.ts`：内存 Interaction 生命周期与单次文件授权
- `src/application/workspace-runtime.ts`：按 canonical workspace 缓存同根工具和沙箱 Runtime
- `src/infrastructure/`：SQLite schema、事务、ConversationStore、recovery 和数据库连接
- `src/http/`：Controller、SSE 传输和静态文件适配
- `src/protocol.ts`：ToolResult 协议与稳定错误码
- `src/tools.ts`：工具定义、注册、参数校验和执行
- `src/tool-permissions.ts`：固定 Tool 权限策略和授权执行入口
- `src/sandbox/`：SandboxRunner 端口、进程生命周期和 macOS Seatbelt 实现
- `src/infrastructure/host-file-picker.ts`：macOS 系统文件选择器适配层
- `src/infrastructure/workspace-instructions.ts`：根 `AGENTS.md` 的有界、严格 UTF-8 读取
- `src/infrastructure/workspace-skills.ts`：workspace 与用户级 Skill 发现、校验、合并、catalog 和按需加载
- `src/tools/skill.ts`：当前 Run 的 `skill(name)` 工具
- `src/tools/`：默认文件工具、bash 工具和 workspace 路径解析
- `src/providers/deepseek.ts`：DeepSeek Chat Completions 原生 Tool Calling 适配
- `src/providers/openai.ts`：OpenAI Responses API 原生 Tool Calling 适配
- `src/providers/tool-result-boundary.ts`：普通不可信结果与 workspace Skill 指令的序列化边界
- `src/server.ts`：把请求 Handler 适配为 Node HTTP Server
- `src/server-bootstrap.ts`：Application、Controller、HTTP Server 和数据库生命周期的装配，`startAgentServer` 允许宿主脚本替换目录选择器等依赖
- `src/server-main.ts`：Web 进程入口，调用 `startAgentServer` 并由本进程注册 SIGINT/SIGTERM
- `desktop/`：Electron 主进程、后端进程协调与后端桌面入口，说明见 [docs/macos-desktop.md](./macos-desktop.md)
- `scripts/eval-server.mjs`：评测入口，注入固定 workspace 目录，不弹目录选择器
- `src/index.ts`：最小命令行装配入口
- `web/`：React 运行台、SSE 客户端和前端状态模型

两个 Provider 都使用厂商原生 Tool Calling，但分别保留独立的 API 映射。Agent Loop 负责批次校验、参数 schema 校验、权限/审批、执行与结果回传。当前明确拒绝缺失或重复调用 ID、超过 4 个调用和不完整响应。正文片段只作为当前运行的流式预览，不写入 canonical transcript。



## Agent 执行接口

`RunAgentOptions` 使用完整 `transcript` 作为输入，所有模型请求统一经过 `contextBuilder`。CLI 同样使用上下文预算和压缩，需配置 `AGENT_MODEL_CONTEXT_TOKENS` 与 `AGENT_MODEL_MAX_OUTPUT_TOKENS`。

`toolEnvironment` 包含工具列表、权限执行器和权限上下文；`createAgentRun()` 创建同一次运行共享的 `runId`、`eventFactory` 与 `usageLog`。`lifecycle.beforeCompleted` 和 `lifecycle.beforeFailed` 在发布运行终态前等待应用层完成持久化。
