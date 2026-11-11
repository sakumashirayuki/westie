# Run 与 SSE 连接解绑

> 定稿（2026-09-29）。

现在一个 Run 的生命周期绑在发起它的那条 SSE 连接上：刷新页面、关掉标签页、网络抖一下，Run 就变成
`cancelled`；页面重新打开后也接不回正在跑的 Run。自举一个 Run 常常要几十分钟，这个限制已经造成过
两次实际损失（09-24 的 `4ff6a34b`、09-28 的 provider-retry 自举）。本方案让 Run 在服务端独立运行，
SSE 连接只是订阅者：断开只影响这条连接，重连可以从断点续上，取消改为显式请求。不改数据库。

## 当前实现

### 启动与取消是同一条连接

`POST /v1/agent/conversations/{id}/runs:stream`（`src/http/conversation-run-sse-route.ts`）一次做完三件事：

1. `watchClientDisconnect(request, response)` 创建一个 `AbortController`，在 `request.aborted` 或
   `response.close` 时 abort，reason 是 `Error("Client disconnected.")`（`src/http/client-disconnect.ts`）；
2. 把这个 signal 传给 `ConversationRunService.startRun`，一路传到 `streamAgentRun`、工具执行、审批等待、子 Run；
3. `for await` 拉取 `startedRun.events`，逐条 `writeSseEvent`，写入带背压。

所以：

- **连接断开 = 取消**。Web 的「停止」按钮（`useConversationRun.stop`）就是 `controller.abort()` 掉 fetch，
  服务端没有单独的取消接口。
- **事件流是拉取式的**。`#runEvents` 是 async generator，SSE 写不动时 Run 本身也停在 `yield` 上不前进。
  事件只存在于这条连接里，没有别处可以再读到。

### 取消时没有终态事件

`exposeRunErrors`（`src/agent-loop.ts:289`）在取消时先 `beforeRunFailed` 落库，然后**抛出**
`signal.reason`，不 yield 任何终态事件。因为取消只可能来自连接断开，从来没有人需要看到它。

### Web 打开运行中的会话

`hydrateTurn`（`web/src/conversation-state.ts`）遇到 `status === "running"` 的 Run，直接渲染成错误
`RUN_STREAM_NOT_RESUMABLE`「该运行的实时连接无法恢复」。运行中的步骤、工具调用、待审批请求都看不到，
插话和停止也用不了（`canSteer` 依赖 `activeRef.runId`，只有发起方才有）。

### 已有的相关状态

- `conversations.active_run_id` 是「会话是否有 Run 在跑」的权威来源，插话路由已经在用。
- `InMemoryInteractionBroker`：审批请求按 `interactionId` 存在内存里，默认 5 分钟超时；响应接口只认 id，
  不认连接。
- `RunSteeringQueue`：按 `runId` 存在内存里。
- SSE 事件已经带 `id: {runId}:{seq}`（`src/http/sse.ts`），`seq` 在 Run 内单调递增，但服务端不读
  `Last-Event-ID`。
- 进程重启时 `recoverStaleRuns` 把所有 `running` 的 Run 标成 `failed / RUN_INTERRUPTED`。
- 优雅退出（`server-bootstrap.ts` 的 `shutdown`）：`server.close` 等所有连接结束后再关库。现在连接结束
  就意味着 Run 结束，所以不会出现「库关了 Run 还在写」。

## 其他 Harness 的做法（凭印象，未核对源码）

- **OpenCode**：`opencode serve` 里 session 的执行与客户端连接无关，客户端通过全局 `/event` SSE 订阅，
  取消走 `POST /session/{id}/abort`。
- **Codex app-server**：turn 由服务端驱动，客户端断开不影响；中断是显式的 `turn/interrupt` 请求。

共同点：**执行归服务端，连接只订阅；取消是一个显式命令**。

## 目标

- 刷新、关页面、断网都不影响 Run，Run 照常跑完并落库。
- 重新打开会话时，能看到运行中 Run 的完整过程（已完成的步骤、在飞的工具、待审批请求），并继续实时更新；
  插话、审批、停止都可用。
