# 会话上下文容纳与交接策略

一个 345 步的 Run 完成之后，同一会话的下一个 Run 拿到的历史是空的：它在 8,379 字节的输入上一步作答，对上一轮一千零一十一 KB 的工作一无所知。

直接原因是预算判定拿字节数与 token 上限相比，已经修掉。但那次故障发生的位置——把已结束 Run 的历史从数据库重新投影回来——是主流 Agent Harness 里不存在的一层。主流形态是一个会话一份 transcript：新的用户消息追加到同一份记录后面，Agent 在同一个上下文里继续，上下文满了就地压缩。历史一直在场，没有「重建历史」这件事，因此也没有重建失败这类故障。

本方案定四件事：transcript 的归属从 Run 移到 Conversation；Run 内压缩改为少压、压到底；摘要预算由窗口推导；工具结果在进入 transcript 前裁剪。第一件是结构改动，删掉的东西比加的多；后三件是策略与常数，取值按实测确定。

## 当前实现

### 三套彼此独立的上下文机制

| 机制 | 位置 | 职责 |
|-|-|-|
| Run 内压缩 | `application/context-compactor.ts` | 当前 Run 的历史超预算时摘要已闭合的工具调用对 |
| 跨 Run 历史投影 | `application/run-history-projection.ts` | 把同会话已完成 Run 投影进本次输入：原文 → 摘要 → 丢弃三档 |
| 预算估算 | `application/context-budget.ts` | 从 Provider 容量推导水位并判定投影是否装得下 |

三者共用水位，但失败语义各自独立。

### transcript 归 Run

`prepareAgentRun` 为每个 Run 建一份新的 transcript，第一条是本次输入：

```ts
const transcript: TranscriptMessage[] = [{ role: "user", content: options.input }];
```

Run 运行期间只往这份数组追加 assistant 与 tool 消息，终态时整份写入 `transcript_messages`（PK `run_id, seq`）。上一轮的消息不在其中。

### 历史靠重新投影

`ContextBuilder.buildContext` 的输出是两段拼接：`[历史投影] ++ [本 Run 的 transcript]`。历史投影由 `RunHistoryProjector` 从数据库重建，对每个已完成 Run 从新到旧走三档：

| 档 | 条件 | 进入输入的内容 |
|-|-|-|
| 原文 | `fitsRawHistory(transcriptBytes, baseTokens)` | 该 Run 的完整 transcript |
| 摘要 | 原文装不下 | `userMessage` + 按需生成的摘要 + `finalAnswer` |
| 丢弃 | 摘要投影也装不下，或摘要生成失败 | 无，并停止遍历更旧的 Run |

摘要由 `RunHistorySummarizer` 在投影时懒生成：把整轮 transcript 逐条序列化拼成一个 user 消息发给模型，结果存入 `run_history_summaries`。生成失败时 `catch` 只设一个 `stopReason` 字符串，`error` 不被使用。

### 压缩状态不跨 Run

`ContextCompactor` 的 `#adopted` 是实例字段，`ContextBuilder` 每个 Run 新建一个。上一轮已经算出的累计摘要（存在 `run_context_compactions`）不会被下一轮读取。

### transcript 容纳什么

工具结果原文进入 canonical transcript 并永久保留。各工具只约束单次调用，不约束累积：

| 来源 | 单次上限 | 位置 |
|-|-|-|
| 任意工具结果 | 64 KiB | `tools.ts` 的 `MAX_TOOL_OUTPUT_BYTES` |
| `bash` 输出 | 48 KiB | `tools/bash.ts` |
| `grep` 输出 | 48 KiB | `tools/grep.ts` |
| `read` 单次 | 1000 行 / 64 KiB | `tools/read.ts` |
| 单个 Run 的 transcript | 16 MiB | `application/conversation-store.ts` |

### 预算水位

```
safetyMargin    = max(2048, contextWindowTokens × 0.05)
inputTokenLimit = contextWindowTokens − maxOutputTokens − safetyMargin   // 记作 L
triggerTokens   = L × 0.8
targetTokens    = L × 0.6
```

