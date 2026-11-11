# 运行边界

## 会话生命周期

一次 CLI 运行只接收一个用户任务，得到 `final` 后进程退出。HTTP 服务是常驻进程，每个 POST 请求创建独立 Run；Run 内可以经历多轮 LLM 与 Tool 交互。成功 Run 的完整 transcript 持久化到本地 SQLite，会话可在服务重启后继续。

## 步数与历史窗口

- `maxSteps` 限制一次 Agent 任务最多调用 LLM 的轮数，默认和 HTTP 上限均为 512；它不是时间限制。`agent` 工具启动的子 Run 固定 128 步，到达上限时走同样的交接步，交接说明成为它的 `answer`。
- 子 Run 与父 Run 共享 Bash 的审批与会话级授权、workspace 边界和执行模式；每个子 Run 有自己的 Seatbelt 指纹与资源配额。工具并发上限 5 按 Run 各自计：父 Run 一批 5 个子 Run、每个子 Run 一批 5 个只读工具时，进程里最多 25 个工具同时执行；一个 Conversation 同时打开的 Provider 流至多 6 条。父 Run 被取消时 `signal` 传入全部子 Run。子 Run 没有插话入口，运行中追加的用户消息只进父 Run。子 Run 的 transcript 单独持久化，单个子 Run 同样受 16 MiB 上限约束。
- 无状态 Run 的 `maxHistorySteps` 控制最近几组完整 `assistant/tool` 历史，默认 4。会话 Run 的 canonical transcript 始终完整；ContextBuilder 可把当前 Run 的旧完整工具调用对投影为一条累计摘要，再按容量选择以前成功的完整 Run。
- ContextBuilder 在每次 Provider 请求前重算预算；模型容量和输出预留分别来自 `AGENT_MODEL_CONTEXT_TOKENS` 与 `AGENT_MODEL_MAX_OUTPUT_TOKENS`，可用 `AGENT_MAX_HISTORY_TOKENS` 进一步限制旧历史。
- Provider 视图达到硬输入上限的 80% 时触发压缩，60% 是软目标。摘要只覆盖完整 Tool Call/Tool Result 对；原始用户输入、每个 Skill 最新成功调用对和未闭合调用保持原文。摘要失败但原文仍低于硬上限时继续执行；原文已经达到硬上限时返回 `CONTEXT_COMPACTION_FAILED`。
- 固定 system prompt、AGENTS.md、Skill catalog 和工具 schema 每次重新组装，不进入摘要。不可压缩内容加 16 KiB 摘要预留已经达到硬上限时直接返回带占用明细的 `CONTEXT_LIMIT_EXCEEDED`。
- 上下文压缩只影响发送给 Provider 的视图。完成、失败和取消 Run 都持久化完整 canonical transcript 及已经采用的压缩记录。
- Run 在工具批次执行期间结束（用户取消，或 Run 出错）时，agent loop 会在写库前补齐一个 `tool` 消息：同一批里已经完成的调用保留真实结果；没完成的调用补一条 `TOOL_INTERRUPTED` 错误结果，并按是否已经发出过 `tool.started` 区分「执行中」（可能已经产生副作用）与「未开始」两档措辞。落库后的 transcript 因此始终满足工具调用与结果一一配对，同一会话的下一次 Run 能正常继续；主动取消仍不改变取消语义，照旧不补发 `tool.completed`，也不做读取端的兜底修复。

## 超时与重试