- SSE 意外断开时，Web 自动重连，从断点续上，不重复、不丢事件。
- 停止按钮通过显式接口取消，所有订阅者都收到终态。
- 服务端优雅退出时，运行中的 Run 被取消并正常落库。
- 侧栏能看出哪些会话正在运行、哪些在等审批；运行中也能切到别的会话、新建会话。

## 非目标

- **不跨进程重启存活**。进程重启后 Run 仍由 `recoverStaleRuns` 标成失败。Run 本身就是内存里的 async
  调用栈，要跨重启得把整个 loop 做成可恢复的状态机，不在本方案范围。
- **不持久化事件日志**。事件只在内存里保留；Run 结束一段时间后丢弃，之后以数据库里的 transcript 为准
  （和现在 hydrate 已结束的 Run 一样）。
- 不改 Run 的执行逻辑、不改 transcript 落库格式、不改数据库 schema。
- 不做多用户权限模型。谁能发起 Run，谁就能订阅和取消，门禁与现有路由一致。

## 设计

### 1. `RunRegistry`：Run 由服务端持有

新增 `src/application/run-registry.ts`。registry 本身是进程内单例，里面是 `Map<runId, ActiveRun>`，
可以同时持有多个会话的 Run。「一个会话同一时间只有一个 Run」仍由 `beginRun` 的 `active_run_id IS NULL`
条件保证，registry 不重复这条约束。

```ts
interface ActiveRun {
  readonly runId: string;
  readonly conversationId: string;
  readonly controller: AbortController;   // Run 的唯一取消源
  readonly log: RunEventLog;              // 见第 2 节
  readonly done: Promise<void>;           // pump 结束（已落库）时 resolve
}

class RunRegistry {
  start(command): { runId }               // 调 ConversationRunService.startRun，启动 pump
  get(runId): ActiveRun | undefined
  cancel(runId, reason): "cancelling" | "not_found"
  cancelAll(reason): Promise<void>        // 优雅退出用，等所有 done
}
```

- `start` 自己创建 `AbortController`，把 signal 传给 `startRun`。**HTTP 层不再往 Run 里传任何 signal。**
- **pump**：`start` 里起一个不 await 的循环，`for await` 拉 `startedRun.events`，每条追加进 `log`。
  pump 不等任何订阅者，Run 的推进速度与连接无关。pump 的异常全部在内部收口（见第 3 节），不会变成
  unhandled rejection。
- `ConversationRunService` 基本不动：它仍然返回 `{ runId, events }`，只是消费方从 SSE 路由换成了 pump。
- `RunSteeringQueue`、`InteractionBroker` 不动，它们本来就按 id 寻址。

### 2. `RunEventLog`：可回放的事件日志

它是 Run 运行期间的临时缓冲，只在内存里，不落库；Run 的结果仍在结束时写进数据库。

一个最小例子：Run `r1` 已经产生了 seq 1–5，页面在收到 seq 3 之后刷新。重新打开后请求
`GET /conversations/c1/runs/r1/events?after=3`，响应先回放已有的两条，再接实时：

```
id: r1:4
event: tool.started
data: {"v":1,"runId":"r1","seq":4,"type":"tool.started",...}

id: r1:5
event: tool.completed
data: {"v":1,"runId":"r1","seq":5,"type":"tool.completed",...}

id: r1:6            ← 这条是刷新之后新产生的，实时推送
event: step.completed
...
```

每个 Run 一份，追加式：

```ts
class RunEventLog {
  append(event: AgentEvent): void
  close(): void                            // pump 结束时调用
  subscribe(afterSeq: number, signal): AsyncIterable<AgentEvent>
}
```

- `subscribe(afterSeq)` 先回放 `seq > afterSeq` 的已有事件，再等新事件；`close()` 之后回放完就结束。
  回放与实时是同一条路径（订阅者就是日志上的一个游标），不存在「回放完到切实时之间漏一条」的窗口。