`selectEndpoint` 在已闭合工具对里升序取第一个能装进 target 的终点，也就是推进量最小的那个；`forceMaximumCoverage` 只在最小推进后仍超 `inputTokenLimit` 时启用。摘要上限是两个固定常数：`SUMMARY_MAX_OUTPUT_TOKENS = 2048`、`MAX_CONTEXT_SUMMARY_BYTES = 16 KiB`。

### 存储

7 张表。与本方案相关的三张：

- `transcript_messages`：4 列 `run_id`、`seq`、`role`、`message_json`，PK `(run_id, seq)`。
- `run_context_compactions`：5 列 `run_id`、`position`、`covered_through_seq`、`summary_text`、`created_at`，PK `(run_id, position)`，UNIQUE `(run_id, covered_through_seq)`。
- `run_history_summaries`：4 列 `run_id`、`summary_text`、`summary_bytes`、`created_at`，PK `run_id`，CHECK `summary_bytes <= 16384`。

`turns` 7 列。`runs` 13 列，其 CHECK 只允许 `status = 'completed'` 时写 `message_count`、`transcript_bytes`、`final_answer`。

## 实测基线

一次 345 步的编码任务，配置 `AGENT_MODEL_CONTEXT_TOKENS=1048576`、`AGENT_MODEL_MAX_OUTPUT_TOKENS=32768`，provider 为 `deepseek-v4-pro`。推导出的水位：`L = 963,379`、`trigger = 770,703`、`target = 578,027`。

### Run 1

| 指标 | 实测值 |
|-|-|
| 步数 / 消息数 | 345 / 690 |
| transcript 字节 | 1,011,587 |
| 工具结果占比 | 75.2% |
| 最大单条消息 | 36,865 字节 |
| 模型调用 | 347（`step` 345 + `context_compaction` 2） |
| 输入 token 合计 | 60,128,504 |
| 其中命中缓存 | 59,430,656（98.8%） |
| 输出 token 合计 | 77,187 |
| 压缩调用 | 2 次，输入 124,567 token，命中缓存 0 |
| 压缩覆盖终点 | seq 36、seq 56；摘要 1,416 / 2,076 字节 |
| 墙钟 | 约 29 分钟 |

估算与真实 token 的对账：第 345 步估算 588,416 字节，真实输入 164,098 token，**比值 3.59**。

估算轨迹显示压缩为何只触发两次：步 216 为 584,297、步 243 为 645,294、步 299 为 728,429、步 317 为 764,291（均未过 770,703 的 trigger），第二次压缩后步 342 回落到 582,012。

### Run 2

```json
{"event":"context.history_projection","runId":"0f678b9e-…",
 "candidates":1,"raw":0,"summarized":0,"dropped":1,"generated":0,
 "stopReason":"summary_failed"}

{"event":"context.request_estimate","runId":"0f678b9e-…","step":1,
 "estimatedInputTokens":8379,"inputTokenLimit":963379,"compactions":0}
```

候选 1 个、原文 0、摘要 0、丢弃 1。第一步输入 8,379 字节，等于 system prompt 的 4,536 加用户那条 21 字节的消息。整轮历史一条未进，该 Run 一步作答后结束。

按当时的数据重建摘要调用的输入：1,021,488 字节，按实测比值约 284,536 token，在配置的 1,048,576 窗口之内。失败原因无法确定，因为异常被丢弃了。

### 与主流实现的差异

| 维度 | 主流 Agent Harness | 本 Harness 现状 |
|-|-|-|
| transcript 归属 | 会话 | Run |
| 新用户消息 | 追加到同一份 transcript | 开一份新的 transcript |
| 历史来源 | 一直在上下文里 | 从数据库重新投影 |
| 历史获取失败 | 不存在这个环节 | 三档降级，最差档丢弃全部历史 |
| 工具结果留存 | 用完即从工作上下文淡出，需要时重新读盘 | 原文永久驻留 transcript |
| 压缩深度 | 一次覆盖到近端窗口，留少量尾巴 | 每次推进最小量 |

主流形态成立的前提是重新读盘是默认动作。压缩丢掉文件正文没有关系，因为 agent 知道精确内容在磁盘上、也知道该回去取。

## 存在的问题

