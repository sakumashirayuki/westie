# 跨 Run 上下文压缩

会话进行到第二、三轮时，Provider 输入里的历史会整段消失。`ContextBuilder` 拼装历史前缀时，只要最近一个已完成 Run 的 transcript 装不下剩余预算，它和它之前的全部历史一起被丢弃，过程没有事件、没有日志、没有持久化记录。自举级别的开发轮次动辄产生几百 KB transcript，所以「第二轮忘记第一轮做了什么」是这套实现下的常态。

本方案给历史前缀补一个中间档：装不下原文的历史 Run 压成一条摘要，仍然进入 Provider 输入。改动点是 Agent Loop 每步都会调用的 `buildContext` 这一环，Loop 的其他环节不变。

## 当前实现

每个 Run 开始时，`ConversationRunService` 取该 Conversation 最近 20 个已完成 Turn 的最后一次成功 Run（`src/application/conversation-run-service.ts:94`），按 `turns.position DESC` 排序，最新在前。每条候选记录只有三个字段：`runId`、`messageCount`、`transcriptBytes`。

`ContextBuilder` 先构造当前 Run 的视图并算出它的 `baseTokens`，再用剩余预算从最新到最旧遍历候选（`src/application/context-builder.ts:228`）：

1. 快速预检：`baseTokens + transcriptBytes` 达到 `inputTokenLimit`，或 `transcriptBytes` 超过 `maxHistoryTokens`，`break`；
2. 加载该 Run 的完整 transcript，与已选历史拼在一起精算；
3. 精算结果达到 `inputTokenLimit` 或历史增量超过 `maxHistoryTokens`，`break`；
4. 通过则把它放到已选历史最前面，继续下一个更旧的 Run。

`inputTokenLimit` 等于 `contextWindowTokens - maxOutputTokens - max(2048, 5% × contextWindowTokens)`，token 数按 UTF-8 字节保守估算。历史的粒度是「整个 Run 的原文」，取值只有纳入和不纳入两种。

当前 Run 内部另有一套压缩：`ContextCompactor` 在请求达到硬上限 80% 时，把足够早的完整工具对压成累计摘要，目标降到 60%，摘要落在 `run_context_compactions` 表，投影形状是「原始用户输入 + 累计摘要 + 受保护 Skill 组 + 近期原文后缀」。

## 存在的问题

**历史整段清零。** 遍历从最新开始，第一个装不下的候选往往就是最新那个 Run，一次 `break` 之后所有更旧的历史一起消失。历史只有原文一档，一个 300 KB 的历史 Run 里真正需要跨轮携带的事实——改了哪些文件、命令输出的结论、还没做完的事——通常几 KB 就能表达，当前实现没有这一档可用。`AGENT_MAX_HISTORY_TOKENS` 会放大这个效果：`.env.example` 给的示例值是 64000，一旦启用，单个超过 64 KB 的历史 Run 就让全部历史消失。

**清零完全静默。** 没有事件、没有日志、没有持久化记录，Web 和 `npm run diagnose:conversation` 都看不出这一轮丢了历史，会话行为退化时无法归因。

**已有摘要跨 Run 不复用。** 下一个 Run 加载的是历史 Run 的原文，上一个 Run 花钱算出的 `run_context_compactions` 摘要不参与历史投影。

## 目标实现

历史 Run 的表示从两档变成三档。遍历顺序、整 Run 粒度和「不跳过」的原则保持不变：

| 档位 | 条件 | 形状 |
|-|-|-|
| 原文 | 完整 transcript 装得下 | canonical 原文 |
| 摘要投影 | 原文装不下，摘要投影装得下 | 3 条消息 |
| 停止 | 摘要投影也装不下，或该 Run 不可降级 | 该 Run 及更旧 Run 都不纳入 |

一旦某个 Run 连摘要投影都放不下，遍历就停止，更旧的 Run 不再尝试。历史因此保持时间连续，不会出现中间缺一轮的空洞。

