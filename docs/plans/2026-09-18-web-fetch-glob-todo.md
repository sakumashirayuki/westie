# 三个基础工具：`web_fetch`、`glob`、`todo`

> 讨论稿。定稿前不动 `src/`、`web/`、`test/`。

现在的工具集有一个明显的洞：`web_search` 只回 Tavily 的摘要片段，模型拿到 URL 之后读不到正文。
`workspace_sandbox` 下 Bash 的 Seatbelt 策略是 `(deny default)` 且没有放开 `network-outbound`，
`curl` 直接被拒；`full_access` 下模型会绕去 `curl`，拿回几万字符的原始 HTML 自己在里面找正文，
又贵又不稳。另外两个洞小一些：找文件只能靠 `grep` 或 Bash 里的 `rg --files`，与 `read`、`grep`
有路径边界而找文件要走审批的格局不一致；长任务里模型没有地方显式维护计划，前端也无法展示
「模型自己认为接下来要做什么」。

本方案加三个内建工具。`web_fetch` 在 Harness 主进程抓取一个 URL，把 HTML 转成可读文本，
按行分页返回，两种执行模式下都免审批，`workspace_sandbox` 下拒绝私网和回环地址。`glob` 用
`rg --files --glob` 按名字找文件，复用 `grep` 的沙箱执行、路径边界和敏感文件过滤，按修改时间
倒序返回。`todo` 是一个无副作用的清单工具，模型每次提交整份清单，Harness 只做校验和回显，
清单本身留在 transcript 里，Web 端从最近一次 `todo` 结果渲染任务卡片。三个工具都不改数据库。

## 当前实现

### 工具的形状

`defineTool`（`src/tools.ts`）接收 `name`、`description`、`impact`、`inputSchema`（zod
strictObject）、可选的 `maxOutputBytes`、`summarizeInput`、`preflight` 和 `execute`。
`ToolRegistry.prepare` 校验输入；`execute` 之后把输出序列化，超过 `maxOutputBytes ?? 64 KiB`
返回 `TOOL_OUTPUT_TOO_LARGE`。工具内抛 `ToolExecutionError(code, message)` 会被映射成
错误 ToolResult，`code` 必须在 `ToolErrorCode`（`src/protocol.ts`）和
`toolErrorCodeSchema`（`src/transcript.ts`）两处登记。

所有 ToolResult 经 `serializeToolResultForModel`（`src/providers/tool-result-boundary.ts`）
包成 `untrusted_tool_result` 交给模型，system prompt 明确说明普通工具结果是数据不是指令。
新工具不需要为注入防护做任何额外事情。

### 路径边界与沙箱执行

`createWorkspacePathResolver`（`src/tools/path.ts`）按 `executionMode` 给出两套解析器：
`workspace_sandbox` 下 `resolveExisting` 拒绝 workspace 外路径、外指符号链接和敏感文件；
`full_access` 下任意路径都可以。`grep`（`src/tools/grep.ts`）用它解析 `path` 参数，然后
通过 `SandboxRunner.run({ executable: "rg", ... })` 在沙箱里跑 ripgrep，`--json` 输出在主进程
解析，匹配行经 `isSensitiveWorkspacePath` 二次过滤，结果超 400 条时保留首尾各 200 条并插入
一个带原命令的省略标记。

### 网络访问

`web_search`（`src/tools/web-search.ts`）是目前唯一走网络的工具。它在主进程用 `fetch` 调
Tavily，`options.fetch` 可注入以便测试，30 秒超时经 `AbortSignal.any` 与 `context.signal`
合并。`defaultToolPermissionRules.web_search` 是 `allow`。Bash 的沙箱 profile
（`src/sandbox/macos-seatbelt-sandbox-runner.ts:314`）没有 `network-outbound` 规则。

### 并行与权限

`PARALLEL_TOOL_NAMES = ["read", "grep", "agent"]`（`src/protocol.ts:31`）决定哪些工具在
一批内并行执行，system prompt 的 `HARNESS_LOOP_INSTRUCTIONS` 从这个常量生成「批量发起」
的指引。`defaultToolPermissionRules`（`src/tool-permissions.ts:476`）按工具名给出
`allow` / `confirm`，没有规则的工具默认 `deny`。

### 装配

