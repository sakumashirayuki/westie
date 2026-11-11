# Token 用量计量

一次自举级别的开发会话会把额度打空，事后无法回答三个问题：钱花在哪个 Conversation、哪个 Run、哪一步；失败的 Run 烧掉了多少；上下文摘要这类 Harness 自己发起的调用占多大比例。原因是整条链路没有任何一处读取 Provider 返回的 usage，数据库里也没有承载它的列。

本方案把每一次 Provider 调用的真实 token 用量取回来，按调用粒度落库，并在流式事件、会话读出接口、诊断 CLI 和 Web 上暴露。改动集中在 Provider 边界、Agent Loop 的 turn 完成点和终态持久化三处，Agent Loop 的执行语义、上下文压缩策略和 canonical transcript 不变。

## 当前实现

### Provider 层

`ProviderStreamEvent` 有三种形态：`output_text.delta`、`tool_arguments.delta` 和 `completed`，`completed` 只携带一个 `ProviderTurn`（`src/provider-protocol.ts:19`）。协议里没有承载 usage 的位置。

OpenAI 适配层在 `response.completed` 事件里只把 `completed` 置为 `true`（`src/providers/openai.ts:171`），`event.response.usage` 被丢弃。

DeepSeek 适配层自定义了一个窄化的 chunk 类型 `DeepSeekChatCompletionChunk`，只 pick 了 `delta` 和 `finish_reason` 两个字段（`src/providers/deepseek.ts:42`）；请求体也没有 `stream_options`，所以服务端在流式模式下根本不会返回 usage。流循环遇到 `choices` 为空的 chunk 直接 `continue`（`src/providers/deepseek.ts:147`），而 usage chunk 恰好就是 `choices` 为空的那一条。

### Agent Loop 与事件

`streamProviderTurn` 消费 Provider 流，只记录正文字节数用于大小上限判断，拿到 `completed` 后返回 turn（`src/agent-loop.ts:370`）。公开事件里 `step.completed` 只有 `actionType`，`run.completed` 只有 `steps` 和 `stopReason`，`run.error` 只有 `code` 和 `message`（`src/agent-events.ts`）。

### 摘要调用

除主循环外，一个 Run 还会发起两类额外的 Provider 调用，都经由 `generateProviderSummary`（`src/application/summary-request.ts:12`）：

- Run 内上下文压缩，由 `ContextCompactor` 发起，输入是本 Run 已产生的完整工具对，可达数百 KB；
- 跨 Run 历史摘要，由 `RunHistorySummarizer` 发起，输入是另一个已完成 Run 的整段 transcript。

这两类调用不计入 `maxSteps`，不产生公开流式事件，也没有任何记录。

### 存储与读出

`runs` 表当前有 13 个物理列：`id`、`turn_id`、`attempt`、`status`、`final_answer`、`message_count`、`transcript_bytes`、`error_code`、`error_message`、`internal_error`、`system_prompt`、`created_at`、`updated_at`（`src/infrastructure/sqlite/schema.ts:35`）。全库共 6 张表，没有任何一列与 token 相关。

终态写入集中在两处事务：`completeRun` 和 `failRun`（`src/infrastructure/sqlite/sqlite-conversation-store.ts:509`、`:599`），它们把 transcript 逐条插入 `transcript_messages`，把 `ContextBuilder` 累积的压缩记录插入 `run_context_compactions`，然后更新 `runs`、`turns`、`conversations`。压缩记录的传递方式是：`ContextBuilder` 内部累积，`ConversationRunService` 在 `beforeRunCompleted` / `beforeRunFailed` 回调里读 `contextBuilder.compactions` 并交给 Store（`src/application/conversation-run-service.ts:138`、`:149`）。

读出侧，`ConversationRunView` 有 6 个字段：`id`、`attempt`、`status`、`error?`、`createdAt`、`updatedAt`（`src/domain/conversation.ts`）。诊断 CLI 输出 `diagnosticVersion: 4`，按 Run 给出 transcript 字节、压缩摘要字节和历史摘要字节（`src/cli/diagnose-conversation.ts`）。

## 存在的问题

**用量数据从未离开 Provider 的响应。** 两个适配层各自丢弃 usage，且 DeepSeek 连请求参数都没开，所以这不是"存了但没展示"，而是根本没取。