- 每个订阅者各自按自己的背压写 socket，慢订阅者不拖慢 Run，也不拖慢别的订阅者。
- **不记 `model.delta`**。它是 provider 传输层的高频小块，Web 本来就丢掉（`handleEvent` 里跳过），
  且默认 `includeModelDeltas: false`。
- **内存上限**：单个 Run 的日志按序列化字节计，上限 64 MiB。工具输出单条上限 64 KiB
  （`MAX_TOOL_OUTPUT_BYTES`），几百次工具调用也就几十 MiB，正常自举碰不到。超过后日志标记为
  `truncated`：停止保存新事件，已有订阅者继续收实时事件，**新**订阅者拿到 `410 RUN_STREAM_NOT_REPLAYABLE`，
  Web 退回现在的提示。这是兜底。
- **结束后保留 60 秒**再从 registry 移除。只为覆盖「Run 刚结束、客户端正在重连」这个窗口；
  过了窗口，客户端重新 GET 会话，数据库里已是终态。

### 3. 终态事件：补上 `run.cancelled`

现在取消时事件流以异常结束，没有终态事件；以前没关系，解绑后其他订阅者（另一个标签页、点停止的那个页面）
需要知道 Run 已经结束。

- 新增事件类型 `run.cancelled`，`data` 为空对象。**由 pump 合成**：`events` 抛错且
  `controller.signal.aborted` 时，pump 追加一条 `{ type: "run.cancelled", seq: lastSeq + 1 }` 再 `close()`。
- 现在 SSE 路由里「事件流抛异常、没发过终态就补一条 `run.error / AGENT_RUN_FAILED`」的兜底，
  **挪进 pump**。这样日志里的每个 Run 都恰好以一条终态事件结束：`run.completed`、`run.error`、
  `run.cancelled` 三选一。
- `isTerminalAgentEvent`（服务端 `sse.ts`、Web `events.ts`）加上 `run.cancelled`。
- 不改 `streamAgentRun` 取消时抛错的约定，所以 loop 层和它的测试不受影响。
- 合成事件拿不到用量，省略 `usage`；准确用量在 `run_model_calls` 里，Web 收到终态后会重新 GET 会话。

### 4. HTTP 接口

三个接口，分工是：**启动用原接口，续传用新接口，取消用新接口**。

| 用途 | 接口 | 说明 |
|---|---|---|
| 启动 Run | `POST /conversations/{id}/runs:stream` | **沿用**，路径和请求体不变。启动 Run，并在同一个响应里推送这个 Run 从第一条开始的事件。这条连接断开后**不能**再用它接回来，它只负责启动。响应头加 `X-Run-Id`，保证在收到第一条事件前断线也知道 runId。 |
| 续传 / 接回运行中的 Run | `GET /conversations/{id}/runs/{runId}/events` | **新增**。启动之后的所有订阅都走这里：断线重连、刷新页面、切回会话、另开标签页。从 `Last-Event-ID`（`{runId}:{seq}`）或 `?after={seq}` 之后续传，都没有则从头回放，然后接上实时事件。 |
| 取消 Run | `POST /conversations/{id}/runs/{runId}:cancel` | **新增**。`registry.cancel`，返回 `202 { runId, status: "cancelling" }`。幂等：已在取消中也返回 202。取消不再靠断开连接。 |

两个 SSE 接口推送的是同一份 `RunEventLog`，事件格式完全一样。区别只在于 `runs:stream` 会先创建 Run、从 seq 0 开始，
`events` 用于已存在的 Run、从指定的 seq 开始。

`events` 的状态码：

- Run 在 registry 里：200，开始推送；
- Run 不在 registry、数据库里是终态：`410 RUN_STREAM_ENDED`，客户端重新 GET 会话；
- Run 不在 registry、数据库里是 `running`（只可能是日志超限被拒，或极短的启动竞态）：
  `410 RUN_STREAM_NOT_REPLAYABLE`；
- runId 不属于这个会话、或不存在：404。

`cancel` 的状态码：Run 不在 registry 里且已是终态 → `409 RUN_NOT_ACTIVE`；runId 不属于该会话 → 404。