### 重建历史这一层本身是故障源

三档降级的每一档都有失败模式：原文档看错量纲就误判；摘要档要起一次与历史等长的模型调用，历史越长越容易失败，而历史越长越需要它成功；丢弃档一旦触发就把该轮及更旧的全部历史一起丢掉，且对用户没有任何信号。这些失败模式的共同前提是「历史需要被重建」，而这个前提来自 transcript 归 Run 这个选择。

### 已经算好的摘要被丢掉，然后重新算一遍

上一轮结束时，`run_context_compactions` 里已经存着覆盖 seq 1..56 的累计摘要。下一轮的投影完全不读它，改为把整轮 1 MB transcript 重新送进模型生成另一份摘要。同一段历史被摘要两次，第二次贵得多且会失败。

### 摘要的产出时机是最贵的那个点

摘要在下一个 Run 开始时生成：那时上一轮已经结束，记录冷在数据库里，只能起一次全新的、与历史等长的调用。若在上一轮进行中产出，模型的上下文还在场，代价约等于一步。

### 一份历史被表达成两种形状

同一段过去，在 Run 内是「canonical transcript + 累计摘要投影」，跨 Run 变成「userMessage + 摘要 + finalAnswer」三条消息。两套形状各有各的预算判定（`fitsRawHistory`、`fitsHistoryProjection`、`maxHistoryTokens`、`maxConversationTurns`）与各自的降级规则，而它们描述的是同一件事。

### 字节估算偏差 3.59 倍，Run 内压缩几乎不触发

估算把 1 字节当 1 token。等价于把 1M 的窗口当成 268K 在用；反过来看，1 MB 的 transcript 真实只占 285K token，距离 963K 的上限很远。两个偏差叠加的结果是当前这种状态：压缩既不该在 770 KB 触发，也不该让 transcript 长到 1 MB 无人处理。

### 根因：transcript 无限累积工具原文

上面几条都在处理「历史太大」的后果。历史之所以达到 1 MB，是因为每条工具结果原文永久驻留：工具结果占 75.2%，最大单条 36,865 字节。跨 Run 那次失败的摘要调用，输入的正是这些已经用完的文件内容与命令输出。

## 目标实现

一条原则：**文件系统是事实来源，transcript 是工作缓存。** 工作缓存按需装载、可以丢弃，丢弃时必须留下取回的路径。

### 一、transcript 归 Conversation

一个 Conversation 持有一份 append-only 的 canonical transcript。Turn 与 Run 的模型不变，Run 往这份 transcript 追加消息。

#### 一份会话 transcript 长什么样

一个会话：第一个 Turn 成功，第二个 Turn 第一次尝试失败、第二次尝试成功。`transcript_messages` 里的内容（省略 `message_json`）：

| conversation_id | seq | run_id | role | 含义 |
|-|-|-|-|-|
| 8ad…7f | 0 | run-A | user | Turn 1 的用户输入 |
| 8ad…7f | 1 | run-A | assistant | 工具调用 |
| 8ad…7f | 2 | run-A | tool | 工具结果 |
| 8ad…7f | 3 | run-A | assistant | Turn 1 的最终回答 |
| 8ad…7f | 4 | run-B | user | Turn 2 的用户输入 |
| 8ad…7f | 5 | run-B | assistant | 工具调用 |
| 8ad…7f | 6 | run-B | tool | 工具结果（该 Run 随后失败） |
| 8ad…7f | 7 | run-C | assistant | 重试：接着已有记录继续 |
| 8ad…7f | 8 | run-C | assistant | Turn 2 的最终回答 |

`turns` 记录各自的开场 seq：Turn 1 为 0，Turn 2 为 4。run-B 是 Turn 2 的 attempt 1（failed），run-C 是 attempt 2（completed）；run-C 没有自己的开场 user 消息，它继续 Turn 2 的那一条。

失败 Run 追加的消息保留在记录里。重试因此从「清空重来」变成「接着修」，模型能看到上一次尝试做了什么、错在哪。

#### 历史不再需要重建

`ContextBuilder.buildContext` 的输出变成一段：这份会话 transcript 的压缩投影。删除的部分：

