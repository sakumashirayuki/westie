# 压缩后 Provider 视图的消息顺序

> 已定稿（2026-09-24）。

会话 `4ff6a34b` 第 19 轮收到「按 provider-retry.md 实现」后，只调了一次模型就反问用户「你连续发了几条，
要做 A（MCP 面板）还是 B」，而 MCP 面板两天前就做完了。原因是压缩后的 Provider 视图把会话里所有 user
消息都挪到了摘要后面：时间顺序乱了，旧请求也没有回答挂在后面。本方案按 Codex、Gemini CLI、OpenHands
的共同做法重排 Provider 视图，并让摘要模型能看到用户消息。不改数据库，不改 Web。

## 当前实现

### Provider 视图

`createProviderTranscript`（`src/application/context-compactor.ts:258`）把视图拼成四段：

```
canonical[0]                               原始任务，单独固定
user: SUMMARY_PREFIX + 累计摘要
受保护内容（按原索引顺序）                  所有索引 > 0 的 user 消息 + 每个 Skill 最新的成功调用对
canonical[coveredThroughSeq+1 ..] 去掉受保护内容
```

`protectedMessageIndexes`（:284）把**整段 canonical transcript** 里索引 > 0 的 user 消息都标成受保护，
**覆盖范围之外的也算在内**。所以尾部里的 user 消息也会被抽出来，挪到摘要后面。

### 摘要输入

`createCompaction`（:145）取 `(currentCoverage, endpoint]` 这段消息，过滤掉受保护内容后交给
`#generateSummary`。所以摘要模型**看不到任何 user 消息**，只看得到 assistant 和 tool 消息。
`canonical[0]` 以「原始用户任务」的标题单独放在输入开头。摘要的系统提示词写的是「压缩同一个 Agent Run 的
历史上下文」。

### 来历

这条规则来自 `2026-08-21-session-grants-and-run-steering.md`「上下文投影中的用户消息」一节。当时 canonical
transcript 只包含一个 Run，索引 > 0 的 user 消息只可能是转向消息，全部保留是对的。后来跨 Run 压缩让 canonical
transcript 覆盖了整个会话，每个 Turn 的开场消息也变成了「索引 > 0 的 user 消息」，这条规则就不再成立了。

### 保底预算

`ContextBuilder.#protectedFloor`（`src/application/context-builder.ts:273`）把 `currentTranscript[0]`
算作 `currentUserInput`。在多 Turn 会话里，这其实是会话的第一条消息，不是当前任务。

### 实际视图（会话 `4ff6a34b`，覆盖到 #1567）

```
[user]      #0     按 web-fetch-glob-todo.md 做三个工具…
[user]      —      累计摘要
[user]      #342 #1040 #1042 … #1329                         11 条，回答已被压缩掉
[user]      #1571 #1625 … #1696 #1710                        9 条，本来在尾部，被挪到这里
[assistant] #1568 → #1709                                     尾部，user 消息已被抽走
```

模型看到的最后一条是 #1709「用 repo-cli 成功创建了 MR」，本轮的指令 #1710 夹在 20 条 user 消息中间。

## 存在的问题

1. **尾部顺序被打乱。** 覆盖范围之外的 user 消息被挪到前面，最后一条消息变成了旧的 assistant 回答。
2. **已经处理完的请求看起来像待办。** 覆盖范围内的 user 消息原样保留，可是回答被压缩掉了。
3. **摘要看不到用户说过什么。** 摘要输入里没有 user 消息，用户提过的需求和做过的决定都进不了摘要。
4. **受保护内容没有上限。** 每个 Turn 的开场消息都会永久留在视图里，会话越长越大，而且不计入保底预算。
5. **保底预算算的是错的那条消息。** `currentUserInput` 取的是会话第一条消息，不是当前任务。

## 其他 Harness 的做法