- Provider 的 60 秒 timeout 不是整个 Agent Run 的总超时，它只约束拿到响应头之前的请求阶段。流开始后，连续 180 秒收不到任何数据会中止本次请求，并按 `timeout` 交给重试。这个时长是给推理模型思考期间留的余量。
- 瞬时故障由 `RetryingProvider` 自动重试：每次 `stream` 调用最多 5 次尝试，退避基数 1 秒、翻倍、单次上限 30 秒，采用 full jitter；遵守 `Retry-After` / `retry-after-ms`，但服务端要求等待超过 60 秒时直接失败；一次调用累计等待不超过 120 秒；等待期间可随时取消。只有连接失败、流中途断开、idle 超时、408、429（`insufficient_quota` 除外）、500/502/504、503/529、OpenAI `server_error` / `rate_limit_exceeded` 和 DeepSeek `insufficient_system_resource` 会重试；其他 4xx 和模型输出结构非法都不重试。SDK 自带的重试保持关闭。
- 重试会重新发送完整请求，失败尝试已经流出的输出通过 `model.retrying` 事件作废，见 `docs/streaming-sse.md`。失败的尝试拿不到 usage，不计入 `run_model_calls`，因此服务端已计费的部分输出会少记。
- Tool 不会自动重试。`bash` 默认 30 秒超时，调用方最多可指定 120 秒；`grep` 与 `glob` 固定 30 秒超时；`web_fetch` 默认 30 秒超时，与 `web_search` 一样并入 Run 的 `AbortSignal`；`tools/call` 单次 MCP 调用默认 60 秒、上限 600 秒，`initialize` 与 `tools/list` 固定 10 秒；其他 Tool 没有独立超时。
- `workspace_sandbox` Conversation 中的 `bash` 每次执行前等待单次确认，默认 60 秒过期；`full_access` Conversation 对所有工具直接允许。CLI 没有交互式确认处理器，因此遇到 Bash 时仍默认拒绝。
- SSE 客户端断开会将同一个 `AbortSignal` 传给 Provider 和 Tool，并阻止启动后续步骤。默认 `bash` 在正常退出、取消、超时和输出超限时终止原进程组，并等待 macOS helper 清理继承本次 Seatbelt 权限指纹的后代；该路径覆盖 `setpgrp`、`setsid` 和双重 fork。自定义 Tool 仍需要主动响应 signal，无法协作取消的 Tool 可能继续运行，但其结果不会进入事件流。
- 单个 Provider turn 的正文与工具参数合计最多 256 KiB；普通 ToolResult 最多 64 KiB。`skill` 读取的源文件最多 64 KiB，其 JSON 结果考虑转义开销后最多 512 KiB。超限输出不会进入后续事件或 transcript。
- `bash` 的 stdout 与 stderr 还会在读取过程中执行 48 KiB 合计限制，超限后立即终止进程组，避免先在内存中累积无界输出。
- Bash 的资源策略由宿主固定，不接受 Agent 参数。默认上限为 120 秒 Run 聚合 CPU 时间、2 GiB 当前聚合 `phys_footprint`、128 个带本 Run 指纹的存活进程，以及 2 GiB Run 聚合 `ri_logical_writes`；四类超限各自返回稳定错误码。监督器启动、采样或协议失败返回 `RESOURCE_LIMIT_ENFORCEMENT_FAILED`，并进入相同的进程树清理路径。
- 原生 helper 以 10 ms 周期采样 `proc_pid_rusage`，用 `(pid, process start time)` 区分 PID 复用，累计 user + system CPU 与 logical writes，并实时求和物理内存和进程数。`RLIMIT_CPU` 与 `RLIMIT_FSIZE` 作为每进程 CPU、每文件大小的纵深防御，不能替代 Run 聚合统计。
- 资源监督是 macOS 原生 MVP 的 reactive guardrail，不是 cgroup 式严格硬配额：采样间隔内允许有限超调，两个采样点之间完成的极短命进程可能未进入累计值；逻辑写入量也不等于 workspace 最终磁盘占用。需要零漏记和内核强制聚合配额时，应使用 VM 或其他具备资源控制器的后端。
- 未来即使增加 Tool 超时，也不应默认重试有副作用的 Tool；重试必须由幂等性或显式策略控制。

## 本地工具边界

