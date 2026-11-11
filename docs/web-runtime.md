# Web 服务与会话

## 流式 HTTP 服务

同一个 Node.js 进程也可以通过 POST SSE 把 Agent 事件逐段推给浏览器：

```bash
npm run build
npm run start:server
```

先创建 Conversation，再用 `curl -N` 关闭客户端缓冲并观察事件到达顺序。产品 Web 使用宿主目录选择器创建会话，浏览器不提交本机路径：

```bash
curl -X POST \
  -H 'Content-Type: application/json' \
  -d '{"action":"inspect"}' \
  http://127.0.0.1:3000/v1/agent/conversations:select-workspace

# 使用上一步返回的 selectionToken 创建会话
curl -X POST \
  -H 'Content-Type: application/json' \
  -d '{"selectionToken":"<selectionToken>","workspace":{"kind":"selected_directory"},"executionMode":"workspace_sandbox"}' \
  http://127.0.0.1:3000/v1/agent/conversations:open

curl -N \
  -H 'Content-Type: application/json' \
  -d '{"input":"先介绍一下这个项目"}' \
  http://127.0.0.1:3000/v1/agent/conversations/<conversationId>/runs:stream
```

系统目录选择器完成后，服务先执行 `realpath`、目录校验并返回短期 `selectionToken`；前端再调用 `conversations:open`，服务校验令牌、预热对应模式 Runtime 后创建 Conversation。每个 Conversation 保存不可变的 workspace 与 `executionMode`；`read/write/edit`、Bash cwd、权限审计和 Seatbelt profile 都从这一来源装配。同一 canonical path 的两种模式使用不同 Runtime。旧的 `POST /v1/agent/conversations` 已删除。

`Conversation`、`Turn`、`Run`、每个 Run 实际使用的 system prompt、完整 canonical transcript、已采用的上下文压缩记录、历史 Run 摘要和子 Run 的记录持久化到本地 SQLite，默认文件为 `.data/agent-harness.sqlite`。压缩记录只描述 Provider 输入投影及其覆盖终点，不替换或删除 canonical transcript。启动时先初始化当前 schema，再把上次进程中断留下的 running Run/Turn 标记为 failed，完成后才监听 HTTP。同一 Conversation 同时只允许一个活跃 Run；并发请求会在建立 SSE 前收到 HTTP 409。失败或取消的 Turn 仍可查询，其部分 transcript 仅供本地诊断，不会被发给模型。

## 会话诊断

遇到会话失败或行为异常时，可复制 Web 运行台中的 Conversation ID，在项目目录执行只读诊断：

```bash
npm run diagnose:conversation -- <conversation-id>
```

命令从 `.env` 读取 `AGENT_DATABASE_PATH`（未设置时使用 `.data/agent-harness.sqlite`），服务初始化数据库后不需要保持运行。默认 JSON 只包含会话、Turn、Run、system prompt 字节数、错误摘要、transcript 结构和压缩摘要的覆盖终点、字节数及生成时间，不包含 workspace canonical path、system prompt 正文、消息正文、工具参数、工具结果或摘要正文，适合先交给其他 AI 或工具分析。每个 Run 还带一个 `historySummary` 字段（没有跨 Run 历史摘要时为 `null`），只显示字节数与生成时间。若要把纯 JSON 重定向到文件，可给 npm 加 `--silent`：`npm run --silent diagnose:conversation -- <conversation-id> > diagnostic.json`。

需要分析完整上下文时显式启用内容导出：

```bash
npm run diagnose:conversation -- <conversation-id> --include-content
```

完整导出包含本机路径、system prompt、用户与模型消息、工具参数/结果、上下文摘要及内部错误，命令会在 stderr 提示敏感信息风险。分享前应自行检查和脱敏。诊断命令以 SQLite 只读模式打开数据库，也不会创建不存在的数据库文件。