**成本无法归因。** 现在能看到的最接近成本的量是 `transcript_bytes`，它既不区分输入输出，也不反映 cache 命中，更不包含摘要调用的输入。一个 300 KB transcript 的 Run 到底是 30 万还是 300 万输入 token，取决于每步重复注入的历史长度和 cache 命中率，从字节数推不出来。

**失败 Run 的花费彻底不可见。** 余额耗尽、`MAX_STEPS_EXCEEDED`、`CONTEXT_LIMIT_EXCEEDED` 这几类结局恰恰是花费最多的，而失败路径连 `message_count` 和 `transcript_bytes` 都是 NULL（`runs` 表的 CHECK 约束只允许 completed 状态写这两列）。

**Harness 自身的开销不可见。** 上下文压缩和历史摘要各自把几十到几百 KB 送进模型，这部分成本既不计步也不记账，无法判断压缩策略是省钱还是烧钱。

**cache 命中率不可见。** system prompt、AGENTS.md、Skill catalog 和工具 schema 每一步都重新拼装并整体重发，是否真的命中前缀缓存，当前无从验证。

**上下文预算的估算无法校准。** `ContextBuilder` 按 UTF-8 字节保守估算 token，中文和代码混排下这个估算与真实 token 数存在系统性偏差，但没有真实值可以对照。

## 目标实现

一个 Run 在其生命周期内发起的每一次 Provider 调用，都记为一行 `run_model_calls`。

### 一条记录长什么样

一个执行了两步、中间触发过一次 Run 内压缩的 Run，落库后是三行：

| run_id | seq | kind | step | model | input_tokens | cached_input_tokens | output_tokens | reasoning_tokens | created_at |
|-|-|-|-|-|-|-|-|-|-|
| 3f9…c1 | 0 | `step` | 1 | deepseek-v4-flash | 12480 | 10240 | 142 | 0 | 2026-08-19T07:12:03.114Z |
| 3f9…c1 | 1 | `context_compaction` | NULL | deepseek-v4-flash | 61230 | 0 | 870 | 0 | 2026-08-19T07:12:19.402Z |
| 3f9…c1 | 2 | `step` | 2 | deepseek-v4-flash | 21500 | 12288 | 96 | 0 | 2026-08-19T07:12:24.887Z |

对应的 `run.completed` 事件：

```json
{
  "v": 1, "runId": "3f9…c1", "seq": 27, "type": "run.completed",
  "data": {
    "steps": 2,
    "stopReason": "final",
    "usage": {
      "calls": 3, "unmeasuredCalls": 0,
      "inputTokens": 95210, "cachedInputTokens": 22528,
      "outputTokens": 1108, "reasoningTokens": 0
    }
  }
}
```

### 记账口径

四个计数器，语义与两个 Provider 的账单口径一致：

- `inputTokens`：本次调用的输入 token 总数，**包含**命中缓存的部分；
- `cachedInputTokens`：其中命中缓存的部分，是 `inputTokens` 的子集，恒 ≤ `inputTokens`；
- `outputTokens`：输出 token 总数，**包含**推理 token；
- `reasoningTokens`：其中的推理 token，是 `outputTokens` 的子集，恒 ≤ `outputTokens`。

映射关系：

| 字段 | OpenAI Responses | DeepSeek Chat Completions |
|-|-|-|
| `inputTokens` | `usage.input_tokens` | `usage.prompt_tokens` |
| `cachedInputTokens` | `usage.input_tokens_details.cached_tokens` | `usage.prompt_cache_hit_tokens`，缺失时 `usage.prompt_tokens_details.cached_tokens`，再缺失记 0 |
| `outputTokens` | `usage.output_tokens` | `usage.completion_tokens` |
| `reasoningTokens` | `usage.output_tokens_details.reasoning_tokens` | `usage.completion_tokens_details.reasoning_tokens`，缺失记 0 |
| `model` | `response.model` | chunk 的 `model`，缺失时回退到请求配置的 model |

不记录 `total_tokens`，它等于 `inputTokens + outputTokens`。

### 三类调用

`kind` 取三个值，覆盖一个 Run 能发起的全部 Provider 调用：

| kind | 发起方 | `step` 列 |
|-|-|-|
| `step` | Agent Loop 的模型步骤 | 该步的步号，≥ 1 |
| `context_compaction` | `ContextCompactor` 的 Run 内累计摘要 | NULL |
| `history_summary` | `RunHistorySummarizer` 的跨 Run 历史摘要 | NULL |

`history_summary` 归属发起它的当前 Run，不归属被摘要的那个历史 Run：花这笔钱的是当前 Run。

