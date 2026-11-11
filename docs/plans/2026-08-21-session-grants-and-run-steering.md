# 会话级权限授权与运行中转向

一次需要 20 条命令的任务，现在要用户点 20 次「允许一次」；agent 在第 3 步跑偏时，用户唯一的手段是断开 SSE 取消整个 Run，前面几十步的 transcript 一起作废。这两件事都不是 prompt 能解决的，它们是 harness 的物理约束：权限判定只有「工具名 → 效果」这一档粒度，Run 生命周期内没有任何接收用户输入的入口。

本方案加两个能力：用户批准一次 bash 调用时可以把这次批准扩大为「本会话内允许该命令前缀」，之后同类调用不再中断；用户可以在 Run 运行中追加消息，Agent Loop 在下一个步边界把它作为 user 消息插入当前 transcript 并继续。改动集中在权限判定层、Agent Loop 的步边界和 HTTP/Web 的一个入口，不新增数据库表。Sandbox 边界、资源限制、canonical transcript 的消息类型、执行模式语义都不变。

## 当前实现

### 权限判定

`ToolPermissionPolicy.evaluate()` 是同步的，输入 `{name, capability, input}` 加 `ToolPermissionContext {workspaceRoot, executionMode, conversationId, runId}`，输出 `allow | deny | confirm`（`src/tool-permissions.ts:47`）。

生产装配是两层：`ExecutionModeToolPermissionPolicy` 在 `full_access` 下直接 allow，否则委托 `FixedToolPermissionPolicy`（`src/tool-permissions.ts:93`）。后者按**工具名**查一张静态表，表外的工具默认 deny（`src/tool-permissions.ts:56`）。`defaultToolPermissionRules` 里只有 `bash` 是 `confirm`，其余 7 个工具都是 `allow`（`src/tool-permissions.ts:392`）。

判定不看工具参数。同一个 conversation 里第 1 次和第 20 次 `bash` 得到完全相同的 `confirm`，`context.conversationId` 目前只被 `workspace_grant` 用到。

### 审批交互

`confirm` 走 `authorizeToolCall()`：`createApproval()` 造一个 `ToolApprovalInteraction` 交给 `InteractionBroker`，Loop `yield interaction.required` 事件后在 `pending.wait(signal)` 上阻塞，直到 HTTP `POST /v1/agent/interactions/:id:respond` 送回 `{decision: "approve" | "deny"}`，或 5 分钟超时（`src/agent-tool-call.ts:137`、`src/application/interaction-broker.ts:113`）。

响应体 schema 只有一个字段：`decision`（`src/http/interaction-routes.ts:17`）。Broker 侧 `isValidResponse()` 对 `tool_approval` 只校验「不带 selectedPath」，`isSameDecision()` 只比 `decision` 和 `selectedPath` 两个字段。

批准的效力只覆盖当前这一个 `PreparedToolCall`。Broker 是纯内存的，进程重启即清空。

Web 侧的审批卡片渲染在工具轨迹内部，嵌在三层折叠里：`RunTrace` 的「运行过程」`<details>` → 该 step 的 `<li>` → 该工具的 `<details>` → `ToolApprovalCard`（`web/src/components/RunTrace.tsx:111`）。卡片本身不展示工具参数，用户看到的命令来自紧邻的「参数」`DataBlock`。存在待处理交互时 `RunTrace` 会自动展开最外层 `<details>`，但整块轨迹位于可滚动的对话记录区内，随对话增长被推离视口。

### Run 生命周期与并发

一个 Conversation 同时只有一个活跃 Run，由 `conversations.active_run_id` 强制：`beginRun` 在 immediate transaction 里检查它非 NULL 就抛 `ConversationBusyError`，HTTP 映射为 409 `CONVERSATION_BUSY`（`src/infrastructure/sqlite/sqlite-conversation-store.ts:273`、`src/http/conversation-run-sse-route.ts:104`）。

Run 启动后，transcript 的第一条也是唯一一条 user 消息由 `prepareAgentRun()` 从 `options.input` 造出（`src/agent-loop.ts:178`），之后整个 `runEventLoop` 只追加 assistant 和 tool 消息。Loop 没有任何外部输入通道，`signal` 是唯一能从外部影响运行的东西，它只能取消。

Web 侧 `ConversationComposer` 在 `status === "running"` 时禁用输入框，把发送按钮换成「停止」（`web/src/components/ConversationComposer.tsx:44`）。

### 上下文投影

