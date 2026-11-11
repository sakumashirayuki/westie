# MCP Client：让用户用一个配置文件给模型加工具

> 讨论稿。定稿前不动 `src/`、`web/`、`test/`。

## 一句话

用户在 `~/.agents/mcp.json`（跟人走）或 workspace 的 `.agents/mcp.json`（跟仓库走）里列出
几个 MCP Server；Harness 每次 Run 开始时连上这些 Server，把它们公布的工具包成普通 `Tool`
加进模型的工具集。模型看到的只是多了一批
名字叫 `mcp__<server>__<tool>` 的工具，其余一切（审批、结果边界、子 Run、上下文预算）照旧。

## 术语

| 词 | 意思 |
|-|-|
| MCP | Model Context Protocol。一个让「提供工具的程序」和「用工具的 agent」互相说话的标准协议。 |
| MCP Server | 提供工具的一方。比如 `@modelcontextprotocol/server-github` 提供 `create_issue`、`search_code` 等工具。可以是本地进程，也可以是远端 HTTP 服务。 |
| MCP Client | 用工具的一方。本方案要实现的就是这个，它住在 Harness 主进程里。 |
| `tools/list` / `tools/call` | MCP 定义的两个方法：Server 列出工具（名字、说明、参数的 JSON Schema），Client 调用工具。本方案只用这两个加握手用的 `initialize`。 |
| JSON-RPC 2.0 | MCP 消息的格式：`{ "jsonrpc": "2.0", "id": 1, "method": "...", "params": {...} }` 发请求，同 `id` 的 `result` 或 `error` 回响应，没 `id` 的是单向通知。只规定消息长什么样，不规定怎么传。 |
| stdio 传输 | Server 是 Harness 起的子进程，一行一条 JSON 走 stdin/stdout。开源 MCP Server 绝大多数是这种。 |
| Streamable HTTP 传输 | Server 是一个 HTTP 端点，每条消息一次 POST，响应是 JSON 或 SSE 流。适合公司内部共享部署。 |

两种传输本方案都支持。不支持的：旧版 HTTP+SSE 传输、OAuth、以及 MCP 里 tools 之外的能力
（resources、prompts、sampling、elicitation、roots）。

## 用起来是什么样

1. 用户放一个配置文件。跟人走的放 `~/.agents/mcp.json`，跟仓库走的放
   `<workspace>/.agents/mcp.json`，两份格式相同，同名 Server 以 workspace 的为准：

   ```jsonc
   // ~/.agents/mcp.json 或 <workspace>/.agents/mcp.json
   {
     "servers": {
       "github": {
         "type": "stdio",
         "command": "npx",
         "args": ["-y", "@modelcontextprotocol/server-github"],
         "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
       },
       "internal-docs": {
         "type": "http",
         "url": "https://mcp.example.com/mcp",
         "headers": { "Authorization": "Bearer ${DOCS_MCP_TOKEN}" }
       }
     }
   }
   ```

   `${GITHUB_TOKEN}` 从 Harness 的 `.env` 里取，所以这个文件可以进版本库。

2. 用户发消息「给 owner/repo 开一个 issue，标题……」。模型的工具列表里多了
   `mcp__github__create_issue` 等工具，它选中一个调用。

3. `workspace_sandbox` 会话里弹出审批卡片，写着
   「Calls "create_issue" on MCP server github; runs outside the workspace sandbox」。
   用户批准，或者选「本会话允许」以后不再问。`full_access` 会话不审批。

4. 结果回到模型，前端轨迹里这条工具卡片的摘要行是 `github · create_issue`，展开能看到
   Server 返回的文本。

5. 某个 Server 起不来（命令不存在、token 没配）：服务 stderr 打一条诊断，这个 Server 的
   工具不出现，其他一切正常。改了 `mcp.json` 不用重启，下一个 Run 生效。

## 结构