### 拿不到 usage 时

Provider 没有返回 usage，或返回的值不是非负安全整数、或违反子集关系（`cached > input`、`reasoning > output`），这一行仍然写入，四个 token 列一起记 NULL，并向 stderr 输出一行 `usage.invalid` JSONL 诊断（与已有的 `context.history_projection` 诊断同一形式）。调用发生过这个事实不会丢失，成本未知也不会被伪装成 0。汇总时这类调用只计入 `unmeasuredCalls`，不参与求和。

用量异常不会让 Run 失败：记账问题不应该毁掉一次已经成功的执行。

### 归属与生命周期

一个 Run 的用量记录由一个 `RunUsageLog` 收集：Agent Loop 在每次 turn 完成时记一条，`ContextBuilder` 在每次摘要调用返回时记一条，`seq` 由同一个计数器分配，因此顺序是真实的时间顺序。整批记录在终态事务（`completeRun` / `failRun`）里一次性写入，与 transcript、压缩摘要同一事务，语义与现有的 `contextCompactions` 完全一致。进程崩溃导致 Run 停留在 `running` 时用量记录丢失，这与当前 transcript 的丢失行为一致。

`runs` 表不加聚合列。求和用 `SUM` 现算，保持单一真相来源，避免双写漂移；本地 SQLite 规模下按 `run_id` 主键前缀扫描足够。

## 具体改动

### 1. Provider 协议

`src/provider-protocol.ts` 新增类型和一个校验函数：

```ts
export interface ProviderUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export function validateProviderUsage(
  usage: ProviderUsage | undefined,
): ProviderUsage | undefined;
```

`validateProviderUsage` 返回 `undefined` 表示不可用：`model` 为空、任一计数不是非负安全整数、`cachedInputTokens > inputTokens` 或 `reasoningTokens > outputTokens`。

`ProviderStreamEvent` 的 `completed` 分支增加可选字段：

```ts
| {
    readonly type: "completed";
    readonly turn: ProviderTurn;
    readonly usage?: ProviderUsage;
  }
```

字段可选，现有测试替身（`test/support/provider.ts`）不需要改造即可继续编译。

### 2. OpenAI Provider

`src/providers/openai.ts`：`case "response.completed"` 分支除置 `completed = true` 外，把 `event.response.usage` 和 `event.response.model` 映射成 `ProviderUsage`，经 `validateProviderUsage` 后暂存；三处 `yield { type: "completed", … }` 均带上该 usage（无效时省略字段）。请求体不变，Responses API 默认返回 usage。

### 3. DeepSeek Provider

`src/providers/deepseek.ts`：

- 请求体增加 `stream_options: { include_usage: true }`；
- `DeepSeekChatCompletionChunk` 增加两个可选字段：`model?: string` 和 `usage?: DeepSeekUsage | null`，其中 `DeepSeekUsage` 在 SDK 的 `CompletionUsage` 之上补 `prompt_cache_hit_tokens?: number` 和 `prompt_cache_miss_tokens?: number`；
- 流循环中先读 `chunk.usage`（usage chunk 的 `choices` 为空数组），再执行现有的 `choices[0] === undefined → continue`；
- 末尾 `yield { type: "completed", … }` 带上映射并校验后的 usage。

### 4. 用量日志（新文件 `src/run-usage.ts`）

职责单一：按调用累积用量并给出汇总，不做 I/O。

```ts
export type ModelCallKind = "step" | "context_compaction" | "history_summary";

export interface RunModelCall {
  readonly seq: number;
  readonly kind: ModelCallKind;
  readonly step?: number;
  readonly model: string;
  readonly usage?: ProviderUsage;
  readonly createdAt: string;
}

export interface RunUsageTotals {
  readonly calls: number;
  readonly unmeasuredCalls: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export class RunUsageLog {
  record(call: { kind: ModelCallKind; step?: number; model: string; usage?: ProviderUsage }): void;
  get calls(): readonly RunModelCall[];
  get totals(): RunUsageTotals;
}
```

`record` 分配自增 `seq`（从 0 开始）并打 `createdAt` 时间戳。`kind` 为 `step` 时必须给 `step`，否则必须不给。`totals` 只对有 usage 的调用求和。

### 5. Agent Loop 与事件协议

`src/agent-loop.ts`：