`createDefaultWorkspaceRuntime`（`src/runtime.ts`）构造七个工具，CLI 与 Web 共用；Web 再由
`ConversationRunService.#runEvents` 追加 `skill` 与 `agent`，`agent` 的子 Run 工具集是
`baseTools`，所以 runtime 里的新工具会自动进入子 Run。

### Web 轨迹

`RunTrace`（`web/src/components/RunTrace.tsx`）按 step 渲染 `ToolTrace`，工具名、参数、
结果放在一个 `<details>` 里；只有 `agent` 有特殊的摘要行和抽屉。`ToolTrace.result` 是原样
的 `JsonValue`。

## 存在的问题

1. **搜到却读不到。** 用户贴一个 URL，或者搜索结果里出现一篇明显相关的文档，模型在
   `workspace_sandbox` 下没有任何途径读它的正文；`full_access` 下能用 `curl`，但每次要审批，
   原始 HTML 里标签和脚本占了大半，几万字符进上下文后还要模型自己去找正文。
2. **找文件走错了层。** `read`、`grep` 在工具层实现了路径边界和敏感文件过滤，找文件却要走
   Bash：`workspace_sandbox` 下每次审批，输出是非结构化文本，敏感文件名也会原样列出。
   `bash` 的描述还在建议「Use rg to search file names or contents」。
3. **长任务没有计划的落点。** 步数多的任务里模型容易做完第三步忘了第五步；转向消息进来后
   也没有一个地方能看出模型有没有把新要求纳入计划。前端的 RunTrace 能看到已经做了什么，
   看不到接下来要做什么。

## 目标实现

### 一、`web_fetch`

```ts
inputSchema: z.strictObject({
  url: z.string().url(),
  offset: z.int().positive().optional(),   // 转换后文本的 1-based 行号
  limit: z.int().positive().max(1_000).optional(),
})
```

输出与 `read` 同构，模型不用学第二套分页：

```ts
{
  url: string,          // 请求的 URL
  finalUrl: string,     // 重定向后的 URL
  status: number,
  contentType: string,
  title?: string,       // <title>，仅 HTML
  content: string,
  startLine: number,
  endLine: number,
  totalLines: number,
}
```

**抓取。** 在 Harness 主进程用 `fetch`，`redirect: "manual"` 自己跟随重定向，最多
`MAX_REDIRECTS = 5` 跳，每一跳都重新过一遍地址检查。固定 `User-Agent`，不带 Cookie、不带
任何凭据；URL 含 userinfo（`https://user:pass@host`）直接拒绝。`Accept` 声明 HTML、纯文本、
JSON、XML。响应体按流读取，超过 `MAX_FETCH_BODY_BYTES = 2 MiB` 中止并报错。整个调用
30 秒超时，与 `context.signal` 合并，写法同 `web_search`。

**地址检查。** 只允许 `http:` 和 `https:`。`workspace_sandbox` 下，对主机名做 `dns.lookup`
（`all: true`），任一地址落在回环、私网（RFC 1918）、链路本地（169.254/16、fe80::/10）、
IPv6 ULA（fc00::/7）、未指定地址或 `::ffff:` 映射的上述 IPv4 段，都拒绝；`localhost` 及其
子域名、`.local` 后缀直接拒绝。`full_access` 下不做地址检查，与该模式下 Bash 可访问任意网络
的边界一致。已知缺口：检查用的解析结果与 `fetch` 实际连接用的解析结果是两次查询，存在
DNS rebinding 窗口。Node 内建的 `fetch` 不暴露连接钩子，堵这个口需要引入 `undici` 依赖，
本方案不做，在 `docs/runtime-boundaries.md` 里注明，性质与资源配额的采样间隔缺口相同。

**内容转换。** 按 `Content-Type`：

- `text/html`、`application/xhtml+xml`：转成可读文本。不引入依赖，写一个 300 行以内的
  转换器（`src/tools/html-to-text.ts`）：删掉 `script`、`style`、`noscript`、`template`、
  `svg`、`head` 内除 `title` 的内容；`h1`–`h6` 转成 `#` 前缀行；`p`、`div`、`section`、
  `article`、`br`、`hr`、`tr` 等块级标签产生换行；`li` 前加 `- `；`a[href]` 输出为
  `文本 (绝对 URL)`，相对链接按 `finalUrl` 补全，这样模型能顺着链接再 fetch；`pre` 内保留
  原始空白；其余空白折叠；解码常见 HTML 实体。目标是够用的 Markdown 味道文本，不是标准
  Markdown。