```mermaid
flowchart LR
  subgraph ws["workspace"]
    cfg[".agents/mcp.json"]
  end
  subgraph harness["Harness 主进程"]
    loader["workspace-mcp-config.ts<br/>读配置、展开 ${VAR}"]
    pool["McpServerPool<br/>按 workspace+server 复用连接"]
    client["McpClient<br/>initialize / tools.list / tools.call"]
    stdio["stdio-transport"]
    http["http-transport"]
    adapter["createMcpTool<br/>远端工具 → Tool"]
    run["ConversationRunService<br/>baseTools += mcp tools"]
    perm["权限策略<br/>mcp__ 前缀默认 confirm"]
  end
  subgraph servers["MCP Servers"]
    proc["子进程<br/>(npx server-github)"]
    remote["远端 HTTP 端点"]
  end
  cfg --> loader --> pool --> client
  client --> stdio --> proc
  client --> http --> remote
  client --> adapter --> run --> perm
```

新增的部分全在「Harness 主进程」框里：读配置、连接池、协议客户端、两个传输、工具适配。
`ConversationRunService` 和权限策略是现有模块，各改几行。

## 一次 Run 的时序

```mermaid
sequenceDiagram
  participant U as 用户
  participant R as ConversationRunService
  participant P as McpServerPool
  participant S as MCP Server (github)
  participant M as 模型

  U->>R: 发消息
  R->>P: acquire(workspaceRoot, 配置)
  alt 首次或配置变了
    P->>S: 起进程 / initialize / tools.list
    S-->>P: 工具列表
  else 连接还在
    P-->>P: 复用缓存的工具列表
  end
  P-->>R: [Tool...] + 诊断
  R->>M: system prompt + 内建工具 + mcp 工具
  M-->>R: 调 mcp__github__create_issue
  R->>U: 审批卡片（sandbox 模式）
  U-->>R: 批准
  R->>S: tools.call
  S-->>R: content / isError
  R->>M: untrusted_tool_result
  M-->>U: 回答
```

连接跨 Run 复用，所以「起进程 + 握手 + 拉列表」只在第一次或配置改变、进程崩溃后发生。

## 现状与缺口

现在的工具集写死在 `createDefaultWorkspaceRuntime`（`src/runtime.ts`），加 Run 级的 `skill`
和 `agent`。用户没有任何配置面能给模型加工具；想接 GitHub 之类的外部系统，要么改 Harness
代码写内建工具，要么让模型在 Bash 里调 CLI，而 `workspace_sandbox` 下 Bash 没网络，
`full_access` 下每条命令审批一次、输出还得模型自己解析。

现有代码里有三个可以直接借力的地方，和一个空白：

- `Tool` 接口（`src/tools.ts`）只要求 `name`、`description`、`impact`、`inputSchema: z.ZodObject`、
  `execute`。任何东西只要包成这个形状，注册、校验、并行、结果包装、预算计算全都自动适用。
- `#runEvents`（`conversation-run-service.ts:128`）每个 Run 复制一份 `baseTools`，追加 `skill`
  后再拿它构造 `agent`。追加进 `baseTools` 的工具，子 Run 自动可见。
- `.agents/skills/` 的发现逻辑（`workspace-skills.ts`）已经定好了 workspace 配置的规矩：
  拒绝符号链接、限大小、严格 UTF-8、非法条目变诊断不让 Run 失败。
- 空白：没有「活过多个 Run 的子进程」这个概念。`SandboxRunner` 是一次性命令模型。

## 六个关键决定

每条都是「问题 → 决定 → 理由」。反对哪一条请直接指出来。

**1. 自己实现协议子集，不引 `@modelcontextprotocol/sdk`。**
需要的只是 JSON-RPC 分帧、三个方法、两个传输，估 500 行以内。项目一直把运行时依赖压在
`openai`、`yaml`、`zod` 三个，SDK 会带进一串传递依赖。退路：如果 Streamable HTTP 的边角比
预期多，只对 HTTP 传输引 SDK。

**2. 远端工具的 JSON Schema 用 `z.fromJSONSchema` 转成 zod。**
`Tool.inputSchema` 是 zod 对象，`ToolRegistry`、两个 Provider、预算器四处都以它为真源。
转成 zod 后这四处一行不用改。转不了的工具跳过并报诊断。`Tool` 加一个可选字段
`looseInputSchema: true`，让 OpenAI provider 对这类工具关掉 `strict` 模式，因为外来 schema
里可选字段、`anyOf` 很常见，strict 会拒绝。