`ContextCompactor.createProviderTranscript()` 产出的 Provider 视图是四段拼接：`canonicalTranscript[0]`、累计摘要的 synthetic user 消息、受保护的 Skill 调用对、覆盖点之后的尾部（`src/application/context-compactor.ts:205`）。索引 0 被单独 pin 住是因为它是原始用户任务；除此之外，落在覆盖范围内的任何消息都会被摘要文本替换。

`completeToolPairEndpoints()` 只在 `assistant(toolCalls) + tool` 相邻对上取覆盖终点。

### 存储

全库 7 张表：`conversations`、`turns`、`runs`、`transcript_messages`、`run_context_compactions`、`run_history_summaries`、`run_model_calls`（`src/infrastructure/sqlite/schema.ts`）。没有任何一张表保存权限授权，也没有任何一张表保存 Run 运行期收到的输入。既有的两处授权状态——`InteractionBroker` 的待处理交互与 `InMemoryWorkspaceGrantStore` 的一次性文件授权——都在内存里，随进程消失。

`turns.user_message` 是单列 TEXT，一个 Turn 只能有一条用户消息。

## 存在的问题

**批准的粒度和成本不匹配。** 用户真正想表达的是「这类命令我信」，而系统只提供「这一次我信」。20 次确认里有 19 次的信息量是 0，而它们每一次都让 Loop 停在 `pending.wait()` 上，5 分钟不响应就 `TOOL_APPROVAL_EXPIRED`。结果是用户为了把任务跑完，倾向于直接创建 `full_access` 会话——把「按命令决定」退化成「整个会话无边界」，这比细粒度授权危险得多。

**跑偏只能靠丢弃。** 用户在第 3 步就看出 agent 在改错的目录，但没有任何低成本的纠正手段：取消会把整个 Run 标成 `cancelled`，重新发起的 Run 只能通过跨 Run 历史摘要间接继承上下文，而失败 Run 的 transcript 明确不进入模型输入。纠正一句话的代价是重跑几十步。

**「不许打断」和「必须打断」同时存在。** 上一版加的自主性契约要求模型连续工作、不要每步询问；`maxSteps` 提到 512 并预留了交接步。这两个改动都在让单个 Run 变长，而 Run 越长，中途没有输入通道的代价越大，每条 bash 都确认的代价也越大。两个功能是同一个约束的两面。

**审批藏在三层折叠里。** 待处理审批与工具轨迹同处一地，出现在「运行过程 → STEP n → 工具」的最内层，且整块轨迹在可滚动区域内。Run 越长，审批卡片离视口越远；用户要先意识到运行卡住了，再去对话记录里翻找那张卡片。审批是**阻塞整个 Run 的同步交互**，把它放在需要检索的位置，等待时间就等于用户的查找时间。

## 目标实现

### 一次会话级授权长什么样

模型第 3 步请求 `bash {command: "npm test -- --watch=false"}`。Harness 照旧发出审批交互，但 payload 多了一组可授予的作用域，最具体的排在前面：

```json
{
  "v": 1, "runId": "3f9…c1", "seq": 9, "type": "interaction.required", "step": 3,
  "interactionId": "7c1…e0", "kind": "tool_approval",
  "expiresAt": "2026-08-21T09:14:02.001Z",
  "payload": {
    "toolCallId": "call_a1", "toolName": "bash",
    "capability": "process.shell.execute", "ruleId": "default:bash:confirm",
    "argumentsDigest": "9b2…",
    "argumentsSummary": {
      "command": "npm test -- --watch=false",
      "cwd": "<项目根目录>", "timeoutMs": 30000
    },
    "risk": "Bash can execute arbitrary commands inside the macOS workspace sandbox.",
    "impact": "Runs one zsh command inside the macOS workspace sandbox.",
    "grantOptions": [
      { "kind": "command_prefix", "value": "npm test" },
      { "kind": "command_prefix", "value": "npm" },
      { "kind": "tool" }
    ]
  }
}
```

用户选「本会话内允许 `npm test`」，前端提交：

```json
{ "response": { "decision": "approve", "grant": { "kind": "command_prefix", "value": "npm test" } } }
```

`ToolGrantStore` 里多出一条属于该会话的授权：

```json
{
  "conversationId": "8ad…7f", "toolName": "bash",
  "scope": { "kind": "command_prefix", "value": "npm test" },
  "grantedRunId": "3f9…c1", "grantedToolCallId": "call_a1",
  "createdAt": "2026-08-21T09:09:11.417Z"
}
```