- `text/*`、`application/json`、`application/xml`、`application/*+json`、`application/*+xml`：
  按 UTF-8 解码原样返回（非 UTF-8 报 `FETCH_UNSUPPORTED_CONTENT`）。
- 其他类型（PDF、图片、二进制）：报 `FETCH_UNSUPPORTED_CONTENT`，消息里带上实际的
  `Content-Type`。PDF 是有真实需求的类型，但要引入解析依赖，留给后续。

**分页。** 转换后文本按行切分，`offset` / `limit` 语义同 `read`。`limit` 缺省时取尽可能多的
行，直到 `content` 达到 `MAX_FETCH_TEXT_BYTES = 48 KiB`；被截断时 `endLine < totalLines`，
模型按 system prompt 里已有的截断指引用 `offset` 续读。`maxOutputBytes` 设为 96 KiB，
理由同 `read`（JSON 转义膨胀）。

**错误码。** 新增三个：`FETCH_FAILED`（网络错误、超时、HTTP 4xx/5xx、重定向过多、响应体
超限）、`FETCH_BLOCKED_ADDRESS`（地址检查拒绝）、`FETCH_UNSUPPORTED_CONTENT`。HTTP 非 2xx
不抛 TOOL_EXECUTION_FAILED 而是 `FETCH_FAILED` 并带状态码，模型能据此换 URL 而不是重试。

**权限与并行。** `defaultToolPermissionRules.web_fetch = allow`，理由同 `web_search`：只读，
不带凭据，不写本机。加入 `PARALLEL_TOOL_NAMES`，模型可以一批取多页。

**注册。** `createDefaultWorkspaceRuntime` 里加 `createWebFetchTool({ executionMode })`，
不需要 API Key，CLI 与 Web 都有，子 Run 自动获得。

**说明与 impact。** `description`：「Fetch a public http(s) URL and return its readable text.
HTML is converted to text with headings, lists and links preserved; offset/limit page through
long pages like read.」`impact` 按模式区分：`workspace_sandbox` 下注明「public addresses only」。

### 二、`glob`

```ts
inputSchema: z.strictObject({
  pattern: z.string().min(1),            // gitignore 风格 glob，如 "**/*.test.ts"
  path: z.string().min(1).optional(),    // 搜索根，默认 workspace root
})
```

输出：

```ts
{
  paths: string[],       // workspace 相对路径，修改时间倒序
  omitted?: string,      // 超限时的说明，含原参数
}
```

**实现。** 与 `grep` 同构：`createGlobTool(workspaceRoot, sandboxRunner, executionMode)`，
`path` 经 `paths.resolveExisting` 解析，然后在沙箱里跑
`rg --no-config --files --glob <pattern> --glob '!.git' -- <searchPath>`。ripgrep 默认跳过
`.gitignore` 命中和隐藏文件，与模型「找源码」的预期一致；需要看隐藏文件时模型会用 Bash，
这里不加开关。`--files` 的输出每行一个路径，主进程解析后经 `isSensitiveWorkspacePath`
过滤，再对每个路径 `stat` 取 `mtimeMs`，倒序排序。`rg` 退出码 1 表示无匹配，返回空数组。

**上限。** `rg` 输出上限 `MAX_GLOB_OUTPUT_BYTES = 256 KiB`（约 3000 条路径）；排序后最多返回
`MAX_GLOB_RESULTS = 500` 条，其余以 `omitted` 说明条数并建议收窄 `pattern` 或 `path`。
`stat` 全量做是为了排序正确；3000 次 `stat` 在本机是毫秒级，不做优化。

**权限与并行。** `allow`；加入 `PARALLEL_TOOL_NAMES`。

**连带修改。** `bash` 两个模式的 `description` 去掉「Use rg to search file names or contents」，
改为「Prefer glob and grep for finding files and searching contents」。`grep` 的 `description`
不动。

### 三、`todo`

```ts
const todoItemSchema = z.strictObject({
  content: z.string().trim().min(1).max(200),
  status: z.enum(["pending", "in_progress", "completed"]),
});
inputSchema: z.strictObject({
  items: z.array(todoItemSchema).max(50),
})
```

输出回显整份清单加一行计数：

```ts
{ items: TodoItem[], counts: { pending: number, in_progress: number, completed: number } }
```