**3. stdio Server 在宿主机直接起，不进 Seatbelt。**
它是用户在配置里显式安装的程序，性质等同 `npm install` 进来的依赖，而且大多数 Server
本身就要访问网络，Seatbelt profile 恰恰没有网络。环境变量只传 `PATH`、`HOME`、`LANG`、
`TMPDIR` 加配置里写的 `env`，Harness 自己的 API Key 不泄漏给它。

**4. HTTP 传输不做地址检查。**
`web_fetch` 拒绝私网地址是因为 URL 来自模型；`mcp.json` 里的 URL 来自用户，用户完全可能
把 Server 部署在 localhost。这是两者的本质区别，写进 `runtime-boundaries.md`。

**5. `workspace_sandbox` 下 MCP 工具默认 `confirm`。**
它们在沙箱外执行、可能有副作用，Harness 对其语义一无所知。用户点「本会话允许」走已有的
单工具会话授权，不加新授权种类。Server 自报的 `readOnlyHint` v1 不据此放行。

**6. 连接跨 Run 复用，由进程级 `McpServerPool` 管；配置每个 Run 重读。**
起进程加握手要几百毫秒到几秒，每个 Run 重连太贵；配置文件很小，每次重读没成本，还能做到
改配置不重启。`WorkspaceRuntime` 缓存不碰，MCP 工具在 `#runEvents` 里追加进 `baseTools`，
和 `skill` 一个位置。

**7. 配置分用户级和 workspace 级两份，同名时 workspace 覆盖。**
初稿只有 workspace 一级，理由是 YAGNI；实施后发现两个问题。一是 Playwright、filesystem
这类工具型 Server 跟人走不跟仓库走，每个 workspace 抄一份配置很别扭，Codex、Claude Code、
Cursor 也都是用户级加项目级两份。二是只认 workspace 配置有个安全倒置：打开别人的仓库，
它的 `.agents/mcp.json` 里的命令会在宿主机沙箱外被执行；用户级配置是自己写的，没有这个
问题。连接池的 key 仍按 workspace 分，全局 Server 在每个 workspace 各起一份，因为 stdio
的 `cwd` 不同，浏览器之类的状态也不该跨 workspace 共享。workspace 级 Server 首次连接前
要不要弹一次确认，留作后续项，见文末。

## 各部分细节

### 配置文件 `mcp.json`

两个位置，格式相同：

| 位置 | 作用域 | 边界检查 |
|-|-|-|
| `~/.agents/mcp.json` | 用户级，所有 workspace 可见 | `realpath` 后必须在用户主目录内 |
| `<workspace>/.agents/mcp.json` | 只对该 workspace 可见 | `realpath` 后必须在 workspace 内 |

`src/infrastructure/workspace-mcp-config.ts` 的 `loadMcpConfig({ workspaceRoot, homeDir })`
两份都读，按 Server 名合并，同名以 workspace 为准；诊断合并输出，`path` 字段区分来源。
单份文件规则同 `AGENTS.md`：普通文件、拒绝符号链接、上限 64 KiB、严格 UTF-8；缺失等同
没有 Server。zod 校验整个文件。stdio 的 `cwd` 按来源解析：workspace 级相对 workspace 根，
用户级相对主目录（它不属于任何 workspace），`realpath` 后必须落在各自的根内；缺省为根本身。
连接仍按 workspace 分别建立。

| 字段 | 说明 |
|-|-|
| Server 名 | `^[a-z0-9]+(?:-[a-z0-9]+)*$`，1–32 字符，与 skill 同规则 |
| `type` | `"stdio"` 或 `"http"` |
| `command`、`args`、`env`、`cwd` | stdio 专用。`cwd` 是相对路径，workspace 级相对 workspace 根，用户级相对主目录，`realpath` 后必须在各自根内 |
| `url`、`headers` | http 专用 |
| `timeoutMs` | 单次 `tools/call` 超时，缺省 60 s，上限 600 s |