- `RunHistoryProjector` 与三档降级；
- `RunHistorySummarizer` 与 `run_history_summaries`；
- `ContextBudget` 的 `fitsRawHistory`、`fitsHistoryProjection`、`maxHistoryTokens`；
- `StartConversationRunCommand.maxConversationTurns`。

历史的边界由压缩负责，与 Run 内的历史用同一套规则、同一个预算、同一种形状。

#### 压缩状态跨 Run 延续

压缩记录改为会话级，覆盖终点指会话级 seq。Run 启动时读取该会话已采用的最新一条，作为 `ContextCompactor` 的初始 `#adopted`。

上一轮算出的累计摘要因此直接被下一轮使用。跨 Run 的交接由此变成压缩机制的自然结果，不需要独立的摘要生成路径：新的 Run 开局看到的就是「累计摘要 + 覆盖点之后的全部消息」，与它在自己第 200 步看到的形状完全一致。

#### 每个 Turn 的用户消息都受保护

2026-08-21 方案定下的「每条 canonical user 消息都是受保护内容」在这里自然扩展：会话 transcript 里的 user 消息包含每个 Turn 的输入与运行期的转向消息，它们全部原样进入 Provider 视图，不被摘要文本替换。压缩因此永远不会吞掉任何一轮的原始诉求。

#### Run 启动与终态的读写

- `beginRun` 在同一个事务里创建 Turn 与 Run，并把该 Turn 的用户输入追加为一条 user 消息，记录其 seq 到 `turns.opening_seq`。attempt ≥ 2 的重试不追加新的 user 消息。
- Run 启动时加载该会话的 canonical transcript 作为初始 transcript。
- Run 终态时把本次追加的消息按会话级 seq 续写进去，并记录本次追加的消息数与字节数。完成、失败、取消三种终态都写。

### 二、Run 内压缩：少压、压到底

`selectEndpoint` 改为降序扫描，在「近端窗口保留 K 个已闭合工具对」的约束下取覆盖最大的终点；`COMPACTION_TARGET_RATIO` 显著下调。目标是把压缩次数压到个位数，并让每次压缩之后留出尽可能长的跑道。K 与新的 target 比例由实测确定。

### 三、摘要预算由窗口推导

`MAX_CONTEXT_SUMMARY_BYTES` 与 `SUMMARY_MAX_OUTPUT_TOKENS` 改为按 `inputTokenLimit` 的比例计算，带下限与上限。压缩到底之后一份摘要要覆盖更长的历史，2048 output tokens 在这个前提下是硬约束，因此这一项是第二项的前提。

### 四、工具边界瘦身

工具结果进入 transcript 前做留存裁剪：`bash` 与 `grep` 保留首尾若干行并标注省略量，`read` 保留本次请求的行区间并标注文件总行数。裁剪结果必须带上重新取回所需的坐标（路径、行号、命令）。

这一项直接减少历史总量，是其余各项的共同前提：Run 1 的 transcript 若只有一两百 KB，压缩与交接都不会被逼到极限。

### 估算校准（已完成）

`ContextBudget.tokensFromBytes` 按 `bytesPerToken` 把字节数换算成 token，`AGENT_BYTES_PER_TOKEN` 配置该除数，默认 2.5（低于实测的 3.59，保证估算偏高）。所有字节口径进入预算比较前都过这一步。见 `fix: compare context budgets in token units, not byte counts`。

### 累计摘要的链式转写保留

压缩次数降到个位数之后，链式转写的复利深度同步降到个位数，`summary_N = f(summary_N-1, 新增消息)` 保留。改为每次从原始数据重新摘要会让输入随覆盖范围线性增长、总成本按次数呈平方增长，并在覆盖范围变大后超出摘要调用自身的上下文。等实测显示复利造成精度问题时再单独处理。

## 具体改动

### 数据库变更

全库从 7 张表变为 6 张。

#### 删除表 `run_history_summaries`

4 列（`run_id`、`summary_text`、`summary_bytes`、`created_at`）整表删除。跨 Run 摘要不再存在。

#### 改表 `transcript_messages`：4 列 → 5 列

当前列：`run_id`、`seq`、`role`、`message_json`，PK `(run_id, seq)`。