**语义。** 每次调用提交完整清单，替换而不是增量更新；模型想改一项就重发整份。这是 Claude
Code、Gemini CLI、OpenCode 三家共同的选择，好处是工具无状态、不需要 id、不会有「更新一个
不存在的 id」这类错误路径。校验：最多一项 `in_progress`（超过报 `INVALID_TOOL_INPUT`，
消息说明原因）；`content` 不允许空白。

**Harness 不存清单。** 清单在 transcript 的 `todo` 调用对里，模型下一步自然能看到；Turn 之间
也在历史里。压缩（`ContextCompactor`）时清单可能被摘要掉，这和其他工具结果一样处理，本方案
不给 todo 特权；实际用起来如果发现压缩后模型丢计划，再考虑在摘要请求里要求保留最新清单。

**System prompt 新段落 `TODO_INSTRUCTIONS`**，放在 `TOOL_RESULT_TRUNCATION_INSTRUCTIONS`
之后：

> Planning with todo: for a task that needs three or more distinct steps, or when the user
> lists several things to do, write the plan with todo before starting and keep it current.
> Send the whole list each time. Mark a step in_progress when you start it and completed as
> soon as it is done; keep at most one step in_progress. When a steering message changes the
> task, update the list before continuing. Skip todo for a task you can finish in one or two
> steps.

CLI 与 Web 都注册，子 Run 也有（子 Run 的清单在它自己的 transcript 里，随子 Run 丢弃）。

**权限。** `allow`。不加入 `PARALLEL_TOOL_NAMES`，它瞬时完成，串行没有成本。

### 四、Web：任务清单卡片

`RunTrace` 里 `todo` 的工具卡片不再显示原始 JSON，而是渲染成勾选列表：`completed` 划线，
`in_progress` 高亮并带「进行中」标签，`pending` 常规。另外在 Turn 顶部（`ConversationTurn`）
固定显示该 Turn 内最近一次成功 `todo` 结果的清单，标题「任务清单 · 2/5」，Run 进行中随
SSE 事件更新，Run 结束后保留。数据来源就是已有的 `ToolTrace.result`，从 `steps` 里倒序找
第一个 `name === "todo" && status === "success"` 的工具即可，不加新事件、不改 `RunState`
结构。

`web_fetch` 卡片的 summary 行显示 `finalUrl` 和 `title`；`glob` 卡片显示 `pattern` 与命中
条数。两者都是 `RunTrace` 里几行分支，与 `agent` 的摘要行同一位置。

### 五、System prompt 的连带变化

`HARNESS_LOOP_INSTRUCTIONS` 从 `PARALLEL_TOOL_NAMES` 生成，自动变成
「Batch independent read and grep and agent and web_fetch and glob calls」，改成用逗号连接
最后一个用 and。新增 `TODO_INSTRUCTIONS` 段落。`AUTONOMY_INSTRUCTIONS` 里已有
「reading files, searching, fetching references never needs approval」，与 `web_fetch` 免审批
一致，不动。

## 具体改动