第 11 步模型请求 `bash {command: "npm test --silent"}`。`evaluate()` 命中这条授权，返回 `{effect: "allow", ruleId: "conversation-grant:bash:command_prefix:allow"}`，不创建交互，不产生 `interaction.required`，审计里照旧有一条 `policy.decision`。第 14 步请求 `bash {command: "rm -rf node_modules"}`，不命中任何授权，仍然停下来等确认。

### 一次运行中转向长什么样

Run 正在第 6 步执行工具，用户在输入框里补一句话。前端 POST 到一个与 SSE 流独立的接口：

```
POST /v1/agent/conversations/8ad…7f/runs:steer
{ "runId": "3f9…c1", "input": "别动 web/，先把 server 的测试跑通" }

202 { "runId": "3f9…c1", "seq": 0, "status": "queued" }
```

第 7 步开始时，Loop 在构造 Provider 请求前取走这条消息，把它作为一条普通 user 消息追加到当前 canonical transcript，并在**已建立的那条 SSE 流**上发出：

```json
{
  "v": 1, "runId": "3f9…c1", "seq": 31, "type": "steering.applied", "step": 7,
  "data": { "messageSeq": 0, "content": "别动 web/，先把 server 的测试跑通" }
}
```

第 7 步的 Provider 请求因此包含两条 user 消息：原始任务和这条转向消息。Run 不重启、不新建 Turn、不新建 Run，`maxSteps` 预算不变。

### 授权作用域模型

一条授权由四元组唯一确定：`conversationId + toolName + scopeKind + scopeValue`。

| scopeKind | scopeValue | 含义 |
|-|-|-|
| `command_prefix` | 规范化后的命令前缀，如 `npm test` | 本会话内，该工具的 `command` 参数以这串词元开头且命令是简单命令时，免确认 |
| `tool` | 空串 | 本会话内该工具的所有调用免确认 |

四条硬约束：

- **只能把 `confirm` 降为 `allow`。** 授权在 `deny` 之后判定，任何授权都不能让被策略拒绝的工具通过。这保证授权不是绕过策略的旁路。
- **只能由用户经交互接口创建。** 唯一写入路径是 `:respond`，且 `grant` 必须精确等于该交互 payload 里 `grantOptions` 的某一项，服务端用交互自身重新派生的候选列表校验，不接受客户端自造的前缀。模型无法通过工具结果、Skill 或任何 transcript 内容创造授权。
- **不跨 Conversation。** 同一 workspace 的另一个会话不继承。Conversation 的 `executionMode` 不可变，因此 `conversationId` 已经隐含了执行模式，授权不需要单独记录它。
- **不改变 sandbox。** 授权只跳过确认交互。Seatbelt profile、资源配额、进程收容、路径边界全部照旧生效。

授权存在内存里，不落库，与 `InteractionBroker`、`InMemoryWorkspaceGrantStore` 同层：按 `conversationId` 建，会话删除或进程重启即消失，没有过期时间。这与主流 harness 的「本次会话允许」是同一档语义，区别只是这里的「会话」是 Conversation 而不是 CLI 进程。

选内存态而不是落库，是为了不引入一个「持久的权限降级 + 一套自制管理 API」。持久化的授权必须配套列表和撤销，而数据库行对用户不可读不可改，撤销就得自己造接口和面板；主流 harness 之所以不需要这类接口，是因为它们的长效授权落在用户自己拥有的配置文件里，文件本身就是管理面。这个 harness 目前没有权限配置文件这个面，与其为此新造一个，不如把授权限制在一次进程生命周期内——要消除的确认本来全部发生在一次长任务之内，而重启已经会把 running Run 标成 failed，长任务此时也断了。

代价明确：进程重启后同类命令重新要求确认；界面上不展示已授予的作用域，用户通过「同类命令不再询问」感知它生效；误授权无法在浏览器上收回，只能重启服务端或结束会话。审计不丢——`JsonLineToolAuditSink` 的 `policy.decision` 与 `interaction.resolution` 仍然记录每次授予与每次命中，只是落在服务端日志里，不可 SQL 查询。

什么情况下该改成落库：有人真的需要授权跨重启存活，或者需要可查询的授权审计。届时表、列表接口和撤销接口作为一个整体一起加——持久化和撤销必须同时存在。

### 命令前缀的匹配规则

前缀授权的语义是「我批准的那串词元就是实际会跑的整条命令的开头」。要让这句话成立，匹配必须同时满足三条，任何一条不满足就退回单次确认（fail closed，不存在静默放行）：