目标列：`conversation_id`、`seq`、`run_id`、`role`、`message_json`，PK `(conversation_id, seq)`。

```sql
CREATE TABLE IF NOT EXISTS transcript_messages (
  conversation_id TEXT NOT NULL
    REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  role TEXT NOT NULL
    CHECK (role IN ('user', 'assistant', 'tool')),
  message_json TEXT NOT NULL
    CHECK (json_valid(message_json))
    CHECK (json_type(message_json) IS 'object')
    CHECK (json_type(message_json, '$.role') IS 'text')
    CHECK (json_extract(message_json, '$.role') = role),
  PRIMARY KEY (conversation_id, seq)
) STRICT;
```

- `seq` 从 Run 级改为会话级，由追加事务内 `COALESCE(MAX(seq), -1) + 1` 分配。
- 新增 `run_id` 列保留产出溯源，用于按 Run 读出（转向消息投影、诊断），以及随 Run 删除级联。
- 不建索引。读整份会话记录走主键前缀；按 Run 读出用 `WHERE conversation_id = ? AND run_id = ?`，同样落在主键前缀上。
- `message_json` 的四条 CHECK 与 role 一致性约束不变。

#### 改表 `run_context_compactions` → `conversation_context_compactions`：5 列 → 5 列

当前列：`run_id`、`position`、`covered_through_seq`、`summary_text`、`created_at`。

目标列：`conversation_id`、`position`、`covered_through_seq`、`summary_text`、`created_at`。

```sql
CREATE TABLE IF NOT EXISTS conversation_context_compactions (
  conversation_id TEXT NOT NULL
    REFERENCES conversations(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  covered_through_seq INTEGER NOT NULL CHECK (covered_through_seq >= 0),
  summary_text TEXT NOT NULL CHECK (length(trim(summary_text)) > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, position),
  UNIQUE (conversation_id, covered_through_seq)
) STRICT;
```

`covered_through_seq` 的语义从 Run 级 seq 改为会话级 seq。列数、约束形状、索引策略不变。

#### 改表 `turns`：7 列 → 8 列

当前列：`id`、`conversation_id`、`position`、`user_message`、`status`、`created_at`、`updated_at`。

新增一列 `opening_seq INTEGER NOT NULL CHECK (opening_seq >= 0)`，记录该 Turn 的用户消息在会话 transcript 中的 seq。UNIQUE `(conversation_id, position)` 不变；额外加 UNIQUE `(conversation_id, opening_seq)`，因为一个 seq 只能属于一个 Turn。

`user_message` 保留：它是读出模型直接使用的字段，与 transcript 里那条 user 消息内容相同。

#### 改表 `runs`：约束调整，列不变

13 列不变。当前的 CHECK 把 `message_count`、`transcript_bytes` 与 `final_answer` 绑在一起，只允许 `status = 'completed'` 时非 NULL。失败 Run 的消息现在也保留，因此这两列对所有终态都要能写：

```sql
CHECK (
  (status = 'completed' AND final_answer IS NOT NULL)
  OR (status <> 'completed' AND final_answer IS NULL)
),
CHECK ((status = 'running') = (message_count IS NULL)),
CHECK ((message_count IS NULL) = (transcript_bytes IS NULL))
```

`message_count` 与 `transcript_bytes` 的语义从「该 Run 的完整 transcript」改为「该 Run 追加的消息数与字节数」。

不提供迁移。表结构变化后按 README 停服务、删除 `.data/agent-harness.sqlite` 及 `-wal`、`-shm`，再启动重建。

### 应用层