- `RunAgentOptions` 增加可选 `usageLog?: RunUsageLog`；未提供时内部自建一个，保证 `run.completed` 始终有汇总；
- `streamProviderTurn` 拿到 `completed` 事件时，用 `event.usage` 调 `usageLog.record({ kind: "step", step: stepNumber, model, usage })`。`model` 来自 usage；usage 缺失时无法得知实际 model，此时记录 `model` 为 Provider 配置值——为此 `LlmProvider` 增加只读字段 `model: string`，两个 Provider 已持有该值，测试替身补一个常量即可；
- `streamProviderTurn` 返回值从 `ProviderTurn` 改为 `{ turn, usage? }`，供 `step.completed` 事件使用。

`src/agent-events.ts`：

- `step.completed` 的 `data` 增加可选 `usage?: ProviderUsage`（该步自身的用量，未测得时省略）；
- `run.completed` 的 `data` 增加必填 `usage: RunUsageTotals`；
- `run.error` 的 `data` 增加可选 `usage?: RunUsageTotals`：Agent Loop 发出的 `run.error` 总是带合计，HTTP 层兜底补发的那条拿不到真实用量，省略字段表示未知；
- `AgentEventFactory` 的 `stepCompleted` / `runCompleted` / `runError` 相应增参。

摘要调用不产生公开事件这一点不变，因此流式过程中 `step.completed` 的逐步累加值会小于终态 `run.completed` 的汇总；差额就是摘要调用，终态汇总以 `run.completed` 为准。

### 6. ContextBuilder 与两个摘要器

`src/application/summary-request.ts`：`generateProviderSummary` 的返回值从 `Promise<string>` 改为 `Promise<{ summary: string; usage?: ProviderUsage }>`，在流循环里捕获 `completed` 事件的 usage。

`ContextCompactor` 和 `RunHistorySummarizer` 各自透传 usage 给调用方；`ContextBuilder` 在构造时接收可选 `usageLog?: RunUsageLog`，在两处摘要调用返回后分别以 `kind: "context_compaction"` 和 `kind: "history_summary"` 记录，`model` 同样取 `usage.model`，缺失时回退到 `options.provider.model`。摘要调用失败时不记录（没有发生计费的凭据）。

`ConversationRunService` 在 `startRun` 里创建 `RunUsageLog`，同时传给 `runAgentEvents` 和 `new ContextBuilder(...)`，并在 `beforeRunCompleted` / `beforeRunFailed` 回调里把 `usageLog.calls` 交给 Store——与现有 `contextBuilder.compactions` 的传递路径完全一致。

### 7. 数据库变更

**表数量：6 张 → 7 张。** 现有 6 张表（`conversations`、`turns`、`runs`、`transcript_messages`、`run_context_compactions`、`run_history_summaries`）的列、主键、外键、CHECK / UNIQUE 约束和索引全部不变；`runs` 保持 13 个物理列，不新增聚合列。

新增 1 张表 `run_model_calls`，10 个物理列：`run_id`、`seq`、`kind`、`step`、`model`、`input_tokens`、`cached_input_tokens`、`output_tokens`、`reasoning_tokens`、`created_at`。

```sql
CREATE TABLE IF NOT EXISTS run_model_calls (
  run_id TEXT NOT NULL
    REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  kind TEXT NOT NULL
    CHECK (kind IN ('step', 'context_compaction', 'history_summary')),
  step INTEGER NULL CHECK (step IS NULL OR step >= 1),
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  input_tokens INTEGER NULL,
  cached_input_tokens INTEGER NULL,
  output_tokens INTEGER NULL,
  reasoning_tokens INTEGER NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq),
  CHECK ((kind = 'step') = (step IS NOT NULL)),
  CHECK (
    (input_tokens IS NULL AND cached_input_tokens IS NULL
      AND output_tokens IS NULL AND reasoning_tokens IS NULL)
    OR
    (input_tokens IS NOT NULL AND cached_input_tokens IS NOT NULL
      AND output_tokens IS NOT NULL AND reasoning_tokens IS NOT NULL)
  ),
  CHECK (input_tokens IS NULL OR input_tokens >= 0),
  CHECK (output_tokens IS NULL OR output_tokens >= 0),
  CHECK (
    cached_input_tokens IS NULL
    OR (cached_input_tokens >= 0 AND cached_input_tokens <= input_tokens)
  ),
  CHECK (
    reasoning_tokens IS NULL
    OR (reasoning_tokens >= 0 AND reasoning_tokens <= output_tokens)
  )
) STRICT;
```