**1. 命令必须是简单命令。** 原始 `command` 字符串里出现下列任一字符，就永不命中前缀授权：

```
;  &  |  `  $  >  <  (  )  换行  回车
```

排除 `$` 一并排除了 `$(…)` 命令替换和 `${…}` 参数展开；引号和 `*` `?` `[]` 通配不在列内，因为它们不能引入另一个被执行的程序。

**2. 按词元前缀匹配，不做子串匹配。** 命令按空白切成词元，与授权的词元数组逐项全等比较。`npm test` 命中 `npm test --silent`，不命中 `npm testx`。

**3. 首词不在执行包装器名单内。** 下列首词只提供「允许一次」，不提供前缀授权，避免用户一次把整个 shell 授出去：

```
sh  bash  zsh  dash  sudo  doas  env  eval  exec  xargs  nohup  ssh
```

候选前缀的派生规则（对简单命令，词元记为 t1…tn，「裸词」指匹配 `^[A-Za-z0-9._@:/+-]+$`）：

- t1 是裸词且不在包装器名单内 → 候选 `t1`；
- 且 n ≥ 2、t2 是裸词、t2 不以 `-` 开头 → 追加更具体的候选 `t1 t2`。

`rg -n foo src/` 只得到 `rg`；`git status --short` 得到 `git status` 和 `git`；`zsh -c "…"` 得不到前缀候选。`tool` 作用域始终提供。

必须承认这个模型的固有性质：授了 `npm test` 就等于接受 `npm test --prefix /somewhere` 也会跑。前缀授权抬高的是「用户对将要执行什么有稳定预期」这条底线，它不是隔离边界；隔离边界仍然只有 sandbox。

### 审批的呈现位置

待处理审批从工具轨迹里提出来，固定渲染在输入框上方——位于滚动容器之外，因此不随对话记录滚动，运行卡住时用户不需要检索。

四条规则：

- **轨迹里不再有可操作的待处理卡片**，只留一行指向固定区域的提示。已响应和已过期的卡片仍留在轨迹原处，作为该 step 的历史记录；决策入口与历史记录因此不重叠，同一个审批不会出现两套按钮。
- **卡片必须自己展示待执行参数。** 现在的卡片只有 risk、impact、capability，命令来自紧邻的「参数」块；脱离轨迹后那个块不在旁边，卡片不展示参数就等于让用户盲批。这条与审批放在哪里无关，是移动位置的前置条件。
- **多条待处理按 step 升序排列**，同一 step 内文件授权先于工具确认，与轨迹内的顺序一致。Agent Loop 阻塞在单个 `pending.wait()` 上，实际同时最多一条，但呈现层不假定这一点。
- **只有正在运行的 Turn 产生待处理项。** Run 到达终态后固定区域自动消失，因为 Broker 侧此时已不可解析。

会话级授权的作用域按钮出现在这同一张卡片上。两件事因此互相依赖：授权按钮需要用户能同时看见命令和作用域选项才敢按下，而这只有在卡片脱离折叠、自带参数展示后才成立。

### 转向消息的生效点

生效点固定在**步边界**：`step.started` 之后、构造该步 Provider 请求之前。这一点的选择决定了全部时序语义：

- 转向不打断正在执行的工具，也不撤销已经发出的工具调用。用户在第 6 步的工具执行中发消息，第 6 步照常完成，消息在第 7 步生效。
- 当前正等待工具审批时，Loop 阻塞在 `pending.wait()`，转向消息会被接收并排队，但只有审批被响应或过期、Loop 回到步边界后才生效。Web 在待审批状态下要显式提示这一点。
- 多条消息按 `seq` 升序、各自作为独立 user 消息追加，不做合并。
- 强制交接的最后一步（`forcesFinalAnswer`）不取消息。那一步已禁用工具、只要求产出交接说明，注入新指令只会污染交接内容。此时未送达的消息保持未送达。
- Run 到达终态时仍未送达的消息随队列一起丢弃，不落库，也不会被隐式转成下一个 Run 的输入。这个边界交给前端：steer 请求已拿到 202，若该 Run 直到终态都没有出现对应的 `steering.applied`，前端把文本放回输入框并提示未生效。用户刚输入的内容仍在浏览器里，比服务端记一个「未送达」状态更有用，也不需要为一个罕见时序开一张表。

两个上限，与 `MAX_TOOL_CALLS_PER_BATCH` 同处 `protocol.ts`，因为 HTTP 校验、队列和 Loop 三处都要认同它们：

- 单条消息 ≤ 16 KiB（UTF-8 字节）；
- 单个 Run 未送达消息 ≤ 4 条，超出返回 409。

### 上下文投影中的用户消息

转向消息是 canonical transcript 里第二条及以后的 user 消息，而 `createProviderTranscript()` 现在只 pin 索引 0，落在压缩覆盖范围内的转向消息会被摘要文本替换掉——用户的指令被降级成摘要里的一句转述。

目标规则：**canonical transcript 里的每一条 user 消息都是受保护内容**，与最新 Skill 调用对一起原样进入 Provider 视图。索引 0 的特殊 pin 因此变成这条统一规则的一个实例。

覆盖点之前的受保护消息按原索引顺序排在摘要之后，Provider 视图的段序变为：原始用户任务 → 累计摘要 → 受保护内容（转向消息与最新 Skill 调用对，按原顺序）→ 覆盖点之后的尾部。摘要的生成输入也排除受保护消息，与 Skill 保护组的现有处理一致。

`completeToolPairEndpoints()` 不受影响：转向消息只在步边界注入，不可能落在 `assistant(toolCalls)` 与 `tool` 之间。

> 补注（2026-09-24）：本节「每一条 user 消息都是受保护内容」的规则已被 `2026-09-24-compaction-transcript-order.md` 取代。跨 Run 压缩后 canonical transcript 覆盖整段会话，每个 Turn 的开场消息也属于「索引 > 0 的 user 消息」，把它们全部原文保留会让视图尾部被打乱、已处理完的请求看起来像待办。新规则只保留未结束 Turn 的 user 消息原文，已结束 Turn 的 user 消息以摘要形式出现。

系统提示需要一句话说明这件事的语义，加在 `HARNESS_LOOP_INSTRUCTIONS` 里：运行期出现的新 user 消息属于同一任务的最新指令，与既有目标冲突时以最新的为准。它不改变工具结果的不可信定位。

## 具体改动

### 协议常量（`src/protocol.ts`）

新增三个常量：`MAX_STEERING_MESSAGE_BYTES = 16 * 1024`、`MAX_PENDING_STEERING_MESSAGES = 4`、`SHELL_METACHARACTERS`（上文字符集）。`ToolErrorCode` 不新增取值：授权只影响是否发起交互，被拒绝的路径仍然复用 `TOOL_APPROVAL_DENIED` / `TOOL_APPROVAL_EXPIRED`。

### 权限层

新增 `src/tool-grants.ts`，只放纯函数与类型：`ToolGrantScope`（`{kind:"tool"} | {kind:"command_prefix", value:string}`）、`deriveGrantOptions(toolName, input)`、`matchesGrant(scope, toolName, input)`、简单命令判定与词元化。命令前缀规则集中在这一个文件，`bash` 工具本身不参与判定。

新增 `src/application/tool-grant-store.ts`，定义窄端口与唯一实现 `InMemoryToolGrantStore`（形态对照 `workspace-grant-store.ts`）：

```ts
export interface ToolGrantStore {
  isGranted(conversationId: string, toolName: string, input: unknown): boolean;
  grant(grant: NewToolGrant): void;
  clear(conversationId: string): void;
}
```

内部结构是 `Map<conversationId, Set<scopeKey>>`，`scopeKey` 由 `toolName + scopeKind + scopeValue` 拼成，重复授予天然幂等。存的就是判定所需的最小信息：授权来源（哪个 Run、哪次工具调用、什么时刻）只写进审计事件，不留在 store 里，因为没有读出面会用到它。`isGranted` 同步，与 `evaluate()` 的同步签名一致，不需要把权限判定改成异步。`clear` 由 `ConversationService` 在删除会话时调用。

`src/tool-permissions.ts` 新增 `ConversationToolGrantPolicy` 装饰器，装配顺序为 `ExecutionMode → ConversationGrant → Fixed`：内层给出 `confirm`、`context.conversationId` 存在、且 `ToolGrantStore.isGranted()` 为真时，改写为 `{effect:"allow", ruleId:"conversation-grant:<tool>:<scopeKind>:allow"}`；内层给出 `deny` 或 `allow` 时原样透传。`ruleId` 不含 `scopeValue`，具体作用域由审计事件的 `grantScope` 与 `argumentsDigest` 定位。

`AuthorizedToolExecutor`：`createApproval()` 调 `deriveGrantOptions()` 填充新的 `grantOptions`；新增 `applyToolGrant(pending, resolution)`，在批准且带 `grant` 时写入授权，与 `applyWorkspaceGrant()` 对称。`ToolAuditEvent` 的 `interaction.resolution` 变体增加可选 `grantScope`，不新增事件类型。

`InteractionBroker`：`ToolApprovalInteraction` 增加 `grantOptions`；`ToolApprovalResponse` 增加可选 `grant`；`isValidResponse()` 增加校验——`grant` 只允许与 `decision: "approve"` 同时出现，且必须与该交互 `grantOptions` 中的某一项全等；`isSameDecision()` 把 `grant` 纳入比较，使幂等重放与冲突判定仍然正确。

### Agent Loop

`src/agent-loop.ts` 新增一个端口，Loop 不感知存储：

```ts
export interface SteeringSource {
  take(step: number): Promise<readonly SteeringMessage[]>;
}
export interface SteeringMessage {
  readonly seq: number;
  readonly content: string;
}
```

`RunAgentOptions` 与 `AgentLoopOptions` 增加可选 `steeringSource`。`runEventLoop` 在 `yield stepStarted(...)` 之后、`createProviderRequest(...)` 之前，且 `forcesFinalAnswer` 为假时，`await steeringSource?.take(stepNumber)`，对每条消息 `transcript.push({role:"user", content})` 并 `yield eventFactory.steeringApplied(stepNumber, seq, content)`。`take()` 抛错时 Run 按现有规则失败，不静默丢消息。

`src/agent-events.ts` 新增 `AgentEventType.SteeringApplied = "steering.applied"`，数据为 `{messageSeq, content}`，是一个 `StepEventBase` 事件；`isTerminalAgentEvent` 不变。

### 应用层

转向消息用内存队列，新增 `src/application/run-steering-queue.ts`，与 `InteractionBroker`、`InMemoryWorkspaceGrantStore` 同层同理由——Run 是进程内的，重启后 `recoverStaleRuns()` 会把 running Run 标成 failed，没有任何转向状态需要跨重启存活：

- `enqueue(runId, content)`：校验单条字节上限与未送达条数上限，返回递增的 `seq`。活跃 Run 的判定由 `ConversationService` 先按 `conversations.active_run_id` 做，队列本身只按 `runId` 管数据。
- `take(runId, step)`：取走该 Run 当前全部未送达消息并按 `seq` 升序返回，取走即出队，不存在重复送达。
- `dispose(runId)`：Run 终态时清除该 Run 的队列。

`ConversationRunService` 为每个 Run 构造一个绑定 `runId` 的 `SteeringSource` 适配器传给 `runAgentEvents`，并在终态回调里 `dispose`。

读出面走投影：`ConversationStore` 增加 `listRunSteeringMessages(runId)`，实现为 `SELECT seq, message_json FROM transcript_messages WHERE run_id = ? AND role = 'user' AND seq > 0 ORDER BY seq`。不复用 `loadRunTranscript()`——那会为取两条短消息把整段（上限 16 MiB）transcript 读进内存；会话详情里的多个 Run 用一次 `run_id IN (...)` 批量查，避免按 Run 逐条查询。

`ConversationService` 用该投影填充读出模型，并在 `deleteConversation` 时调用 `ToolGrantStore.clear()`。

领域类型（`src/domain/conversation.ts`）：`ConversationRunView` 增加 `steeringMessages: readonly RunSteeringMessageView[]`（`{seq, content}`，全部为已送达，因此不带状态字段）；新增领域错误 `ConversationIdleError`、`SteeringRunMismatchError`、`SteeringQueueFullError`。

### HTTP

新增一条路由，注册进 `AgentController` 的 `isAgentApiPath` 白名单：

| 方法与路径 | 请求 | 响应 |
|-|-|-|
| `POST /v1/agent/conversations/:id/runs:steer` | `{runId: string, input: string}` | 202 `{runId, seq, status: "queued"}` |

授权没有任何专属路由：创建走已有的 `:respond`，既没有读出接口也没有撤销接口。

`runs:steer` 的错误映射：会话不存在 404 `CONVERSATION_NOT_FOUND`；无活跃 Run 409 `CONVERSATION_IDLE`；`runId` 与活跃 Run 不符 409 `STEERING_RUN_MISMATCH`（防止把消息插进用户没在看的那个 Run）；未送达超过 4 条 409 `STEERING_QUEUE_FULL`；正文超 16 KiB 或空 422 `INVALID_REQUEST`。该路由复用 `evaluateFullAccessRequest()`：转向消息是被模型当作用户指令执行的输入，在 `full_access` 会话上必须与发起 Run 同等的 loopback 与 Origin 要求。

`interaction-routes.ts` 的 `interactionResponseSchema` 从 `{response:{decision}}` 扩为 `{response:{decision, grant?}}`，`grant` 为 `{kind:"tool"}` 或 `{kind:"command_prefix", value:string}`；不合法的组合由 Broker 返回 `invalid_response`，映射照旧 422。

`runs:stream` 的请求 schema、SSE 输出机制、409 `CONVERSATION_BUSY` 语义都不变：转向是一条独立请求，事件仍然只从已建立的那条流出去。

### Web

- `run-client.ts`：新增 `steerConversationRun()`；`respondToInteraction()` 增加可选 grant 参数；`events.ts` 解析 `steering.applied` 与 `grantOptions`；会话解析函数补 `steeringMessages`。
- `ConversationComposer`：`status === "running"` 时输入框保持可用，主按钮变为「插话」并调用 `onSteer`，「停止」按钮同时保留；待审批状态下显示「将在当前确认处理后生效」。
- 新增 `pending-interactions.ts`：纯选择器，从当前活跃 Turn 的 `RunState.steps` 收集待处理交互，输出带 step 与 kind 的列表；Turn 不在 running 时返回空。与 `run-state.ts`、`project-open-state.ts` 同为可单测的纯模块。
- 新增 `components/PendingInteractionDock.tsx`：渲染在 `App.tsx` 里 `ConversationComposer` 之前、滚动容器之外；每项带「STEP n · 工具名」标签，复用 `ToolApprovalCard` 与 `WorkspaceGrantCard`。
- `ToolApprovalCard`：增加参数展示（轨迹外渲染时必需）；「允许一次」旁按 `grantOptions` 顺序渲染「本会话内允许 `npm test`」这类按钮，`{kind:"tool"}` 渲染为「本会话内允许所有 bash」。两张卡片的外边距与圆角由调用方给出，卡片自身只保留边框与底色，使其在轨迹内和固定区域内都能正确排版。
- `RunTrace`：待处理的审批与文件授权改为一行指向固定区域的提示；已响应、已过期的卡片保持原样渲染。自动展开外层 `<details>` 的行为保留，用于提供上下文。
- `useConversationRun`：返回 `pendingInteractions`，由它持有活跃 Turn 的判定，避免 `App.tsx` 重新推导。
- `RunTrace` / `run-state.ts`：`StepTrace` 增加转向消息列表，reducer 处理 `steering.applied`，在对应步内按注入顺序渲染。
- 刷新恢复：授权与已送达的转向消息来自会话读出接口，因此刷新后可见。未送达的消息不在服务端，由 `useConversationRun` 在 Run 终态时比对「已 202 的 steer 请求」与「已收到的 `steering.applied`」，把没生效的文本放回输入框并提示。

### 诊断 CLI

`diagnose-conversation.ts` 的 `diagnosticVersion` 从 4 升到 5。默认输出对每个 Run 增加转向消息条数与总字节数（从 `transcript_messages` 投影，全部为已送达），不输出消息正文；`--include-content` 才输出正文。授权不进入诊断输出：它在内存里，而该命令以只读模式打开 SQLite，进程外看不到授权状态。

### 测试

| 文件 | 覆盖 |
|-|-|
| `test/tool-grants.test.ts`（新增） | 候选派生：`npm test -- x` → `[npm test, npm, tool]`；`rg -n foo` → `[rg, tool]`；`zsh -c …` → `[tool]`。匹配：词元前缀命中、`npm testx` 不命中、11 个元字符逐个使命中失效 |
| `test/tool-permissions.test.ts` | 授权把 `confirm` 变 `allow`；授权不能把 `deny` 变 `allow`；`isVisible` 用空 input 时不崩；`full_access` 下授权不改变结果 |
| `test/tool-grant-store.test.ts`（新增） | 重复授予幂等；作用域不跨 Conversation；`clear` 后不再命中 |
| `test/interaction-broker.test.ts` | `grant` 与 `deny` 同时出现被拒；`grant` 不在 `grantOptions` 内被拒；带同一 grant 重放为 `idempotent`、换 grant 为 `conflict` |
| `test/agent-loop.test.ts` | 步边界注入顺序；强制交接步不取消息；`take()` 抛错时 Run 失败；多条消息按 seq 追加 |
| `test/conversation-run-service.test.ts` | 非活跃 Run 的 steer 被拒；Run 终态后队列被 `dispose` |
| `test/context-compactor.test.ts` | 覆盖范围内的转向消息原样保留、不进摘要输入；Provider 视图段序正确 |
| `test/run-steering-queue.test.ts`（新增） | 超字节上限被拒；队列满被拒；`take` 取走即出队、二次 `take` 为空；`dispose` 后不再返回 |
| `test/sqlite-conversation-store.test.ts` | `listRunSteeringMessages` 只投影 `seq > 0` 的 user 消息，不含原始输入、摘要与工具消息 |
| `test/server.test.ts` | 两条新路由的状态码与错误码；`full_access` 下非 loopback 的 `runs:steer` 被拒 |
| `web/src/pending-interactions.test.ts`（新增） | 跨 step 按轨迹顺序收集；已响应与已过期不计入；Turn 非 running 时为空 |
| `web/src/components/PendingInteractionDock.test.ts`（新增） | 无待处理项时不渲染；展示 step、工具名与待执行命令；提交失败信息落在卡片上 |
| `web/src/components/RunTrace.test.tsx` | 待处理审批只留指向提示、不渲染按钮与 risk 文案；已响应审批仍在工具卡片内 |
| Web | composer 运行中提交走 steer；审批卡片按 `grantOptions` 渲染；reducer 处理 `steering.applied` |

## 保持不变

- Sandbox 边界、Seatbelt profile、资源配额与进程收容。授权只跳过确认交互。
- `full_access` 的语义与创建时的一次性确认。该模式本来全 allow，授权对它没有影响。
- canonical transcript 的四种消息类型。转向消息是一条普通 user 消息，不新增类型、不新增 `transcript_messages` 的列。
- canonical transcript 里 `seq > 0` 的 user 消息只可能是转向消息。读出投影依赖这条不变式，因此它是本方案固定下来的约束：以后再有功能要往 canonical transcript 追加 user 消息，必须同时给出区分手段，不能默认沿用投影。
- 一个 Conversation 一个活跃 Run，以及并发发起 Run 的 409。转向不是第二个 Run。
- `turns.user_message` 仍是单列单值，仍只保存发起该 Turn 的那条输入。
- `maxSteps` 预算、强制交接步机制、`MAX_TOOL_CALLS_PER_BATCH`、并行只读工具集合。
- `workspace_grant` 的一次性文件授权链路。它与工具授权是两个独立机制：前者授权一个 canonical path 的一次读取，后者免除一类调用的确认。
- 工具结果的不可信定位与 Skill 指令边界。授权与转向都不能由模型自己产生。
- CLI（`src/index.ts`）不接入这两个能力：它没有 conversationId，也没有接收运行期输入的通道。`createTranscriptWindow()` 这条无 ContextBuilder 的路径不变。
- 数据库 schema。本方案不新增表、不新增列、不改约束与索引，因此也不涉及重建 `.data/agent-harness.sqlite`。
- 进程重启的既有语义：`recoverStaleRuns()` 把 running Run 标成 failed。授权与转向队列都在内存里，随进程一起消失，重启后没有任何遗留的权限或队列状态。

## 验收

1. 在 `workspace_sandbox` 会话里让 agent 连续跑 5 条 `npm`/`git` 命令，第一次确认时选前缀授权，其后 4 条无确认直接执行；SSE 上只出现 1 个 `interaction.required`。
2. 同一会话里出现一条含 `;` 或 `|` 的命令，仍然停下来等确认。
3. 在另一个指向同一 workspace 的会话里发同类命令，仍然要求确认。
4. Run 运行到第 6 步时插一句话，第 7 步的 `steering.applied` 出现在流里，且模型后续行为反映该指令；Run 不重启，Turn 数量不变。
5. 待审批状态下插话，消息进入队列不立即生效；响应审批后在下一步生效。
6. 压缩触发后，转向消息在 Provider 视图里原样存在（用 `--include-content` 诊断核对）。
7. 刷新页面，已送达的转向消息仍可见。
8. 在 Run 即将结束时插话，若消息未生效，文本回到输入框并给出提示，不产生「已排队但无处可查」的状态。
9. 重启服务端后，同类命令重新要求确认，没有遗留的转向队列。
10. 一个已有几十步轨迹的 Run 触发审批时，不展开「运行过程」、不滚动对话记录，就能在输入框上方看到待执行命令与全部作用域按钮；响应后该卡片消失，轨迹里留下「已允许」的历史。
