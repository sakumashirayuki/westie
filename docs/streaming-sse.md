# 流式 SSE 协议

## 传输边界

服务只提供持久化会话 Run。调用方必须先创建 Conversation，再通过以下接口发起 Run：

- `GET /v1/agent/conversations`：按最近活动时间分页读取轻量 Conversation Summary；使用 opaque cursor 和“加载更多”，不返回 Turns、Runs 或 transcript。
- `POST /v1/agent/conversations:select-workspace`：请求体为 `{ "action": "inspect" }`；宿主机打开系统目录选择器，识别目录并返回短期选择令牌，不创建 Conversation。
- `POST /v1/agent/conversations:open`：使用选择令牌或已登记的项目 key，校验工作目录和执行模式，预热对应的 WorkspaceRuntime 并创建 Conversation。
- `GET /v1/agent/conversations/:conversationId`：读取公开的 Turn/Run 状态与最终回答。
- `DELETE /v1/agent/conversations/:conversationId`：物理删除 Conversation，并通过现有外键级联删除 Turn、Run 和 transcript；存在活跃 Run 时返回 HTTP 409，不会自动取消 Run。
- `POST /v1/agent/conversations/:conversationId/runs:stream`：在 Conversation 中创建新 Turn 和 Run，并流式返回事件。
- `POST /v1/agent/interactions/:interactionId:respond`：提交当前 pending Interaction 的强类型响应。
- `POST /v1/agent/interactions/:interactionId:select-file`：让宿主机为 `workspace_grant` 打开系统文件选择器；请求体不包含路径。

Run 请求体包含非空 `input`，并可选传入正整数 `maxSteps`、`maxHistorySteps`、`maxConversationTurns`。响应为 `text/event-stream`；浏览器使用 `fetch()` 与 `ReadableStream` 消费，因为原生 `EventSource` 不能直接发送 POST 请求体。

`runId` 对应领域模型中的 Run，带 `step` 的事件对应该 Run 内的一次 Provider 推理；SSE `seq` 只是 Run 内严格递增的传输序号，因此事件协议不需要增加 `conversationId` 或 `turnId`。客户端在发请求前先创建本地 Turn，并把该响应流的全部事件路由到这个 Turn。

Conversation 创建、列表与详情响应都包含必填且不可变的 `executionMode`，以及 `workspace.name` 和 `workspace.canonicalPath`。路径来自宿主选择器和服务端 `realpath`，不能由浏览器或 Run body 指定；`beginRun` 从 Conversation 快照中取得 root 与 mode，并用对应 WorkspaceRuntime 执行。

每个 SSE frame 同时包含：

- `id: <runId>:<seq>`，供日志定位和顺序检查；当前服务不提供断线续传。
- `event: <type>`，便于客户端按类型分派。
- `data: <AgentEvent JSON>`，包含完整事件 envelope。

## 事件与顺序

正常的单轮回答顺序是：

```text
run.started
step.started
answer.delta × N
step.completed
answer.completed
run.completed
```

允许直接执行的工具轮在 Provider 完成工具决策后产生 `step.completed`，随后产生 `tool.started` 和 `tool.completed`，然后进入下一个 `step.started`。一个批次可包含 1–4 个调用；纯 `read`/`grep` 批次并行执行，多个 `tool.completed` 按真实完成顺序到达。前端继续按 `toolCallId` 更新同一步中的工具卡片，无需新增事件类型。需要确认的工具轮顺序为：

```text
step.completed
interaction.required
interaction.resolved
tool.started       # 仅 approve
tool.completed
```

`agent` 工具在执行期间把子 Run 的事件原样包进 `subagent.event` 转发：

```text
tool.started        # agent
subagent.event × N  # data.toolCallId 指向该 agent 调用，data.event 是子 Run 的原始事件
tool.completed      # agent
```

外层 `runId`、`seq`、`step` 属于父 Run，`seq` 继续在父 Run 内严格递增；内层事件完整保留子 Run 自己的 `runId` 与 `seq`，包括它的 `interaction.required` / `interaction.resolved`。同一 `toolCallId` 的 `subagent.event` 按子 Run 产生顺序到达，全部位于该调用的 `tool.started` 之后、`tool.completed` 之前；并行子 Run 之间按真实发生顺序交错，客户端按 `data.toolCallId` 路由。子 Run 里的审批用内层 `interactionId` 调同一个 `:respond` 接口。`GET /v1/agent/conversations/:conversationId` 的每个 Run 带 `subAgentRuns`，供刷新后恢复子 Run 的状态、回答与用量。

`interaction.required` 和 `interaction.resolved` 使用相同的 `interactionId`、`runId` 与 `kind`。当前实现包含 `kind=tool_approval` 和 `kind=workspace_grant`。后者只用于会话 Run 的项目外单文件读取：宿主机选择器必须返回 interaction 绑定的 canonical path，授权绑定当前 conversation 和 tool call，执行时消费一次。取消选择或选择不匹配会保持 interaction pending；直接向 `:respond` 提交 approve 会被拒绝。Deny 或 Timeout 不产生 `tool.started`，而是直接产生对应的失败 `tool.completed`，写入 transcript 后继续下一次模型推理。

`seq` 从 1 开始，在整个 Run 内对每个事件递增；`step` 从 1 开始，标识 Agent 推理轮次。Run 级事件 `run.started`、`run.completed` 没有 `step`，`run.error` 仅在能归属到具体轮次时携带 `step`。