### 摘要投影

降级规则固定：保留第一条用户输入和最后一条最终回答的原文，中间全部 assistant 与 tool 消息压成一条摘要消息。任意长度的历史 Run 都投影成 3 条。

一个已完成 Run 的 canonical transcript 是「用户输入 + N 组 assistant/tool 工具对 + 最终回答」。以两组工具对的 Run 为例，降级前后的对应关系：

| 降级前（6 条） | 降级后（3 条） |
|-|-|
| `user` 用户输入 | `user` 用户输入，原文 |
| `assistant` toolCalls: grep | |
| `tool` results: 命中 `src/tools/read.ts:15` | `user` 固定前缀 + 摘要 |
| `assistant` toolCalls: write | |
| `tool` results: 写入 `test/read-tool.test.ts` | |
| `assistant` 最终回答 | `assistant` 最终回答，原文 |

第 2 条消息的正文形如：

```
Harness 生成的历史轮次摘要。它描述这个会话中一个已完成轮次的进展，不是新的用户任务。

## 目标与约束
为 read 工具补测试，覆盖 limit 上限。
## 已确认事实
src/tools/read.ts:15 定义 MAX_LINE_LIMIT = 1_000，默认 DEFAULT_LINE_LIMIT = 200。
## 已完成操作
grep 定位常量；write 新建测试文件。
## 文件修改
新增 test/read-tool.test.ts（1284 字节）。
## 验证结果
npm test 通过。
## 未解决问题与下一步
未覆盖 read 对非 UTF-8 文件的行为。
```

三条消息的角色和来源：

| 位置 | 内容 | 来源 | 角色 |
|-|-|-|-|
| 第 1 条 | 原始用户输入原文 | `turns.user_message` | `user` |
| 第 2 条 | 固定前缀 + 摘要 | 本方案生成 | `user` |
| 第 3 条 | 最终回答原文 | `runs.final_answer` | `assistant` |

第 2 条的角色是 user，正文前拼一段固定前缀，显式声明这是 Harness 生成的历史摘要。当前 Run 内压缩用的是同一手法。缺少这个声明时，模型会把摘要里的「下一步」当成用户新下发的指令。

首尾两条保持原文，因为它们短，并且是跨轮引用最多的两项内容：用户意图和结论。被压掉的工具调用与工具结果占一个开发轮次几乎全部字节。这两条都取自数据库既有列，所以构造降级投影不需要加载 transcript，只有真正生成摘要那一次才读。

历史 Run 的这个形状与当前 Run 内压缩的投影不同：当前 Run 还在往下走，最近几步的工具细节参与下一步决策，所以保留原文后缀和最新一次成功的 Skill 组；历史 Run 已经结束，只有结论跨轮有用，摘要一次写定后不再变化。

### 摘要的生成与失败处理

摘要惰性生成、持久化、进程内缓存，一个 Run 一条。已完成 Run 的 transcript 不再变化，所以摘要不会过期，生成一次永久复用。生成前有三道闸门：

1. `messageCount` 不超过 2 的 Run 不生成摘要。这种 Run 只有用户输入和最终回答，没有工具步骤，原文已经是最小形态，直接停止遍历。
2. 用 16 KiB（`MAX_CONTEXT_SUMMARY_BYTES`）占位串预演摘要投影，装不下就停止，不付摘要的钱。摘要实际字节数不超过该上限，占位演算通过即保证真实投影装得下。
3. 每次 `buildContext` 最多生成 1 条新摘要。`buildContext` 在每个模型步骤前都会调用，所以同一个 Run 内的后续步骤会继续把更旧的 Run 逐条补齐，单步不会连锁触发多次 Provider 调用。已持久化或已缓存的摘要不受这条限制。

摘要调用沿用当前 Run 压缩的约束：同一个 Provider、`tools: []`、最多 2048 输出 token、同一个 `AbortSignal`，不产生公开流式事件，不计入 `maxSteps`。