列语义：`run_id` + `seq` 是主键，`seq` 在单个 Run 内从 0 连续自增，反映真实调用顺序。`step` 仅在 `kind = 'step'` 时非空，取值是 Agent Loop 的步号。`model` 是该次调用实际计费的模型名，永远非空。四个 token 列同生共死：要么全部有值，要么全部为 NULL（表示 Provider 未返回可用 usage）。`created_at` 是 ISO 8601 文本，与全库其他时间列一致。

不新增索引：唯一的访问路径是按 `run_id` 取全部行或求和，主键 `(run_id, seq)` 的前缀已经覆盖。

外键关系：

```mermaid
erDiagram
    runs ||--o{ run_model_calls : "ON DELETE CASCADE"
    runs {
        TEXT id PK
    }
    run_model_calls {
        TEXT run_id PK_FK "新增表"
        INTEGER seq PK
        TEXT kind
        INTEGER step "NULL 除非 kind='step'"
        TEXT model
        INTEGER input_tokens "可 NULL"
        INTEGER cached_input_tokens "可 NULL"
        INTEGER output_tokens "可 NULL"
        INTEGER reasoning_tokens "可 NULL"
        TEXT created_at
    }
```

`run_model_calls` 全部 10 列均为新增。删除 Conversation 时经 `turns` → `runs` → `run_model_calls` 两级 CASCADE 一并清除。

建表走现有的 `CREATE TABLE IF NOT EXISTS` 启动路径，不需要迁移脚本。本地已有的 `runs` 没有对应行，聚合结果为 `calls: 0`。

### 8. Store 端口与 SQLite 实现

`src/application/conversation-store.ts`：

- `completeRun` 的第 6 个位置参数由 `contextCompactions` 改为一个结果对象 `outcome?: { contextCompactions?: readonly RunContextCompaction[]; modelCalls?: readonly RunModelCall[] }`，与 `failRun` 的 `diagnosis` 对象对称；
- `FailedConversationRunDiagnosis` 增加 `modelCalls?: readonly RunModelCall[]`；
- 新增读方法 `getRunUsageTotals(runId): RunUsageTotals`（诊断与读出路径共用）。

`src/infrastructure/sqlite/sqlite-conversation-store.ts`：

- 新增 `validateRunModelCalls`，校验 `seq` 从 0 连续、`step` 与 `kind` 的对应关系、`model` 非空、四个计数的子集关系。不与 transcript 交叉校验：失败 Run 的 transcript 可能停在半途，步号与消息数不存在稳定对应；
- 新增 `insertRunModelCalls(database, runId, calls)`，在 `completeRun` 和 `failRun` 的同一事务内、`insertContextCompactions` 之后调用；
- `getConversation` 增加一次按 `run_id` 分组的聚合查询，与现有的 runs / turns 查询并列：

```sql
SELECT
  run_model_calls.run_id AS run_id,
  COUNT(*) AS calls,
  SUM(CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END) AS unmeasured_calls,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens
FROM run_model_calls
INNER JOIN runs ON runs.id = run_model_calls.run_id
INNER JOIN turns ON turns.id = runs.turn_id
WHERE turns.conversation_id = $conversationId
GROUP BY run_model_calls.run_id
```

### 9. 读出路径

`src/domain/conversation.ts`：`ConversationRunView` 从 6 个字段增加到 7 个，新增 `usage: RunUsageTotals`（无记录时各计数为 0）；`ConversationView` 同样新增 `usage`，值是该会话全部 Run（含失败重试）的合计，由 `getConversation` 已有的分组聚合结果求和得到。HTTP 层的会话读出接口是这两个视图的直接序列化，`src/http/conversation-routes.ts` 不需要改动。

### 10. 诊断 CLI

`src/cli/diagnose-conversation.ts`：`diagnosticVersion` 由 4 升到 5。每个 Run 增加 `usage` 汇总和 `modelCalls` 明细数组（`seq`、`kind`、`step`、`model` 与四个计数）；Conversation 层增加一份跨 Run 汇总。token 计数不含用户内容，因此不受 `--include-content` 控制，始终输出。

### 11. Web

`web/src/events.ts`：`step.completed` / `run.completed` / `run.error` 的 data 类型补上 usage 字段并做形状校验（缺失时按未测得处理，不抛错）。

`web/src/run-state.ts`：累计当前 Run 的 token 数，供运行中展示；终态以 `run.completed` / `run.error` 的汇总覆盖。