`answer.delta.data.text` 是 Provider 原生正文增量，服务端无需再从 JSON 字符流投影答案。客户端按 `step` 同时保存这些增量并作为当前输出预览；如果随后的 `step.completed` 表明该轮是工具调用，主消息区会把正文标记为“工具调用说明”，对应工具步骤也保留同一段说明。下一个 step 等待首个正文增量期间继续显示上一轮工具说明；首个增量到达后原子替换主消息内容并开始新的输出预览。最终回答步骤继续逐段显示，并在 `answer.completed` 到达后切换为“最终回答”，使用完整答案覆盖校准。如果 Provider 随后暴露混合输出或响应未正常完成，本轮仍会失败，已展示文本不能视为成功回答。

会话 Run 在发出 `answer.completed` 后提交 Turn、Run、最终回答和该轮完整 transcript；只有提交成功才会继续发送 `run.completed`。后续 Turn 只读取已完成 Turn，失败或取消的 Turn 不进入模型上下文。同一 Conversation 只允许一个活跃 Run，冲突请求在 SSE headers 写出前返回 HTTP 409。

模型调用遇到限流、服务端 5xx、连接中断、流 idle 超时这类瞬时故障时，Provider 层会自动重试，并在同一 step 内发出 `model.retrying`：

```text
answer.delta × N     # 失败尝试已流出的部分输出
model.retrying       # data: { attempt, maxAttempts, delayMs, reason }
answer.delta × M     # 下一次尝试从头输出
step.completed
```

`model.retrying` 的语义是**本 step 在它之前流出的 `answer.delta` 全部作废**。客户端要清空该 step 的文本；如果主消息区正在显示的就是这一步的流式输出，也一并清空。`attempt` 是即将开始的第几次尝试（≥ 2），`delayMs` 是开始下一次尝试前的等待时间，`reason` 取值为 `rate_limited`、`server_error`、`overloaded`、`timeout`、`connection`。transcript、用量记账和工具执行都只在收到完整的 Provider 结果后才发生，所以失败的尝试除了显示之外没有其他副作用。重试用尽，或服务端要求等待的时间超过上限时，Run 以 `run.error`（`code: "MODEL_UNAVAILABLE"`）结束。这个事件不受 `model.delta` 开关控制，总是发出；子 Run 的重试同样经 `subagent.event` 转发。

`model.delta` 保留为核心层的可选原始观测事件，`channel` 为 `output_text` 或 `tool_arguments`。产品 Web 默认关闭且不展示；受信的测试或调试调用方可以在创建服务时显式开启，生产请求体和查询参数不提供这个开关，避免向浏览器暴露工具参数。

Provider 必须先产生唯一的 completed turn；工具参数还要通过 `JSON.parse` 和对应工具的 Zod schema 后，才允许进入执行链：

- 已知工具且参数通过该工具 Schema 校验后，`tool.started` 一次性携带 `arguments`。
- `tool.completed` 一次性携带 `result` 或稳定的 `error`。
- 未知工具或非法参数不会执行，也不会产生 `tool.started`，只产生失败的 `tool.completed`。
- 未配置策略的工具不会出现在 Provider 工具目录中；即使模型仍输出该工具，也会在执行门产生 `TOOL_PERMISSION_DENIED`。

参数与结果在进入公开事件前会递归遮盖常见敏感字段名（如 `password`、`token`、`apiKey`、`authorization`）；内部工具执行和 transcript 仍使用原值。

成功 Run 以 `run.completed` 结束，失败 Run 以 `run.error` 结束。响应开始后发生的错误不能再改 HTTP 状态码。如果已经发送部分 `answer.delta` 后 Provider 输出被判定无效，客户端可以保留预览，但必须标记为未完成，不能把它当成成功回答。

`run.error` 是业务失败的唯一公开终止信号；发送后事件流正常结束，不会再抛出同一业务异常。主动取消例外：连接通常已经不可写，因此不会补发终止事件。

## 取消与背压

浏览器断开连接后，HTTP 层会 abort 当前 Run，并把同一个 `AbortSignal` 传到 Provider 和 Tool。Provider 流迭代结束后还会再次检查 signal，避免把连接取消误判成普通协议错误。

取消信号会在事件边界以及工具执行返回后重新检查，取消后不会再产生完成事件。默认 `bash` 会响应 signal 并终止命令进程组；自定义 Tool 需要自行实现协作式中断。即使 Tool 忽略 signal，其结果也不会继续进入事件流。

每写一个 SSE frame 都检查 `response.write()`。返回 `false` 时暂停拉取上游事件，等 `drain` 后继续，因此不会为慢客户端维护无界事件队列。

单个 Provider turn 的正文与工具参数合计最多 256 KiB，普通 ToolResult 最多 64 KiB。`skill` 的源文件最多 64 KiB，其 JSON 结果考虑转义开销后最多 512 KiB。超过限制时分别产生 `MODEL_OUTPUT_TOO_LARGE` 或 `TOOL_OUTPUT_TOO_LARGE`，避免构造无界 SSE frame。

## 验证重点

自动化测试使用真实随机 TCP 端口和一个带闸门的 Fake Provider：收到第一个 `answer.delta` 时 Provider 仍停在闸门前，证明答案预览确实早于 Run 完成。测试同时验证产品流默认不包含 `model.delta`、事件序号连续，并覆盖参数校验、断开取消以及写入背压。