历史前缀是可选层，它的失败不终止 Run。摘要生成失败——Provider 报错、返回工具调用、空摘要、超过 16 KiB——时，该 Run 及更旧 Run 本次不纳入历史，记录停止原因，Run 继续执行。`AbortSignal` 已取消时抛出取消原因，与现有行为一致。当前 Run 视图的压缩失败仍然是致命错误，继续返回 `CONTEXT_COMPACTION_FAILED`；不可压缩的固定层超限仍返回 `CONTEXT_LIMIT_EXCEEDED`。

## 具体改动

### 改动范围

Agent Loop 每个模型步骤前都会调一次 `buildContext`。本方案改的就是这一环的逻辑：历史前缀怎么拼。取工具、执行工具、追加 canonical transcript、`maxSteps` 判定这些环节和事件协议、transcript schema 都不动。

`buildContext` 的实现分布在 `src/application/`：`context-builder.ts` 承载三档降级，新增 `run-history-summarizer.ts`（一个已完成 Run 压成一条摘要）和 `summary-request.ts`（Provider 摘要调用的共享守卫，`context-compactor.ts` 改为复用它）。为此 `conversation-store.ts` 的端口加 3 个字段和 1 个方法，SQLite 侧加一张表和一处 LEFT JOIN，`conversation-run-service.ts` 只做装配，`diagnose-conversation.ts` 加一个诊断字段。不新增 SSE 事件，不新增 ToolResult 错误码。

### 数据库

当前 schema 有 5 张表和 1 个索引：`conversations`（7 列）、`turns`（7 列）、`runs`（13 列）、`transcript_messages`（4 列）、`run_context_compactions`（5 列），索引 `conversations_updated_at_id_idx`。目标 schema 有 6 张表和同一个索引，新增 `run_history_summaries`（4 列）。既有 5 张表的列、主键、外键、CHECK、UNIQUE 和索引全部不变。

```mermaid
erDiagram
  conversations ||--o{ turns : "conversation_id → conversations.id, CASCADE"
  conversations |o--o| runs : "active_run_id → runs.id, SET NULL"
  turns ||--o{ runs : "turn_id → turns.id, CASCADE"
  runs ||--o{ transcript_messages : "run_id → runs.id, CASCADE"
  runs ||--o{ run_context_compactions : "run_id → runs.id, CASCADE"
  runs ||--o| run_history_summaries : "【新增表】run_id → runs.id, CASCADE"

  conversations {
    TEXT id PK
    TEXT active_run_id FK
  }
  turns {
    TEXT id PK
    TEXT conversation_id FK
    TEXT user_message "降级投影第 1 条消息的来源"
    TEXT status "只取 completed"
  }
  runs {
    TEXT id PK
    TEXT turn_id FK
    TEXT status "只取 completed"
    TEXT final_answer "降级投影第 3 条消息的来源"
    INTEGER message_count "判定该 Run 能否降级"
    INTEGER transcript_bytes "原文档位预检"
  }
  transcript_messages {
    TEXT run_id PK, FK
    INTEGER seq PK
  }
  run_context_compactions {
    TEXT run_id PK, FK
    INTEGER position PK
  }
  run_history_summaries {
    TEXT run_id PK, FK
    TEXT summary_text "新增, NOT NULL, trim 后非空, Markdown 纯文本"
    INTEGER summary_bytes "新增, NOT NULL, > 0 且 <= 16384"
    TEXT created_at "新增, NOT NULL, ISO 8601"
  }
```

图中既有表只画出主键、外键和本方案读取的列，它们的列定义没有任何增删改；`run_history_summaries` 列出全部 4 列，`run_id` 一行显示键类型，其余三列标注「新增」和各自约束。