| 文件 | 改动 |
|-|-|
| `src/agent-loop.ts` | `RunAgentOptions` 增加 `initialTranscript`，替代由 `input` 造出第一条 user 消息；`history` 与 `maxHistorySteps` 保留给无 ContextBuilder 的 CLI 路径 |
| `src/application/conversation-store.ts` | 端口增加 `loadConversationTranscript`、`appendRunMessages`；删除 `listRecentCompletedRuns`、`loadRunTranscript`、`saveRunHistorySummary` |
| `src/application/context-builder.ts` | 删除历史投影段，`buildContext` 只做当前会话 transcript 的压缩投影；构造时接收该会话已采用的压缩记录作为初始状态 |
| `src/application/context-compactor.ts` | 接受初始 `#adopted`；覆盖终点按会话级 seq；`selectEndpoint` 改降序扫描并保留近端窗口 K；`SUMMARY_MAX_OUTPUT_TOKENS` 按预算推导 |
| `src/application/context-budget.ts` | 删除 `fitsRawHistory`、`fitsHistoryProjection`、`maxHistoryTokens`；`COMPACTION_TARGET_RATIO` 下调 |
| `src/application/conversation-store.ts` | `MAX_CONTEXT_SUMMARY_BYTES` 改为按预算推导，保留绝对上界 |
| `src/application/run-history-projection.ts` | 整个文件删除 |
| `src/application/run-history-summarizer.ts` | 整个文件删除 |
| `src/application/conversation-run-service.ts` | 启动时加载会话 transcript；终态时追加本次消息；删除 `maxConversationTurns` 与历史投影相关装配 |
| `src/infrastructure/sqlite/sqlite-conversation-store.ts` | 按新 schema 重写 transcript 与压缩记录的读写；`beginRun` 追加开场 user 消息并记录 `opening_seq` |
| `src/tools/bash.ts`、`src/tools/grep.ts`、`src/tools/read.ts` | 结果进入 transcript 前按留存规则裁剪并标注取回坐标 |
| `src/cli/diagnose-conversation.ts` | `diagnosticVersion` 升到 6；transcript 结构改为会话级列出，按 `run_id` 分组标注；删除 `historySummary` 字段 |

### 与 2026-08-21 方案的交叉影响

- 转向消息的读出投影从「`role='user' AND seq>0`」改为「`conversation_id = ? AND run_id = ?` 的 user 消息中排除 `turns.opening_seq` 那一条」。会话 transcript 里 `seq > 0` 的 user 消息包含后续每个 Turn 的开场消息，原来的条件不再成立。
- 「每条 canonical user 消息受保护」这条不变式继续成立，覆盖面从一个 Run 扩展到整个会话。

### 落地顺序

1. schema 与 SQLite 读写：新表结构、`beginRun` 追加开场消息、`loadConversationTranscript`、`appendRunMessages`；
2. Agent Loop 的 `initialTranscript`；
3. `ContextBuilder` 删除历史投影段、`ContextCompactor` 接受初始状态；
4. 删除 `run-history-projection.ts`、`run-history-summarizer.ts` 与相关预算方法；
5. 压缩策略与摘要预算（互为前提，一起做）；
6. 工具边界瘦身；
7. 诊断 CLI 与转向消息投影跟进。

前四步是结构改动，有依赖关系。第五、六步是策略与常数，可独立验证。

### 常数取值先实测再定

近端窗口 K、新的 target 比例、摘要输入上界与输出预算，全部按实测定。实测过程与结论见 `docs/plans/2026-09-11-context-compaction-eval.md`：K 保持 1，摘要输出预算下限 4,096，target 比例已删除。基线来自本次运行，指标口径是：`run_model_calls` 按 `kind` 的调用数与输入输出 token、`context.request_estimate` 与真实 token 的比值、压缩次数。改动后用同类任务对比同样的指标。

## 保持不变

- Turn 与 Run 的模型：一条用户消息一个 Turn，一次尝试一个 Run，`attempt` 递增，一个 Conversation 同时只有一个活跃 Run 以及并发发起的 409。
- canonical transcript 的四种消息类型与序列化口径。
- 压缩只产出 Provider 输入投影，不替换、不删除 canonical message。
- Skill 保护组，以及每条 canonical user 消息受保护。
- `turns.user_message` 仍是单列单值，仍只保存发起该 Turn 的那条输入。
- 工具的单次调用上限、沙箱、资源限制、权限策略。裁剪发生在结果进入 transcript 的那一步，不改变工具实际执行的边界。
- 摘要前缀声明有损并要求重新读盘的语义。
- CLI（`src/index.ts`）不接入会话存储，`createTranscriptWindow` 这条无 ContextBuilder 的路径不变。
- 不提供 schema migration。