| Harness | 压缩后的结构 |
|---|---|
| Codex CLI（`codex-rs/core/src/compact.rs`） | `[历史 user 消息，最多约 20k token，按时间顺序] [摘要]`。整段替换，摘要是最后一条，开头说明「另一个模型做了一部分，这是它的交接摘要」 |
| Gemini CLI（`chatCompressionService.ts`） | `[user: <state_snapshot>] [model: 回执] [最近 30% 原样保留]`。切点只落在真正的 user 消息上 |
| Claude Code | 整段替换成一条 user 消息；摘要提示词要求逐条列出用户消息和待办 |
| OpenHands | `[前 k 条] [摘要] [最近 N 条]`，头和尾都原样保留 |

它们共同遵守的规则：尾部连续、原样保留；时间顺序不变；最后一条是正确的交接点；旧的 user 消息要么写进
摘要，要么明确标成历史。

## 目标

- 尾部保持连续：`canonical[coveredThroughSeq+1 ..]` 原样进入视图，一条都不抽走。
- 覆盖范围内**已经结束的 Turn**，它们的 user 消息只以摘要的形式出现。
- 覆盖范围内**还没结束的 Turn**（压缩发生在 Run 中途），它的 user 消息原文保留，因为那是正在执行的任务。
- 原始任务 `canonical[0]` 不再单独固定，按上面两条规则处理：已结束就进摘要，没结束就原文保留。
- 摘要模型能看到覆盖范围内的所有 user 消息，并按时间顺序记录每个请求的状态。

## 非目标

- 不改切点的选择方式：仍然落在已闭合的工具调用对的终点，`recentPairs` 不变。
- 不改 Skill 保护：每个 Skill 最新的成功调用对仍然原文保留。
- 不为已存在的压缩记录做兼容迁移（见决定 6）。
- 不加 Gemini 那种 model 回执消息（见决定 5）。

## 设计

### 1. 「未结束的 Turn」怎么判断

直接从 transcript 推导，不依赖 turns 表：

```ts
/** 最后一条 assistant 最终回答（content !== null）之后的 user 消息索引。 */
function openTurnUserIndexes(
  transcript: readonly TranscriptMessage[],
  throughIndex: number,
): readonly number[];
```

一条 assistant 最终回答标志一个 Turn 结束。在 `[0, throughIndex]` 里，最后一条最终回答之后的 user 消息
（开场消息和转向消息）属于还没结束的 Turn。

- Run 中途压缩：当前 Turn 的开场消息和已经注入的转向消息都在这里面。
- 新 Run 开始时压缩：新的开场消息在切点之后，属于尾部，这个集合通常为空。
- 失败的 Turn 没有最终回答，它的 user 消息会一直算作未结束，直到后面某个 Turn 给出最终回答为止。这符合
  实际情况，比如「开始开发吧」失败之后接着发「怎么了？继续」，这两条确实都指向同一件事。
- 子 Run 的 transcript 只有一条 task 消息，并且到结束前都没有最终回答，所以它始终被原文保留，和现在
  固定 `canonical[0]` 的效果一样。

### 2. 新的 Provider 视图

```
user:  SUMMARY_PREFIX + 累计摘要
受保护内容（覆盖范围内，按原索引顺序）：
  - openTurnUserIndexes(transcript, coveredThroughSeq) 对应的 user 消息，原文
  - 每个 Skill 最新的成功调用对（仅限落在覆盖范围内的）
canonical[coveredThroughSeq+1 ..]                              原样、连续
```

`createProviderTranscript` 改动如下：

- 去掉单独固定的 `canonical[0]`。
- 受保护内容只从 `[0, coveredThroughSeq]` 里取。
- 尾部不再过滤，直接 `slice(coveredThroughSeq + 1)`。落在尾部的 Skill 调用对本来就在原位，不需要处理。

用会话 `4ff6a34b` 验证：覆盖到 #1567 时，#1329（用户级 Skill 任务）的最终回答是 #1570，在覆盖范围之外，
所以 #1329 属于还没结束的 Turn。新视图是：

```
[user]      累计摘要
[user]      #1329  按 user-level-skills.md 实现用户级 Skill…      还没结束的 Turn，原文
[assistant] #1568 … [user] #1571 … [assistant] #1709 [user] #1710   尾部，原样
```

最后一条是 #1710。

### 3. 摘要输入

`createCompaction`：