当前持久化实现面向单机单进程，使用一个同步 SQLite 连接和 WAL。表结构变更通过 `PRAGMA user_version` 前向迁移，启动时自动把存量库升级到当前版本，不删除数据库文件；版本机制与各版本变更见 [数据结构与迁移](./data-storage.md)。单个 Run 的 transcript 存储上限为 16 MiB，每条上下文摘要上限为 16 KiB，两者都与模型上下文大小无关。数据库以明文保存 system prompt、用户输入、模型输出、工具结果、上下文摘要和内部错误摘要，备份或共享前应按敏感数据处理。

Web 运行台通过左侧历史列表打开已有会话，并使用 `/conversations/:conversationId` 作为可刷新、可前进后退的 SPA 路由。列表按最近活动时间排序，每次加载 50 条，可通过“加载更多”继续读取。刷新后恢复用户消息、最终回答和终态；SSE 事件、工具轨迹与待处理审批仍不持久化。

历史列表可以永久删除会话。删除会物理清除该 Conversation 及其 Turn、Run、transcript 和上下文压缩记录；运行中的会话必须先结束当前 Run，服务端会以 HTTP 409 拒绝删除。删除当前会话后，Web 运行台回到未选择项目的首页状态。

浏览器端使用 `fetch()` 发送 POST，再从 `response.body` 的 `ReadableStream` 读取 SSE 帧。前端跨域运行时，在 `.env` 中把 `CORS_ALLOW_ORIGIN` 设置为前端的精确 Origin，例如 `http://localhost:5173`。

父子 Run 共用一条 SSE 订阅。每条记录是 `{ streamSeq, event, subAgent? }`：event 保留所属 Run 的原始 runId 和 seq，子事件通过 subAgent 的 toolCallId、parentStep 关联父工具调用。streamSeq 由事件日志统一分配，用于 SSE ID、回放和重连；快照记录为 `{ streamSeq, snapshot }`。agent 工具启动后立即返回，子事件和审批在后台执行期间持续推送。子 Run 结束时它的 transcript、system prompt 与终态按自己的 `runId` 写入 `sub_agent_runs` 与 `sub_agent_transcript_messages`，会话主线 `transcript_messages` 只含父 Run 的消息；子 Run 的模型调用以 `kind = 'sub_agent'` 记入父 Run 的 `run_model_calls`，并用 `sub_agent_run_id` 指向该子 Run。`diagnose:conversation` 在每个 Run 下列出 `subAgentRuns`。

需要用户确认的 Tool 会先发送 `interaction.required(kind=tool_approval)`。浏览器通过 `POST /v1/agent/interactions/{interactionId}:respond` 提交一次性的 `approve` 或 `deny`。项目外文件读取使用独立的 `kind=workspace_grant`；浏览器只调用 `POST /v1/agent/interactions/{interactionId}:select-file` 触发宿主机系统选择器，不提交文件路径，仍可通过 `:respond` 明确拒绝。两类交互都以后续 `interaction.resolved` SSE 事件作为最终状态。只有批准后才会发送 `tool.started` 并执行工具；拒绝或超时会产生受控 ToolResult，Agent 可以继续下一步。

默认 HTTP 入口会把策略决策、Interaction 创建/终态和执行结果输出为 JSON Lines 审计日志。日志只包含 ID、工具名、规则、参数摘要哈希和结果，不记录原始工具参数。

## React Web 运行台

项目包含一个 React + TypeScript + Vite 的单页运行台。生产构建后由同一个 Node 服务托管：

```bash
npm run build
npm run start:server
```

然后打开 `http://127.0.0.1:3000`。页面可以在同一个持久化会话中连续发送消息、停止当前运行，并为每个 Turn 独立保留回答和运行轨迹。Provider 的正文流直接映射为 `answer.delta`，完成后由 `answer.completed` 携带完整答案覆盖校准。工具参数增量仅在 Provider 内部消费与校验，不作为公开事件发送。

开发前端时，先启动已经构建的 Node 服务，再在另一个终端启动 Vite：

```bash
# 终端 1
npm run build:server
npm run start:server

# 终端 2
npm run dev:web
```

Vite 会把 `/v1` 代理到 `http://127.0.0.1:3000`，因此默认不需要配置 CORS。`CORS_ALLOW_ORIGIN` 仅用于前端确实运行在其他 Origin 且不经过开发代理的场景。