`env` 和 `headers` 的值支持 `${VAR}`，从 Harness 进程环境取。引用的变量不存在时该 Server
跳过并报诊断；展开后的值不回文件、不进 transcript、不进诊断。文件整体非法报
`INVALID_MCP_CONFIG`，全部跳过；单个 Server 非法只跳过它。诊断结构与
`WorkspaceSkillDiagnostic` 同形，走同一种 stderr JSON 行。

### 协议层 `src/mcp/`

| 文件 | 职责 |
|-|-|
| `json-rpc.ts` | 请求、响应、通知的类型与 zod schema。`id` 递增整数。单条消息超过 `MAX_MCP_MESSAGE_BYTES = 4 MiB` 判连接损坏。 |
| `stdio-transport.ts` | `spawn` 子进程，stdout 按换行切 JSON，stderr 只留最后 8 KiB 供诊断。关闭：关 stdin → 2 s 后 `SIGTERM` → 再 2 s `SIGKILL`。 |
| `http-transport.ts` | 每条消息一次 POST，`Accept: application/json, text/event-stream`。响应是 JSON 直接解析，是 SSE 就读 `data:` 事件直到看到对应 `id`。保存并回带 `Mcp-Session-Id`，后续请求带 `MCP-Protocol-Version`。不开 GET 长连接。关闭时 `DELETE` 一次，失败忽略。 |
| `client.ts` | `McpClient`。`connect()`：发 `initialize`（版本取 `SUPPORTED_PROTOCOL_VERSIONS[0]`，`capabilities: {}`），Server 回的版本不在列表里则失败；再发 `notifications/initialized`。`listTools()` 按 `nextCursor` 翻页拿全。`callTool()` 发 `tools/call`，超时或 `signal` 取消时先发 `notifications/cancelled`。Server 发来的请求（sampling、roots、elicitation）统一回 `-32601`；`notifications/message` 按 level 打 stderr；`notifications/tools/list_changed` 只把连接标脏。 |
| `server-pool.ts` | `McpServerPool.acquire(workspaceRoot, config)` 并行处理每个 Server：连接存在、配置哈希相同、还活着、没标脏就复用缓存的工具列表，否则重连重拉。单个 Server 失败只出诊断。`close()` 关全部连接，进程退出时调。 |
| `constants.ts` | 协议版本列表、`MCP_INITIALIZE_TIMEOUT_MS = 10_000`、`DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000`、`MAX_MCP_CALL_TIMEOUT_MS = 600_000`，以及下面的四个上限 |

### 工具适配 `src/tools/mcp-tool.ts`

`createMcpTool(server, remoteTool, client)` 把一个远端工具变成 `Tool`：

| `Tool` 字段 | 怎么来 |
|-|-|
| `name` | `mcp__<server>__<tool>`。远端名里 `[^A-Za-z0-9_-]` 换成 `_`。拼完超 64 字符（OpenAI 上限）或同 Server 内撞名的跳过并报诊断，不截断。 |
| `description` | 远端 `description`，超 `MAX_MCP_TOOL_DESCRIPTION_BYTES = 2 KiB` 截断 |
| `impact` | 含 Server 名、远端原名、`title`、`readOnlyHint` / `destructiveHint`，审批卡片能看到：`Calls "create_issue" on MCP server github (not read-only, destructive: unknown); runs outside the workspace sandbox.` |
| `inputSchema` | `z.fromJSONSchema(remoteTool.inputSchema)`。结果不是 `ZodObject`、转换抛错、或原始 schema 超 `MAX_MCP_TOOL_SCHEMA_BYTES = 16 KiB` 的跳过并报诊断 |
| `looseInputSchema` | `true`，见决定 2 |
| `summarizeInput` | 原样返回参数，与 `bash` 一致 |
| `execute` | 调 `client.callTool`，输出见下 |

输出形状：