门禁：`events` 与 `cancel` 都做和 `runs:stream` 相同的 `evaluateFullAccessRequest` 检查。`cancel` 是改状态的
操作，额外要求 `isTrustedHostActionOrigin`（和删除会话一致）。

`watchClientDisconnect` 仍保留，用于选目录、选文件这类「请求期间有效」的操作；它只是不再用于 Run。

取消的 reason 改成 `RunCancelledError("Run cancelled by request.")` / `("Agent service is shutting down.")`，
方便从 `internal_error` 区分是谁取消的。

### 5. 优雅退出

解绑后，`server.close` 的回调不再意味着 Run 都结束了，直接关库会让还在跑的 Run 写库失败。

`shutdown` 改为：

1. 停止接受新连接（`server.close()`）；
2. `await registry.cancelAll(shutdownReason)`，等每个 Run 的 `beforeRunFailed` 落库（上限 10 秒，
   超时的留给下次启动的 `recoverStaleRuns`）；
3. `server.closeAllConnections()` 结束残留的 SSE 连接；
4. 关库、关 MCP pool。

### 6. Web

**发起**：不变，仍用 `runs:stream`。`activeRef` 里记下 `runId` 和最后收到的 `seq`。

**停止**：`stop()` 改为调用 `cancel` 接口，**不再** abort 事件流；UI 立即进入「正在停止」，
等流里的 `run.cancelled` 到了再落到 `cancelled`。cancel 请求失败就提示并恢复停止按钮。
（取消需要等在飞的工具落地，可能要几秒；现在这段时间 UI 已经显示停止了，其实服务端还在跑。）

**断线重连**：事件流非正常结束（网络错误、没有收到终态就 EOF）时，用 `events?after={lastSeq}` 重连，
退避 0.5s → 1s → 2s → 4s，最多 5 次。收到 410 或重试用尽，就重新 GET 会话按数据库状态渲染。

**打开运行中的会话**：`hydrate` 发现最后一个 turn 的 Run 是 `running` 时：

1. 先按现有逻辑渲染已落库的部分（`running` 的 Run 在数据库里还没有 transcript，所以基本只有用户消息）；
2. 调用新的 `resume(conversationId, turnId, runId)`：建立 `activeRef`，`events?after=0` 从头回放，
   事件走和实时完全相同的 `handleEvent` / reducer，回放结束后自然衔接实时；
3. 回放完后插话、审批、停止都可用，因为 `activeRef.runId` 已经有了。

`RUN_STREAM_NOT_RESUMABLE` 保留，只在 410 `NOT_REPLAYABLE` 时出现。

**多标签页**：两个页面各自订阅，都能看到实时过程；审批谁先点谁生效，另一个页面收到
`interaction.resolved` 后自动收起（现有逻辑）。两个页面同时发插话都会进队列，这是可以接受的。

**运行中允许切换会话**：现在 `App.tsx` 的 `busy` 包含 `run.isActive()`，Run 在跑时切换会话、新建会话、
删除会话都被禁用，因为离开就等于断开、等于取消。解绑后：

- 切换会话、新建会话不再受 `run.isActive()` 限制。离开时只结束当前订阅（abort 事件流的 fetch），
  Run 继续跑；切回来走上面「打开运行中的会话」的路径。
- 删除仍然禁止删除有 Run 在跑的会话（服务端已有 `409 CONVERSATION_BUSY`）；前端按侧栏状态只禁用该会话的删除按钮，
  其他会话照常可删。
- `useConversationRun` 里「离开会话」和「停止」要分开：前者只断订阅，后者调 cancel。

### 7. 侧栏运行状态

侧栏要显示每个会话当前是否有 Run 在跑。难点是：Run 不在当前打开的会话里时，前端收不到它的事件。

**数据来源：全局运行状态流**。新增 `GET /v1/agent/runs:watch`（SSE），由 `RunRegistry` 直接提供：