```sql
CREATE TABLE IF NOT EXISTS run_history_summaries (
  run_id TEXT PRIMARY KEY
    REFERENCES runs(id) ON DELETE CASCADE,
  summary_text TEXT NOT NULL
    CHECK (length(trim(summary_text)) > 0),
  summary_bytes INTEGER NOT NULL
    CHECK (summary_bytes > 0 AND summary_bytes <= 16384),
  created_at TEXT NOT NULL
) STRICT;
```

主键 `run_id` 表达「一个 Run 最多一条历史摘要」，与 `run_context_compactions` 的 `(run_id, position)` 累计多条形成对照。外键 `run_id` → `runs(id)` 带 `ON DELETE CASCADE`，删除会话经 `turns`、`runs` 级联清除摘要，删除逻辑不需要改。没有额外索引，因为只按主键单点查询，以及在 `listRecentCompletedRuns` 里以 `run_id` 做 LEFT JOIN。

`summary_text` 是普通 Markdown 文本，数据库不校验其结构。16384 的上限由 `summary_bytes` 的 CHECK 表达，与 `MAX_CONTEXT_SUMMARY_BYTES` 一致；`summary_bytes` 显式存 UTF-8 字节数供选择阶段预检，不用 SQLite `length()` 推导，因为它对 TEXT 返回字符数。`created_at` 是 ISO 8601 字符串，与其他表一致。

本项目是 MVP，不提供 schema migration。应用改动后停止服务，删除 `.data/agent-harness.sqlite` 及同名 `-wal`、`-shm` 文件，重启服务重建当前 schema。

### 端口与查询

`CompletedConversationRunSummary` 从 3 个字段扩到 6 个：

| 字段 | 类型 | 来源 | 用途 |
|-|-|-|-|
| `runId` | string | `runs.id` | 既有 |
| `messageCount` | number | `runs.message_count` | 既有，判定该 Run 能否降级 |
| `transcriptBytes` | number | `runs.transcript_bytes` | 既有，原文档位预检 |
| `userMessage` | string | `turns.user_message` | 新增，降级投影第 1 条 |
| `finalAnswer` | string | `runs.final_answer` | 新增，降级投影第 3 条 |
| `historySummary` | string 可选 | `run_history_summaries.summary_text` | 新增，缺失表示还没生成过 |

`runs` 的 CHECK 保证 `status = 'completed'` 时 `final_answer`、`message_count`、`transcript_bytes` 都非空。最多 20 条候选、每条摘要不超过 16 KiB，所以摘要正文随查询一起取出，不再单独加一个读取端口。

`listRecentCompletedRuns` 在现有查询上只做加法，`FROM`、`INNER JOIN` 子查询、`WHERE`、`ORDER BY turns.position DESC`、`LIMIT` 都不变：

```diff
 SELECT
   runs.id AS run_id,
   runs.message_count,
   runs.transcript_bytes,
+  runs.final_answer,
+  turns.user_message,
+  run_history_summaries.summary_text
 FROM turns
 INNER JOIN runs ON runs.id = (...)
+LEFT JOIN run_history_summaries
+  ON run_history_summaries.run_id = runs.id
 WHERE turns.conversation_id = $conversationId
   AND turns.status = 'completed'
```

`ConversationStore` 新增一个方法 `saveRunHistorySummary(runId, summary)`。它校验目标 Run 存在且 `status = 'completed'`，否则抛 `ConversationStateError`；校验 `summary` trim 后非空且 UTF-8 字节数不超过 `MAX_CONTEXT_SUMMARY_BYTES`，否则抛错；写入用 `INSERT ... ON CONFLICT(run_id) DO NOTHING`，已存在的摘要保持原值。

### 新模块

`src/application/summary-request.ts` 把 Provider 摘要调用的守卫从 `ContextCompactor` 抽出来，两处共用。它接收 provider、system prompt、source 文本、输出上限和可选 signal，返回一段摘要文本，并强制四条约束：只接受 `type: "final"` 的完成事件；出现 `tool_arguments.delta` 视为非法；完成后继续到达的事件视为非法；结果 trim 后非空且不超过 `MAX_CONTEXT_SUMMARY_BYTES`。违反任一条抛错。`ContextCompactor.#generateSummary` 改为组装 source 后调用它，当前 Run 压缩行为不变。