- CLI 把启动时的 `process.cwd()` 固定为 workspace root。Web Conversation 由宿主机目录选择器创建并绑定不可变 canonical workspace 与 execution mode；Run 请求不能传入或覆盖二者。
- 每个 Run 从 canonical workspace 根目录读取一次 `AGENTS.md`。当前只接受不超过 64 KiB 的严格 UTF-8 普通文件，并拒绝符号链接；缺失或空文件使用基础 system prompt。完整 prompt 在首次 Provider 调用前写入 `runs.system_prompt`。读取或持久化失败进入现有 Run 失败路径，Provider 保持零调用。
- 每个 Run 从 `<workspace>/.agents/skills` 与 `~/.agents/skills` 两处发现 Skill，按名合并、同名 workspace 覆盖用户级（被覆盖的用户级条目输出 `SKILL_SHADOWED`，不算错误）。只把合法条目的 `name + description` 注入最多 32 KiB 的 catalog；catalog 里 workspace 条目排在前面、永不裁剪，超限只从用户级尾部省略，诊断列出被省略的名称。完整 `SKILL.md` 只在 `skill(name)` 执行时读取，文件最多 64 KiB，要求严格 UTF-8、`name` 与目录名一致。两个来源的符号链接规则不同：workspace 侧拒绝 Skill 根目录、Skill 目录和 `SKILL.md` 符号链接，且必须留在 workspace 内；用户级目录在用户自己的主目录里，允许 `.agents`、`skills` 和 Skill 目录是符号链接（安装器与 dotfiles 的常见做法），但 `SKILL.md` 始终不能是符号链接、必须留在 canonical Skill 目录内。`skill` 结果携带 `source`（workspace/user）与 `directory`（canonical 目录绝对路径），Skill 内相对路径按 `directory` 解析，读取仍走普通工具与原有权限。Skill Registry 不进入 WorkspaceRuntime 缓存，下一 Run 重新发现。
- 目录选择成功后先预热对应 `WorkspaceRuntime`，再落 Conversation。缓存键由 canonical path 与 mode 共同组成，初始化失败时 fail closed。
- 宿主目录选择接口拒绝非 loopback 且未由 `CORS_ALLOW_ORIGIN` 明确允许的浏览器 Origin，避免普通第三方网页向 localhost 发起简单 POST 并弹出系统选择器。服务仍应只监听 loopback；缺失 Origin 的非浏览器本机调用不等同于身份认证。
- `write`、`edit` 会执行词法路径和真实路径检查，拒绝父目录穿越及符号链接逃逸。`write` 不会隐式创建父目录。`read` 默认采用相同边界；会话 Run 可通过宿主机文件选择器获得绑定 `conversationId + toolCallId + canonicalPath` 的单文件只读一次授权。执行前会重新解析真实路径并原子消费授权；授权不适用于 `write`、`edit` 或 `bash`。
- `grep` 使用固定的 ripgrep 参数数组执行正则内容搜索，不经过 shell。它与 `read` 共享 workspace 路径边界；workspace sandbox 不允许搜索项目外路径，Full Access 可搜索明确指定的项目外路径。结果过滤敏感 workspace 路径，并返回 workspace 相对路径、1-based 行号和匹配行。
- `glob` 用 `rg --files` 按名字找文件，复用 `grep` 的沙箱执行、路径边界与敏感文件过滤；结果按修改时间倒序，最多返回 500 条。不用 `rg -g`：ripgrep 的 include glob 优先于 `.gitignore` 与隐藏文件过滤，`**/*` 这类宽模式会把被忽略的文件列出来，因此在主进程用最小 glob 匹配过滤 `--files` 的结果。这意味着 8 MiB 的输出上限落在 `path` 下全部未忽略文件的列表上，而不是匹配结果上；超过时返回 `COMMAND_OUTPUT_TOO_LARGE` 并提示收窄 `path`。ripgrep 默认跳过隐藏文件与 `.gitignore` 命中，需要看隐藏文件时仍走 Bash。
- `web_fetch` 在 Harness 主进程抓取 URL，两种执行模式下均免审批，不携带本机 Cookie 或凭据。`workspace_sandbox` 下对每一跳目标做地址检查：`dns.lookup({ all: true })` 的任一解析结果落在回环、私网（RFC 1918）、链路本地（169.254/16、fe80::/10）、IPv6 ULA（fc00::/7）、未指定地址或 `::ffff:` 映射的上述 IPv4 段时拒绝；`localhost` 及其子域名、`.local` 后缀直接拒绝；不含 `.` 的单段主机名同样解析后判断，文字 IP（含方括号包住的 IPv6）直接判断不查 DNS。`full_access` 下不做地址检查。地址检查用的解析结果与 `fetch` 实际连接用的解析结果是两次查询，存在 DNS rebinding 窗口；Node 内建 `fetch` 不暴露连接钩子，堵住该缺口需要引入 `undici`，本方案不做，性质与资源配额的采样间隔缺口相同。
- MCP Server 由用户在 `~/.agents/mcp.json`（用户级）或 `<workspace>/.agents/mcp.json`（workspace 级，同名覆盖用户级）里显式配置，stdio 类型在宿主机直接起进程、不进 Seatbelt：它与 `npm install` 进来的依赖同等信任，且多数 Server 需要访问网络，而 Seatbelt profile 恰恰没有网络。环境变量只传 `PATH`、`HOME`、`LANG`、`TMPDIR` 加配置里写的 `env`，Harness 自己的 Provider API Key 不泄漏。HTTP 类型不做地址检查——`web_fetch` 拒绝私网是因为 URL 来自模型，而 `mcp.json` 的 URL 来自用户，用户完全可以把自己的 Server 部署在 localhost。MCP 工具的凭据经 `${VAR}` 从 Harness 进程环境展开，展开值不回文件、不进 transcript、不进诊断；引用的变量缺失时该 Server 被跳过。`workspace_sandbox` 下 MCP 工具默认 `confirm`（在沙箱外执行、可能有副作用），`full_access` 下直接放行。
- 用户级 stdio Server 的 `cwd` 相对 `~` 解析并必须留在主目录内（`resolveUserMcpCwd`）；workspace 级 stdio Server 的 `cwd` 相对 workspace 并必须留在其内（`resolveMcpCwd`）。两个边界根不能混用：用户级配置不属于任何 workspace。
- MCP 设置面板（Web）通过 `GET/PUT /v1/agent/mcp-config` 与 `POST /v1/agent/mcp-config:probe` 管理用户级文件。读写与测试连接都要求受信任的宿主动作 Origin；写回额外要求服务绑定 loopback，因为 stdio Server 在宿主机直起、可执行命令。写回用临时文件 + rename 原子替换，写前拒绝符号链接，写后读回一次做校验闭环。面板只改用户级文件，workspace 级文件不走面板。
- `bash` 由 `MacOsSeatbeltSandboxRunner` 启动。文件读取采用显式系统/工具链/workspace allowlist，写入只允许 workspace 与命令级临时 HOME，网络默认不可达；workspace 外符号链接仍受目标路径策略限制。
- Full Access 仍经 permissive Seatbelt profile 标记进程，但不限制宿主文件和网络；profile 只保护进程指纹，供资源统计和逃逸后代清理使用。Full Access 使用真实 HOME、临时 TMPDIR 和相同环境白名单。
- Bash 子进程只接收 `HOME`、`TMPDIR`、`PATH`、`SHELL`、locale、`TERM` 和沙箱标识，不继承 Provider API Key。临时 HOME 会在命令结束后删除，因此真实 `~/.gitconfig`、语言版本管理器配置和用户缓存默认不可见。
- Stop Hook 的检查脚本与 `bash` 走同一个 `SandboxRunner`：复用当前执行模式的 Seatbelt 策略、资源配额、环境白名单、取消与进程树清理，只在 `SandboxCommand` 上多一个一次性写入 stdin 的字段。`workspace_sandbox` 下 `stop_hook` 规则为 `confirm`，`deriveGrantOptions` 返回空数组，因此交互层拒绝任何会话级授权请求，一次批准只覆盖这一次检查；`full_access` 由策略链首位直接放行。检查通过内部工具执行，不进入模型可见工具列表，也不产生 assistant tool-call 消息。脚本的 stdin、stdout 与 stderr 受 8 MiB 输入、48 KiB 输出上限约束，超限按 `STOP_HOOK_FAILED` 失败；脚本内再启动 Seatbelt 仍会遇到嵌套沙箱限制，Harness 不因此改变权限边界。
- macOS 运行时启动时预检 `/usr/bin/sandbox-exec` 和生成策略。预检失败或平台不支持时 fail closed，不会回退到宿主执行。Seatbelt 运行期阻断没有稳定的独立退出码；结果保留原始 `exitCode`/`stderr`，仅在出现 `Operation not permitted` 时附加 `sandboxStatus: "possibly_blocked"`。
- 每个 Bash Run 会创建一对位于沙箱可写范围外的真实 canary，只把其中一个精确路径加入本次 Seatbelt profile。宿主原生 helper 通过 `sandbox_check + libproc` 找出同时满足“处于沙箱、允许 canary A、拒绝 canary B”的进程并循环清理；并发 Run 的指纹互不相同。查询失败、终止失败或清理不收敛会返回 `PROCESS_CONTAINMENT_FAILED`。
- 这套识别依赖 macOS SPI，解决的是当前 Seatbelt MVP 中已发现的脱组和 daemonize 逃逸，不宣称与 cgroup、Endpoint Security 或 VM 等价。恶意进程若主动改变自身可查询的 Seatbelt 指纹，纯用户态 helper 仍缺少公开、零竞态的内核级收容保证；需要强对抗保证时应升级为 Endpoint Security 系统扩展或 VM 后端。
- 当前服务的 Conversation 数据持久化到本地 SQLite；Tool 确认和单文件读取授权仍只在内存中，不跨进程恢复。SSE 断开会取消 Run 并清理 pending Interaction；CORS 不是认证机制。
- Full Access 创建与每次运行都要求服务绑定 loopback，并拒绝非 loopback 浏览器 Origin；无 Origin 的本机进程仍可调用，因此这不是本机进程间认证。
- WorkspaceRuntime 缓存当前随进程存活且没有容量淘汰；可信本机 MVP 可接受，长期运行并频繁打开大量不同项目时需要增加 LRU 或显式关闭。

## 后续扩展前需要明确

- 交互式多轮 CLI：区分“用户对话轮次”和“单个用户任务内部的 Agent step”，再确定窗口作用在哪一层。
- 跨 Run 长会话摘要：当前只压缩单个 Run 内的旧工具调用对；以前成功 Run 仍按完整 Run 选择。