- 连接建立时先发一条 `snapshot`，列出 registry 里所有运行中的 Run：
  `{ runs: [{ conversationId, runId, state, startedAt }] }`；
- 之后每次状态变化发一条 `run.state`：`{ conversationId, runId, state }`，
  `state` 为 `running`、`awaiting_interaction`、`ended`（`ended` 带 `status: completed | failed | cancelled`）；
- 每 30 秒一条注释行心跳，便于发现半开连接。

`state` 由 registry 在 pump 里顺手维护，不需要额外的数据源：

- 追加 `interaction.required`（包括 `subagent.event` 里包着的）时计数 +1，`interaction.resolved` 时 −1；
  计数 > 0 就是 `awaiting_interaction`，否则是 `running`；
- 追加终态事件时变成 `ended`，随后从快照里移除。

为什么不用轮询会话列表：列表是分页的，刷新第一页会把已加载的后续页冲掉；而且 5 秒一次的轮询仍然看不到
「审批已经等了 4 分钟」这种要马上处理的状态。状态流只在 registry 状态变化时发，量很小，
断线重连后 `snapshot` 直接给出全量，不需要 `Last-Event-ID`。

会话列表接口 `GET /conversations` **不加字段**。运行状态只有一个来源，避免列表和状态流不一致。

门禁：与 `GET /conversations` 一致。

**Web**：

- 新增 `useRunActivity()`：在 `App` 层建立一条 `runs:watch` 连接，维护
  `Map<conversationId, { runId, state }>`；断开后按第 6 节同样的退避重连，重连收到的 `snapshot` 直接替换整张表。
- `ConversationList` 的每一项按状态显示标记：
  - `running`：会话名旁一个呼吸的绿色圆点，`aria-label="运行中"`；
  - `awaiting_interaction`：琥珀色圆点，文字「等待审批」。它在 5 分钟后超时，是侧栏里最需要被看到的状态；
  - 没有 Run：不显示。
  `prefers-reduced-motion` 下圆点不做呼吸动画。
- 收到 `ended` 时调用一次 `catalog.refresh()`，让列表的排序和 `updatedAt` 跟上（现在只在自己发起的 Run
  结束时刷新）。
- 当前打开的会话也以状态流为准显示标记，和对话区里自己的事件流互不依赖。

**不做**：「已完成未读」标记、系统通知。先看有了运行中标记之后够不够用。

## 行为变化与风险

- **没人看着的 Run 会一直跑下去**（已确认是期望行为）。跑偏的 Run 靠侧栏找到它，打开后停止。
- **没人看着时遇到审批**（已确认）：审批请求 5 分钟后按现有逻辑超时（`expired`），工具按拒绝处理，Run 继续。
  侧栏会显示「等待审批」；用户回来时在回放里能看到这次超时。
- **取消变慢**：以前断开连接后 UI 马上显示停止；现在要等 `run.cancelled`。实际服务端耗时没变，
  只是 UI 不再提前宣布。
- **内存**：运行中的 Run 日志最多 64 MiB，结束后 60 秒释放。单用户本地服务，同时跑的 Run 很少。
- **`streamAgentRun` 的 signal 语义不变**，子 Run、工具、审批等待的取消链路原样沿用，只是 signal 的源头
  从 HTTP 换到了 registry。

## 保持不变

- 数据库 schema、transcript 落库格式与时机（Run 结束时一次写入）。
- `streamAgentRun` / agent loop 的执行逻辑，以及取消时抛错的约定。
- 一个会话同一时间只有一个 Run（`beginRun` 的 `active_run_id` 条件）。
- 审批的 5 分钟超时与超时后按拒绝处理；插话队列。
- 进程重启后运行中的 Run 由 `recoverStaleRuns` 标成失败。
- 启动 Run 的接口 `POST /conversations/{id}/runs:stream` 的路径、请求体和事件格式。
- 选目录、选文件仍用 `watchClientDisconnect`，断开即取消。

## 测试

服务端（`test/`）：

- `server.test.ts` 里的「client disconnect aborts the active provider stream」**反转**：断开连接后
  provider 流不被 abort，Run 以 `completed` 落库。