```ts
{
  server: string,
  tool: string,               // 远端原名
  content: Array<
    | { type: "text"; text: string }
    | { type: "image" | "audio"; mimeType: string; bytes: number; omitted: true }
    | { type: "resource"; uri: string; mimeType?: string; text?: string }
  >,
  structuredContent?: JsonValue,
}
```

文本块合计超 `MAX_MCP_TEXT_BYTES = 48 KiB` 时从超出的那块起截断，追加一个
`[truncated: N more bytes from MCP server <server>]` 文本块，与既有截断指引一致。图片、音频
只留元信息，base64 不进 transcript。远端返回 `isError: true` 抛
`ToolExecutionError("MCP_TOOL_ERROR", <文本块拼接>)`，模型据此换参数；传输错误、断连、
超时抛 `MCP_SERVER_UNAVAILABLE`。`maxOutputBytes` 用默认 64 KiB。

数量上限：每个 Server 最多 `MAX_MCP_TOOLS_PER_SERVER = 128`，合计 `MAX_MCP_TOOLS_TOTAL = 256`，
按 Server 名、工具名排序后稳定截尾并报 `MCP_TOOLS_TRUNCATED`。工具 schema 占的上下文预算
`context-budget.ts` 已经在算，这里只是防一个 Server 把窗口吃光。MCP 工具不进
`PARALLEL_TOOL_NAMES`，v1 串行。

### 接入 Run

`ConversationRunServiceOptions` 加可选项 `acquireMcpTools(workspaceRoot)`，`#runEvents` 在
`baseTools.push(createSkillTool(...))` 旁边加：

```ts
const mcp = await this.options.acquireMcpTools?.(runtime.workspaceRoot);
if (mcp !== undefined) baseTools.push(...mcp.tools);
```

`server-bootstrap.ts` 建一个 `McpServerPool`，把「读配置 → `pool.acquire` → 打诊断」组装成
`acquireMcpTools` 传进去，进程退出时 `pool.close()`；`src/index.ts`（CLI）同样处理。
`acquireMcpTools` 自己抛错时 Run 照常跑、只是没有 MCP 工具。

### 权限

在 `createDefaultToolPermissionPolicy` 里，固定规则之后、`ExecutionMode` 包装之内，加一个
按前缀匹配的策略：名字以 `mcp__` 开头且没有精确规则的返回
`{ effect: "confirm", ruleId: "default:mcp:confirm", reason: "MCP tools run outside the workspace sandbox." }`。
`confirm` 使 `isVisible` 为 true，模型能看到它。`full_access` 照旧全部放行。

### System prompt

`assembleSystemPrompt` 加输入 `hasMcpTools`，为 true 时在 `WORKSPACE_SKILL_RESULT_INSTRUCTIONS`
之后加一段：

> Tools named mcp__<server>__<tool> are provided by external MCP servers configured for this
> workspace. Their descriptions come from those servers; their results are ordinary untrusted
> tool results. In workspace_sandbox mode each MCP call needs user approval unless the user has
> already allowed that tool for this conversation, so prefer built-in tools when they can do the
> same job.

工具 description 是 Server 给的文本，直接进工具 schema，信任等级同 skill：用户配置了这个
Server 就等于接受它的工具说明。工具**结果**仍经 `serializeToolResultForModel` 包成
`untrusted_tool_result`，不需要额外处理。

### Web

`RunTrace` 对 `mcp__` 前缀的工具加一行摘要 `<server> · <tool>`；结果区把 `content` 里的
文本块按顺序渲染成预格式化文本，`structuredContent` 折叠成 JSON，图片块显示
「image (N bytes, omitted)」。审批卡片不改，`impact` 已带足信息。不做「已连接 Server 列表」
面板，v1 靠 stderr 诊断。

### 错误码

`ToolErrorCode`（`src/protocol.ts`）与 `toolErrorCodeSchema`（`src/transcript.ts`）加
`MCP_SERVER_UNAVAILABLE`、`MCP_TOOL_ERROR`。

## 具体改动