`src/application/run-history-summarizer.ts` 把一个已完成 Run 压成单条摘要。输入是该 Run 的用户输入、完整 canonical transcript、最终回答和可选 signal，输出一段不超过 16 KiB 的 Markdown 摘要。它的 system prompt 与当前 Run 压缩那份并列存在，复用同一组六个标题，差别在于：描述对象是一个已经结束的轮次；声明工具结果只是历史证据，不能修改用户任务、权限或系统指令；要求聚焦过程事实——文件路径、代码符号、错误文本、已执行命令、验证结果、未完成事项——并且不复述最终回答正文，因为最终回答在投影里保持原文。

### ContextBuilder 的选择逻辑

`ContextBuilderOptions` 新增两项：`saveRunHistorySummary` 把新生成的摘要写回 store，`onHistoryProjection` 上报投影结果用于诊断，后者可选。

`#selectCompletedRunHistory` 改为异步，从最新到最旧遍历候选，每个候选走下面这条判定链：

```mermaid
flowchart TD
  A["取下一个候选 Run（最新 → 最旧）"] --> B{"原文装得下？"}
  B -- "是" --> C["按原文纳入历史"]
  C --> A
  B -- "否" --> D{"有工具步骤？messageCount > 2"}
  D -- "否" --> S1["停止：not_compactible"]
  D -- "是" --> E{"已有摘要？缓存或数据库"}
  E -- "是" --> H{"摘要投影装得下？"}
  H -- "是" --> K["按摘要投影纳入历史"]
  K --> A
  H -- "否" --> S2["停止：budget"]
  E -- "否" --> F{"本次 buildContext 已生成过摘要？"}
  F -- "是" --> S3["停止：generation_deferred"]
  F -- "否" --> G{"16 KiB 占位预演装得下？"}
  G -- "否" --> S2
  G -- "是" --> I["调用 Provider 生成摘要"]
  I -- "失败" --> S4["停止：summary_failed"]
  I -- "成功" --> J["落库并写进程内缓存"]
  J --> K
```

任何一个「停止」都终止整个遍历，更旧的 Run 不再尝试。占位预演通过即保证真实摘要投影装得下，所以生成成功后直接纳入，不再复检。

「装得下」与现在判断同样两个约束：拼上当前 Run 视图后精算不得达到 `inputTokenLimit`，历史增量不得超过 `maxHistoryTokens`。`transcriptBytes` 的快速预检保留，作用从 `break` 改为进入降级分支。取消检查放在循环体首部和摘要生成前后。

摘要缓存放在 `#historySummaryCache`，因为 `completedRuns` 是 Run 开始时的快照，本 Run 内新生成的摘要不会出现在里面。

### 诊断可见性

投影发生降级或停止时，向 stderr 写一行 JSON，形式与 `src/tool-permissions.ts:190` 的审计日志一致，不新增日志基础设施：

```json
{"event":"context.history_projection","runId":"...","candidates":7,"raw":2,"summarized":1,"dropped":4,"generated":1,"stopReason":"budget"}
```

只在确实有降级或丢弃时输出，并且在同一个 `ContextBuilder` 实例内按记录内容去重，避免每个模型步骤重复刷同一行。日志只含 ID 和计数，不含摘要正文或消息内容。

`npm run diagnose:conversation` 增加 `run_history_summaries` 查询，每个 Run 多一个字段，没有摘要时为 `null`：

```json
"historySummary": { "bytes": 2841, "createdAt": "2026-08-18T07:12:44.108Z" }
```

`--include-content` 时额外带 `summaryText`，`diagnosticVersion` 从 3 升到 4。现有的 `--include-content` 警告文案已经涵盖 context summaries，不改。