- 断开后用 `events?after=N` 重连：收到的事件从 `N+1` 开始，连续、不重复，以终态结束。
- 带 `Last-Event-ID` 头重连，效果同上。
- 两个订阅者同时订阅，其中一个不读（socket 背压），另一个照常收到全部事件，Run 按时结束。
- `cancel`：Run 以 `cancelled` 落库，所有订阅者收到 `run.cancelled`；重复 cancel 返回 202；
  已结束的 Run 返回 409；别的会话的 runId 返回 404。
- 等待审批期间 cancel：审批被 dispose，Run 取消，transcript 满足 `validateTranscriptBatches`
  （依赖 09-28 已合入的工具批次补齐）。
- Run 结束 60 秒内订阅：回放完整日志；超过保留期订阅：410 `RUN_STREAM_ENDED`（用可注入的时钟 / 保留时长）。
- 日志超限：新订阅者 410 `RUN_STREAM_NOT_REPLAYABLE`，已有订阅者继续收到终态。
- 事件流抛非预期异常：日志以 `run.error / AGENT_RUN_FAILED` 结束（原 SSE 路由兜底的回归）。
- 优雅退出：有 Run 在跑时触发 shutdown，Run 以 `cancelled` 落库后才关库。
- 日志里没有 `model.delta`。
- `runs:watch`：连接时的 `snapshot` 列出所有运行中的 Run；Run 开始、进入审批、审批结束、结束时各推一条
  `run.state`；子 Run 里的审批也算 `awaiting_interaction`；同时有两个审批时要两个都 resolved 才回到 `running`。

Web（`web/src/`）：

- `run-client`：`subscribeConversationRun` 正确带 `after` / 解析 410；`cancelConversationRun` 的各状态码。
- `useConversationRun`：
  - 断流后自动重连，`seq` 连续，UI 状态与不断流时一致；
  - `stop` 调 cancel 而不 abort 流，收到 `run.cancelled` 后进入 cancelled；
  - `hydrate` 遇到 running 的 Run 自动 `resume`，回放后能插话、能审批；
  - 410 时回退到 GET 会话。
- `conversation-state`：`run.cancelled` 事件把 turn 和其下运行中的子 Run 都置为 cancelled。
- `useRunActivity`：`snapshot` 替换整表、`run.state` 增量更新、`ended` 时移除并触发列表刷新、断线重连。
- `ConversationList`：三种状态的标记和无障碍标签；运行中会话的删除按钮禁用，其他会话照常可删。
- `App`：Run 在跑时仍能切换会话和新建会话；切走再切回，过程完整且 Run 没被取消。

手工验证：发起一个会跑几分钟的 Run，中途刷新页面，确认过程完整恢复、Run 正常完成；再中途点停止，确认两个
标签页都显示已停止。发起 Run 后切到另一个会话，确认侧栏显示运行中，触发审批时变为「等待审批」，结束后标记消失。

## 改动范围

- 新增：`src/application/run-registry.ts`、`src/application/run-event-log.ts`、
  `src/http/conversation-run-events-route.ts`、`src/http/conversation-run-cancel-route.ts`、
  `src/http/run-activity-route.ts`（`runs:watch`）、`web/src/hooks/useRunActivity.ts`
- 修改：`src/http/conversation-run-sse-route.ts`（改用 registry，删掉兜底 run.error）、
  `src/http/agent-controller.ts`（两条新路由）、`src/http/sse.ts`（终态判断）、
  `src/agent-events.ts`（`run.cancelled` 类型）、`src/server-bootstrap.ts`（registry 装配、shutdown）
- Web：`web/src/run-client.ts`、`web/src/events.ts`、`web/src/hooks/useConversationRun.ts`、
  `web/src/conversation-state.ts`、`web/src/run-state.ts`，以及加载会话后调用 `resume` 的地方
  （`useConversationLoader.ts` / `App.tsx`，含 `busy` 的拆分）、`web/src/components/ConversationList.tsx`
- 测试：见上