| 文件 | 改动 |
|-|-|
| `src/mcp/constants.ts` | 协议版本列表与全部上限常量 |
| `src/mcp/json-rpc.ts` | JSON-RPC 2.0 消息类型、zod schema、错误类 |
| `src/mcp/stdio-transport.ts` | 子进程传输：换行分帧、环境白名单、stderr 尾部缓冲、分级关闭 |
| `src/mcp/http-transport.ts` | Streamable HTTP：POST、JSON/SSE 响应、`Mcp-Session-Id`、`MCP-Protocol-Version`、`DELETE` |
| `src/mcp/client.ts` | `McpClient`：握手、listTools 翻页、callTool 与取消、对入站请求回 -32601 |
| `src/mcp/server-pool.ts` | `McpServerPool`：连接复用、配置哈希、崩溃重连、`close()` |
| `src/infrastructure/workspace-mcp-config.ts` | 读取并校验用户级与 workspace 级 `mcp.json`，按名合并，`${VAR}` 展开，`cwd` 边界，诊断 |
| `src/tools/mcp-tool.ts` | `createMcpTool`：命名、schema 转换、输出映射、截断、错误码 |
| `src/tools.ts` | `Tool` 加 `looseInputSchema?: true`，`defineTool` 透传 |
| `src/providers/openai.ts` | `looseInputSchema` 的工具走 `strict: false` 的裸 JSON Schema |
| `src/protocol.ts`、`src/transcript.ts` | 两个新错误码 |
| `src/tool-permissions.ts` | `mcp__` 前缀默认 `confirm`；`createDefaultToolPermissionPolicy` 接入 |
| `src/system-prompt.ts` | `MCP_INSTRUCTIONS`，`hasMcpTools` 输入 |
| `src/application/conversation-run-service.ts` | `acquireMcpTools` 选项；MCP 工具进 `baseTools`；prompt 输入 |
| `src/server-bootstrap.ts` | 建 `McpServerPool`，组装 `acquireMcpTools`，退出时 `close()` |
| `src/index.ts` | CLI 同样读配置、`acquire`、退出前 `close()` |
| `web/src/components/RunTrace.tsx` | `mcp__` 摘要行与 content 渲染 |
| `test/support/fake-mcp-server.mjs` | stdio 假 Server：initialize、tools/list（分页）、tools/call，工具 `echo`、`fail`（isError）、`slow`、`image`、`crash` |
| `test/mcp-json-rpc.test.ts` | 分帧、超大消息、非法消息 |
| `test/mcp-stdio-transport.test.ts` | 起假 Server；环境白名单；stderr 缓冲；关闭顺序；进程中途退出 |
| `test/mcp-http-transport.test.ts` | 进程内 `http.createServer`：JSON 响应、SSE 响应、session id 回带、协议版本头、DELETE |
| `test/mcp-client.test.ts` | 版本协商失败；翻页；取消发 `notifications/cancelled`；入站请求回 -32601 |
| `test/mcp-server-pool.test.ts` | 复用；配置哈希变化重连；崩溃后 `MCP_SERVER_UNAVAILABLE` 再下一次 acquire 重连；单 Server 失败不影响其他 |
| `test/workspace-mcp-config.test.ts` | 合法配置；`${VAR}` 缺失；名字非法；`cwd` 逃逸；符号链接；超 64 KiB；用户级与 workspace 级合并、同名覆盖、单份非法不影响另一份 |
| `test/mcp-tool.test.ts` | 命名替换与超长跳过；schema 转换失败跳过；文本截断；图片省略；`isError` → `MCP_TOOL_ERROR`；工具数上限 |
| `test/tool-permissions.test.ts` | `mcp__x__y` 在沙箱 `confirm`、`full_access` `allow`、会话授权后 `allow` |
| `test/openai-provider.test.ts` | `looseInputSchema` 工具 `strict: false` 且 parameters 为原 JSON Schema |
| `test/system-prompt.test.ts` | 有/无 MCP 工具时段落出现与否 |
| `test/conversation-run-service.test.ts` | MCP 工具进父 Run 与子 Run 工具集；`acquireMcpTools` 抛错时 Run 仍能跑 |
| `web/src/components/RunTrace.test.tsx` | `mcp__` 摘要与 content 渲染 |
| `README.md` | 两级 `mcp.json` 配置说明、合并规则、命名、审批规则 |
| `docs/runtime-boundaries.md` | MCP Server 在宿主机进程外沙箱运行、无地址检查、凭据只经 `${VAR}`、超时表加两行 |
| `.env.example` | 注释说明 MCP 凭据变量的放法 |