`web/src/components/UsageSummary.tsx`（新文件）：一行紧凑用量的共享展示——输入（含缓存命中占比）、输出、调用数，未测得的调用数非 0 时一并标注。`RunResult.tsx` 以 `scope="run"` 用它展示本轮用量，`App.tsx` 以 `scope="conversation"` 在对话记录上方展示本会话合计。会话合计在 hydrate 时取服务端聚合值，之后每个 Run 结束时把该 Run 的合计加进来；运行过程中不做增量展示。

`web/src/conversation-state.ts`：从会话读出接口带回的 `usage` 用于刷新页面后仍能看到历史轮次的用量。

### 12. CLI 入口

`src/index.ts`：创建 `RunUsageLog` 传给 `runAgent`，结束后向 stderr 输出一行 `{"event":"run.usage",…}` JSONL。stdout 仍然只有最终回答。

### 文档

README 的「协议」一节补一段用量记账的口径说明（四个计数器的子集关系、三类调用、未测得的表示方式），「代码结构」一节补 `src/run-usage.ts`。

## 保持不变

- canonical transcript 的形状、事件序号 `seq` 的分配规则、`maxSteps` 的计数方式、交接步语义。
- 上下文压缩的触发阈值、目标水位、受保护 Skill 组和历史投影三档规则；摘要调用仍不计入 `maxSteps`、仍不产生公开流式事件。
- `ContextBuilder` 按 UTF-8 字节估算 token 的方式。用真实 usage 校准这个估算是后续独立改动，不在本方案内。
- 不引入价格表，不换算金额。单价随账号折扣、活动和时段变化，Harness 记录 token 原始量，金额按账单口径在外部换算。
- 不记录 cache write token。当前两个 Provider 都不对其单独计费。
- 不新增环境变量。
- 不改 `runs` 表结构，不加聚合列。
- 不改 Provider 的超时、重试和取消语义。

## 验收

新增测试：

- `test/openai-provider.test.ts`：`response.completed` 带 usage 时 `completed` 事件携带映射结果；usage 缺失时字段省略；`cached_tokens > input_tokens` 时判为未测得且不抛错。
- `test/deepseek-provider.test.ts`：请求体包含 `stream_options.include_usage`；`choices` 为空的 usage chunk 被正确读取；`prompt_cache_hit_tokens` 优先于 `prompt_tokens_details.cached_tokens`。
- `test/run-usage.test.ts`（新文件）：`seq` 连续自增；`totals` 跳过未测得调用并正确统计 `unmeasuredCalls`；`kind` 与 `step` 的配对约束。
- `test/agent-loop.test.ts`：两步 Run 的 `step.completed` 各自携带该步用量，`run.completed` 汇总等于两步之和；Run 失败时 `run.error` 携带已发生调用的汇总。
- `test/context-builder.test.ts`：触发 Run 内压缩后日志新增一条 `context_compaction`；触发历史降级后新增一条 `history_summary`；摘要调用失败时不新增记录。
- `test/sqlite-schema.test.ts`：`cached_input_tokens > input_tokens`、`kind <> 'step'` 却写了 `step`、四个 token 列部分为 NULL 这三种写入被 CHECK 拒绝。
- `test/sqlite-conversation-store.test.ts`：`completeRun` / `failRun` 写入的记录可原样读回；删除 Conversation 后记录被级联清除；`getConversation` 返回的 `usage` 与明细求和一致。
- `test/diagnose-conversation.test.ts`：`diagnosticVersion` 为 5，Run 层有 `modelCalls` 和 `usage`，Conversation 层有汇总。
- `web/src/events.test.ts`、`web/src/run-state.test.ts`：带 usage 的事件解析与累计。

回归：`npm run check` 与 `npm test` 全绿。

人工验收：在 Web 上跑一轮真实会话，跑完后用 `npm run diagnose:conversation <id>` 取该 Conversation 的汇总，与 Provider 控制台当日的用量对账，输入、输出和缓存命中三项应能对上；再故意触发一次失败 Run（例如把 `maxSteps` 设为 3），确认失败 Run 同样留下了用量记录。

## 已知问题（2026-09-28 补充）

- Provider 重试（`2026-09-24-provider-retry.md`）后，失败尝试拿不到 usage，不写入 `run_model_calls`。流中途失败的尝试服务端可能已经计费了一部分输出，这部分会少记。`run_model_calls` 仍是每个 step 一行，只记成功那一次尝试。