`ConversationRunService` 构造 `ContextBuilder` 时传入 `saveRunHistorySummary`（转发到 store）和 `onHistoryProjection`（写 stderr JSONL）。

## 保持不变

canonical transcript 始终完整，压缩只改变 Provider 输入投影。当前 Run 的压缩触发比例、目标比例、完整工具对边界、Skill 保护组和 `run_context_compactions` 的累计语义都不动，Skill 保护仍然只作用于当前 Run——历史 Run 的摘要不保留 Skill 原文，当前 Run 需要时重新调用 `skill(name)`。

历史仍是整 Run 粒度，不按消息切分一个历史 Run，仍从最新到最旧、不跳过中间 Run。`maxConversationTurns` 默认 20，`AGENT_MAX_HISTORY_TOKENS` 仍然只进一步限制历史部分，现在同时约束原文与摘要投影。token 估算仍按 UTF-8 字节保守计算。

## 验收

`test/context-builder.test.ts` 覆盖降级行为：

1. 最新 Run 原文超预算时降级为 3 条摘要投影，更旧的 Run 仍按原文纳入；
2. `historySummary` 已存在时直接复用，Provider 不被调用；
3. 单次 `buildContext` 最多生成 1 条摘要，同一 Run 的下一个步骤继续降级更旧的 Run；
4. 摘要投影仍装不下时停止，且不跳过去纳入更旧 Run；
5. `messageCount` 不超过 2 的 Run 不生成摘要，直接停止；
6. 摘要生成失败时历史截断到该点，`buildContext` 正常返回，不抛 `ContextCompactionFailedError`；
7. 已 abort 时不调用 Provider 并抛出取消原因；
8. `maxHistoryTokens` 同时约束原文与摘要投影；
9. 生成的摘要只保存一次，同 Run 后续步骤不重复写库。

既有用例 `does not skip an oversized newest run to include older history` 的语义改为「降级而不跳过」，并断言更旧 Run 的 transcript 不被加载。

新增 `test/run-history-summarizer.test.ts` 和 `test/summary-request.test.ts`：source 组装包含用户输入、历史消息和最终回答；非 final 完成、出现 `tool_arguments.delta`、空摘要、超 16 KiB 分别抛错；`signal` 透传；`ContextCompactor` 改用共享守卫后行为不变。

`test/sqlite-conversation-store.test.ts` 覆盖 `saveRunHistorySummary` 正常落库、重复写入保留首条、非 completed Run 抛 `ConversationStateError`、空或超长摘要抛错、`listRecentCompletedRuns` 返回新增三个字段、删除会话级联清除摘要。`test/sqlite-schema.test.ts` 覆盖新表的 4 列、主键、外键和 CHECK。`test/diagnose-conversation.test.ts` 覆盖默认输出含字节数与创建时间且不含正文、`--include-content` 含正文、`diagnosticVersion` 为 4。

手工验收按顺序执行：

1. 停服，删除 `.data/agent-harness.sqlite` 及 `-wal`、`-shm`，`npm run build && npm run start:server`；
2. 以本仓库为 workspace 建会话，连续三轮制造大 Run，例如让它 grep 全仓、读多个源文件、跑 `npm test`；
3. 第三轮的 stderr 出现 `context.history_projection`，`summarized` 至少为 1，`dropped` 明显小于降级前；
4. 第三轮追问「上一轮你改了哪些文件、验证结果是什么」，回答与实际一致；
5. `npm run diagnose:conversation -- <id>` 看到对应 Run 的 `historySummary.bytes`，加 `--include-content` 能读到摘要正文；
6. `npm run check && npm test` 全绿。

## 未纳入范围

Subagent；把一个历史 Run 按消息级切分后部分纳入；token 估算精度改进；跨 Conversation 的记忆或摘要复用；摘要的失效与重算——已完成 Run 的 transcript 不变，一条摘要写定后不重算。