## 保持不变

- `ToolRegistry`、`ToolExecutionContext`、`defineTool` 的调用方式；`Tool` 只加一个可选字段。
- `WorkspaceRuntime` 的结构与缓存；内建工具列表。
- `AgentEvent` 类型集合、SSE 事件顺序、`RunState`、`ToolTrace` 结构。
- 数据库全部表结构；MCP 连接状态不落库。
- `InteractionBroker`、审批与会话授权路径。
- Seatbelt profile；Bash 仍无网络。
- `web_fetch` 的地址检查。
- `PARALLEL_TOOL_NAMES`、`MAX_TOOL_OUTPUT_BYTES`、`MAX_CONCURRENT_TOOL_EXECUTIONS`。
- 运行时依赖仍是 `openai`、`yaml`、`zod`。

## 验收

1. `npm test` 全绿；`npm run check` 通过。
2. workspace 里放 `.agents/mcp.json` 配 `@modelcontextprotocol/server-filesystem`（stdio）
   指向 workspace，`workspace_sandbox` 会话发「用 MCP 的 filesystem 工具列出 src 目录」：模型调
   `mcp__filesystem__list_directory`，审批卡片显示 Server 与工具名；批准后 `RunTrace` 摘要行
   显示 `filesystem · list_directory`。再发同类请求选「本会话允许」，第三次不再审批。
3. 同一 workspace 切到 `full_access` 会话，同样的请求不审批直接执行。
4. 配置里再加一个 `command` 不存在的 Server：stderr 出现 `MCP_SERVER_UNAVAILABLE` 诊断，
   Run 照常完成，模型只看到 filesystem 的工具。
5. 配置一个 `${MISSING_VAR}`：该 Server 被跳过并有诊断；`diagnose:conversation --include-content`
   的任何输出里都不出现已配置的 token 明文。
6. 用进程内 Streamable HTTP 假 Server（或任一公开的 HTTP MCP Server），`http` 类型配置能连上、
   拉到工具、调用成功；服务进程 `SIGINT` 退出时 stdio 子进程全部结束，`ps` 里没有残留。
7. 发一个让 Server 返回 `isError: true` 的请求：工具结果是 `MCP_TOOL_ERROR` 且带 Server 的
   错误文本，模型据此调整而不是重复同样的调用。
8. 让 `agent` 委托一个需要 MCP 工具的子任务：子 Run 能调同一批 MCP 工具，其审批经父 Run 的
   SSE 流到达前端。

## 后续项

- **workspace 级 Server 的信任确认。** 打开一个陌生仓库时，它的 `.agents/mcp.json` 会让
  宿主机起进程。Claude Code 对项目级 Server 首次使用要弹一次确认。可选做法：workspace 级
  新 Server 首次连接前走一次 Interaction 确认并记入会话授权；或先只在 `full_access` 会话
  启用 workspace 级配置。本轮不做。
- 审查报出、尚未处理的非阻塞问题：跨 Server 总数上限未实现、截断字节数多算、
  `MCP_TOOL_ERROR` 消息不限长、`SIGKILL` 不发进程组。（stdout 整行超大、SSE 丢弃入站
  请求、`cwd` 不做 `realpath` 已在 MR 20 评审后修掉。）
- 管理接口读取配置时不展开 `${VAR}`（否则明文会经前端保存回文件），只有探测和运行时
  读取才展开。

## 方案外的一个观察

OpenAI provider 用 `zodResponsesFunction` 的 `strict: true`，而现有 `read`、`glob`、`web_fetch`
的 `.optional()` 字段按 OpenAI 的规则在 strict 模式下应被拒绝。DeepSeek 路径不受影响。值得单独
验证，不在本方案范围。