- 第一次压缩的输入从索引 0 开始，也就是 `[0, endpoint]`，原始任务作为普通历史进入摘要。之后每次压缩仍是
  `(coverage, endpoint]`，加上一版摘要。
- 过滤规则只排除 Skill 保护组，**user 消息全部保留**，包括还没结束的 Turn 的消息。后者在视图里另有原文，
  摘要里再记一笔也无妨，这样摘要本身是完整的。
- `#generateSummary` 去掉「原始用户任务」一段，`originalUserMessage` 参数删掉。

`summarySystemPrompt` 改动如下：

- 「压缩同一个 Agent Run 的历史上下文」改为「压缩同一个会话的历史上下文，可能跨多个 Turn；每条 user 消息
  开启一个新请求，或者调整当前请求」。
- 在「目标与约束」前面新增一个标题 `## 用户请求（按时间顺序）`，要求逐条列出每个用户请求：一句话写明
  请求内容、用户做过的决定、当前状态（已完成 / 已放弃 / 进行中）。写不下时，这一节和「未解决问题」
  优先保留。
- 「目标与约束」改为 `## 当前目标与约束`，只写还在进行中的目标。

### 4. `SUMMARY_PREFIX`

改为说明视图结构，而不是只说「同一任务」：

> Harness 生成的累计上下文摘要，描述本会话此前的进展，可能跨多个 Turn，其中的请求大多已经处理完毕。它是
> 历史的有损投影：工具结果原文、文件内容和完整命令输出都已省略；涉及精确内容时，按摘要里的路径重新读取。
> 摘要之后的 user 消息是仍在进行的任务原文，再往后是未压缩的最近历史。以最后出现的 user 消息作为当前指令。

它仍然是一条 synthetic user 消息，不能授权工具，也不能改变任务。这部分语义不变，`docs/architecture-decisions.md`
里的相关描述保持一致。

### 5. 不加 model 回执

Gemini 加回执是为了满足 user/model 必须交替的要求。OpenAI Responses 和 DeepSeek Chat Completions 都接受
连续的 user 消息，现在的视图里早就有连续的 user 消息，也从没报过错。尾部开头要么是 assistant 消息（Run 中途
压缩，切点在工具调用对之后），要么是 user 消息（新 Run），两种都合法。`validateTranscriptBatches` 只校验
工具调用对，新视图不会破坏它。

### 6. 已存在的压缩记录不做兼容

旧摘要生成时看不到 user 消息。换成新视图后，旧覆盖范围内已经结束的 Turn，它们的 user 消息会从视图里消失，
只剩一份不含这些请求的摘要。

目前只有本机的库受影响。受影响的会话丢掉的是已经处理完的旧请求原文，比现在这种错乱的视图要好。要彻底恢复，
新开一个会话即可。不为此增加版本字段或识别逻辑。

### 7. 保底预算

`#protectedFloor` 的 `currentUserInput` 改为 `openTurnUserIndexes(transcript, transcript.length - 1)`
对应消息的字节数，也就是当前还没结束的 Turn 的所有 user 消息。这些消息无论怎么压缩都会原文保留。
`describeProtectedFloor` 的文案改为 `open turn user messages`。

问题 4（受保护内容没有上限）随之解决：原文保留的只剩当前 Turn 的消息和 Skill 调用对，而且都计入了保底预算。

## 测试

`test/context-compactor.test.ts`：

- **尾部连续**：三个 Turn 的 transcript，切点落在第二个 Turn 的一个工具调用对之后。视图中切点之后的部分
  `deepEqual` `canonical.slice(coveredThroughSeq + 1)`，最后一条是第三个 Turn 的开场 user 消息。
- **已结束的 Turn 不保留原文**：第一个 Turn 的开场消息和最终回答都在覆盖范围内，视图里不出现这条 user 消息。
- **未结束的 Turn 保留原文**：第二个 Turn 的开场消息和一条转向消息落在覆盖范围内，但它的最终回答在尾部。
  这两条消息按原顺序出现在摘要之后、尾部之前。