| 文件 | 改动 |
|-|-|
| `src/protocol.ts` | `PARALLEL_TOOL_NAMES` 加 `"web_fetch"`、`"glob"`；`ToolErrorCode` 加 `FETCH_FAILED`、`FETCH_BLOCKED_ADDRESS`、`FETCH_UNSUPPORTED_CONTENT` |
| `src/transcript.ts` | `toolErrorCodeSchema` 加同三个码 |
| `src/tools/web-fetch.ts` | 新增 `createWebFetchTool({ executionMode, fetch?, lookup?, timeoutMs? })`；重定向跟随、地址检查、响应体限流、分页 |
| `src/tools/html-to-text.ts` | 新增 HTML 到文本转换器，纯函数 |
| `src/security/network-address-policy.ts` | 新增 `isBlockedAddress(ip)`、`isBlockedHostname(host)`，与 `sensitive-path-policy.ts` 并列 |
| `src/tools/glob.ts` | 新增 `createGlobTool(workspaceRoot, sandboxRunner, executionMode)` |
| `src/tools/todo.ts` | 新增 `todoTool`（无构造参数，与 `getCurrentTimeTool` 同形） |
| `src/tools/bash.ts` | 两个 `description` 改为推荐 `glob` / `grep` |
| `src/tool-permissions.ts` | `defaultToolPermissionRules` 加 `web_fetch`、`glob`、`todo` 三条 `allow` |
| `src/runtime.ts` | 注册三个工具；`glob` 与 `grep` 共用 `sandboxRunner` |
| `src/system-prompt.ts` | `TODO_INSTRUCTIONS` 段落；并行工具列表的连接词 |
| `web/src/components/RunTrace.tsx` | `todo` 勾选列表、`web_fetch` / `glob` 摘要行 |
| `web/src/components/ConversationTurn.tsx`、新增 `components/TodoList.tsx` | Turn 顶部任务清单卡片 |
| `test/web-fetch-tool.test.ts` | 注入 `fetch` 与 `lookup`：HTML 转换与分页；重定向每跳检查；私网、回环、`localhost`、userinfo 拒绝且 `full_access` 放行；非 2xx 为 `FETCH_FAILED`；响应体超 2 MiB 中止；PDF 报 `FETCH_UNSUPPORTED_CONTENT`；超时与取消传播 |
| `test/html-to-text.test.ts` | 标题、列表、链接补全、`pre` 保留、脚本样式剔除、实体解码 |
| `test/network-address-policy.test.ts` | 各地址段与 `::ffff:` 映射 |
| `test/glob-tool.test.ts` | 用 `HostSandboxRunner`：匹配与 mtime 倒序；`.gitignore` 与隐藏文件跳过；敏感文件过滤；workspace 逃逸拒绝；超 500 条的 `omitted`；`full_access` 下绝对路径 |
| `test/todo-tool.test.ts` | 回显与计数；两项 `in_progress` 拒绝；空 `content` 拒绝；51 项拒绝 |
| `test/tool-permissions.test.ts` | 三条规则为 `allow` |
| `test/system-prompt.test.ts` | `TODO_INSTRUCTIONS` 存在；并行工具列表文案 |
| `test/runtime.test.ts` | 默认工具列表含三个新名字 |
| `web/src/components/RunTrace.test.tsx`、新增 `TodoList.test.tsx` | 勾选列表渲染；Turn 顶部取最近一次成功结果 |
| `README.md` | 默认工具列表加三项；`web_fetch` 的网络边界一段 |
| `docs/runtime-boundaries.md` | `web_fetch` 主进程抓取、地址检查、DNS rebinding 缺口 |

## 保持不变

- `Tool`、`ToolExecutionContext`、`defineTool`、`ToolRegistry` 的接口。
- `MAX_TOOL_OUTPUT_BYTES = 64 KiB`、`MAX_CONCURRENT_TOOL_EXECUTIONS = 5`。
- 数据库全部表结构；`todo` 不落库。
- `AgentEvent` 类型集合与 SSE 事件顺序；`RunState`、`ToolTrace` 的结构。
- `InteractionBroker`、审批与授权路径；三个工具都不产生交互。
- Seatbelt profile；`web_fetch` 不在沙箱内执行，Bash 仍无网络。
- `web_search` 的参数与行为。
- Tavily、模型 API Key 仍只在主进程；`web_fetch` 的请求不携带任何本机凭据。

## 验收

1. `npm test` 全绿。
2. `workspace_sandbox` 会话中发「读一下 https://nodejs.org/api/sqlite.html 里 `DatabaseSync`
   的构造参数」：模型一次 `web_fetch` 拿到正文，必要时用 `offset` 续读，回答引用页面原文；
   全程没有 Bash 审批。
3. 同一会话发「抓 http://127.0.0.1:3000/」：`web_fetch` 返回 `FETCH_BLOCKED_ADDRESS`，模型
   如实报告而不是换 Bash 绕。`full_access` 会话中同一请求正常返回。
4. 发「找到所有还没迁移到 zod v4 的测试文件」：模型用 `glob` 定位 `test/**/*.test.ts`，再用
   `grep` 过滤，两批调用各自并行；`.git/` 和 `node_modules/` 下的文件不出现在结果里；
   workspace 内如果有 `id_rsa` 之类的敏感文件，`glob '**/*'` 的结果里也没有它。
5. 发一个五步以上的任务：第一步之内出现 `todo` 调用；Web 端 Turn 顶部出现任务清单，随进度
   由 pending 变 in_progress 变 completed；中途发一条转向消息，下一次 `todo` 里出现新条目。
6. `diagnose:conversation --include-content` 里 `web_fetch` 的结果是转换后文本，没有
   `<script>` 和 `<style>` 内容；单次结果不超过 96 KiB。