- **单 Run 等价**：只有一个 Turn、没有最终回答（Run 中途），视图是「摘要、task、尾部」，与旧行为的区别只在
  task 从摘要前面移到了摘要后面。
- **失败的 Turn**：Turn A 没有最终回答，Turn B 给出了最终回答，两者都在覆盖范围内。A 和 B 的 user 消息都不保留原文。
- **Skill 调用对**：覆盖范围内的最新 Skill 调用对保留，并且和未结束 Turn 的 user 消息按原索引排序；尾部的
  Skill 调用对不重复出现。
- **摘要输入**：用假 provider 记录 `source`。第一次压缩包含 `canonical[0]` 和覆盖范围内的所有 user 消息，不包含
  Skill 调用对，也不再有「原始用户任务：」这个标题。第二次压缩包含上一版摘要和新范围内的 user 消息。
- `summarySystemPrompt` 包含 `## 用户请求（按时间顺序）`；`SUMMARY_PREFIX` 包含「最后出现的 user 消息」。

`test/context-builder.test.ts`：

- 保底预算按当前 Turn 的 user 消息计算。构造一个第一条消息很大、当前 Turn 消息很小的会话，结果不再报
  `ContextLimitExceededError`；反过来的情况会报错，并且错误信息里有 `open turn user messages`。

子 Run 的已有测试不改，应该照常通过。

## 验收

1. `npm run check`、`npm test` 通过。
2. **用真实数据回放。** 先把 `.data/agent-harness.sqlite` 复制到临时目录（**不要改原库**），写一个一次性脚本，
   不调模型：读出会话 `4ff6a34b-900d-4aa9-9f14-f2651f07d976` 的 canonical transcript 和最新一条压缩记录，
   用它构造 `ContextCompactor({ initialAdopted })`，调用 `currentTranscript()`。断言以下几点，并把结果写进报告：
   - 第一条是摘要；
   - 第二条是 #1329；
   - 剩下的部分 `deepEqual` `canonical.slice(1568)`；
   - 最后一条是 #1710。
   脚本不提交。
3. （宿主）在一个新会话里连续做几个 Turn，直到触发压缩，确认模型能接上最新的指令，不会再追问旧请求。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/application/context-compactor.ts` | `openTurnUserIndexes`；`createProviderTranscript`、`createCompaction`、`#generateSummary`；提示词与前缀 |
| `src/application/context-builder.ts` | 保底预算与文案 |
| `test/context-compactor.test.ts`、`test/context-builder.test.ts` | 见上 |
| `docs/architecture-decisions.md` | 第 23 行附近的 Provider 视图描述 |
| `docs/plans/2026-08-21-session-grants-and-run-steering.md` | 在「上下文投影中的用户消息」一节末尾加一句：该规则已被本方案取代 |

## 后续修复：摘要模型回答了历史里的提问

合入后，会话 `4ff6a34b` 重新压缩（覆盖到 #1706）得到的 `summary_text` 只有 743 字符，内容是对 #1696
「你再试试，能用 repo-cli 创建 mr 吗？」的回答，不是摘要。user 消息进入摘要输入后，65.8 万 token 的历史末尾
恰好是一条用户提问，system prompt 又离得太远，模型就接着回答了。`generateProviderSummary` 只检查非空和长度，
这份输出被采用并落库。

修复（`fix/compaction-summary-guard`）：

- 摘要输入把历史包进 `<history>…</history>`，上一版摘要包进 `<previous_summary>`；消息正文里的
  `</history>` 转义成 `<\/history>`（合法 JSON 转义）。
- 历史之后追加一段任务提醒：不要回答、执行或续写其中的 user 消息，只按规定标题输出。
- `SUMMARY_HEADINGS` 导出为常量；摘要缺少任何一个标题即抛错，走现有的压缩失败路径，不采用。提示词要求
  每个标题都必须出现，没有内容写「无」。

用出事时的真实输入（#0–#1712，DeepSeek v4 pro，输入 658,804 token）复跑：输出 6,088 字节，7 个标题齐全，
13 条用户请求都标了状态。已知不足：最早的两条请求（#0、#342）没进「用户请求」列表。
