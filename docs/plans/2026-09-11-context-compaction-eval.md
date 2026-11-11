# 压缩常数评测方案

`docs/plans/2026-08-25-context-retention-strategy.md` 的落地顺序里只剩第五步未做。
它要改的几个量目前都是写死的模块常量，取值无依据，而计划要求「先实测再定」。
现有的两次运行给不出这个数据：345 步那次的记录已随重建数据库删除；`ff6c2bd1`
只有 105,165 字节、48 步、压缩 0 次。

本方案定三件事：把压缩常数变成可配置项；把上下文窗口调小使压缩频繁触发；
建一个可重置的评测仓库承载固定任务。

## 当前实现

### 待定常数

| 常数 | 位置 | 现值 | 语义 |
|-|-|-|-|
| 近端保留轮数 | 无 | 无此概念 | `selectEndpoint` 只排除最后一个终点 |
| `SUMMARY_MAX_OUTPUT_TOKENS` | `context-compactor.ts:15` | `2_048` | 摘要调用的 `maxOutputTokens` |
| `MAX_CONTEXT_SUMMARY_BYTES` | `conversation-store.ts:11` | `16 * 1024` | 摘要文本字节上限，兼作 `CONTEXT_SUMMARY_RESERVATION` |

`COMPACTION_TARGET_RATIO`（`context-budget.ts:9`，现值 `0.6`）原本也在这张表里，
实现时发现它在新的选点规则下不起作用，已连同整条链路删除。理由见下面的第三项。

### 终点选择是升序取最小推进

`context-compactor.ts:207` 的 `selectEndpoint` 在已闭合工具对里从旧到新扫，
返回第一个能装进 `effectiveTarget` 的终点，也就是推进量最小的那个；
`preferredEndpoints = endpoints.slice(0, -1)` 只排除最后一个终点。
`forceMaximumCoverage` 仅在最小推进后仍超 `inputTokenLimit` 时启用。

### 触发水位

`context-budget.ts:5-9` 与构造函数：

```
safetyMargin    = max(2048, contextWindowTokens × 0.05)
inputTokenLimit = contextWindowTokens − maxOutputTokens − safetyMargin   // L
triggerTokens   = L × 0.8
targetTokens    = L × 0.6
```

字节经 `tokensFromBytes` 按 `bytesPerToken`（默认 2.5，`context-budget.ts:18`）换算。

### 现有可配置项

`server-config.ts` 的 `AgentServerConfig` 只有三个与本方案相关的字段：
`modelContextTokens`、`modelMaxOutputTokens`、`bytesPerToken`，分别读
`AGENT_MODEL_CONTEXT_TOKENS`、`AGENT_MODEL_MAX_OUTPUT_TOKENS`、`AGENT_BYTES_PER_TOKEN`。
`server-main.ts:40` 在进程启动时读一次，全进程共用。

### 构造链路

```
server-main.ts:40   loadAgentServerConfig
  → ConversationRunService（options.bytesPerToken，:47）
    → ContextBuilder（:107）
      → new ContextBudget（context-builder.ts:60）
      → new ContextCompactor（context-builder.ts:72）
```

这些常数都在链路末端的模块作用域里，没有任何一段接受外部传入。

### 建会话与发任务的接口

| 路径 | 位置 | 方法 | 说明 |
|-|-|-|-|
| `/v1/agent/conversations` | `agent-controller.ts:20,86` | GET | 仅列表 |
| `/v1/agent/conversations:select-workspace` | `conversation-routes.ts:48` | POST | 唯一建会话路径，调用 `MacOsHostDirectoryPicker` 弹原生目录选择器 |
| `/v1/agent/conversations/{id}/runs:stream` | `agent-controller.ts:24` | POST | 请求体 `{input, maxSteps?}`（`conversation-run-sse-route.ts:25`），SSE |

`origin-policy.ts` 的 `isTrustedFullAccessOrigin` 与 `isTrustedHostActionOrigin`
在 `request.headers.origin === undefined` 时都返回 `true`，curl 默认不带 Origin，
因此脚本调用 full_access 不会被拒。

`agent-loop.ts:36` 的 `DEFAULT_MAX_STEPS = 512`，`runRequestSchema` 的 `maxSteps`
上界同为 512。

## 存在的问题

**压缩几乎不触发。** 生产配置下 `trigger = 770,703`，按 `bytesPerToken = 2.5` 折算需要
约 1.93 MB 对话记录。`ff6c2bd1` 峰值 31,119 token，不到 trigger 的 4%。

**自举任务不可重复。** 一个功能做完就不能重做，无法在同一输入上做参数 A/B。

**常数不可配置。** 换一组取值需要重新编译，无法脚本化地跑多组。

## 目标实现

### 一、压缩常数变为可配置

新增两个环境变量，沿用 `AGENT_BYTES_PER_TOKEN` 的形状（`optionalRatio`
/ `optionalPositiveInteger`，缺省时保持现值）：

| 环境变量 | 落到 | 默认 | 评测取值 |
|-|-|-|-|
| `AGENT_COMPACTION_RECENT_PAIRS` | `selectEndpoint` 保留的近端已闭合工具对数 | `1` | 扫 1 / 3 / 5 |
| `AGENT_SUMMARY_BUDGET_RATIO` | 摘要预算占 `inputTokenLimit` 的比例 | `0.01` | 扫 0.005 / 0.01 / 0.02 |

### 二、摘要预算由窗口推导

`SUMMARY_MAX_OUTPUT_TOKENS` 与 `MAX_CONTEXT_SUMMARY_BYTES` 改为按 `inputTokenLimit`
的比例计算，带下限与上限：

```
summaryOutputTokens = clamp(L × ratio, 2048, 8192)
summaryMaxBytes     = summaryOutputTokens × bytesPerToken
```

`ratio` 由 `AGENT_SUMMARY_BUDGET_RATIO` 配置，默认取使生产配置下结果接近现值的量级。

**这一项是评测能成立的前提。** 16 KiB 折算 6,554 估算 token，占生产 target 578,027
的 1.1%，占评测 target 69,795 的 9.4%，相差近十倍；不改成按比例算，小窗口测出的
取值换到生产不成立。

### 三、`selectEndpoint` 取近端窗口之外最深的终点

在 `endpoints` 中排除末尾 K 个（K = `AGENT_COMPACTION_RECENT_PAIRS`），取剩下的
最后一个，也就是覆盖最大的那个。现状是取剩下的第一个，即覆盖最小的那个。

原方案写的是「降序扫描，返回第一个能装进 `effectiveTarget` 的终点」。实现时发现
这个判断永远在第一次循环就返回：覆盖越大，被摘要的消息越多，投影越小，所以
「能否装进 target」随覆盖单调；降序从最大覆盖开始扫，第一个命中的必然是最大覆盖
本身。target 定成多少都选中同一个终点。

因此 `COMPACTION_TARGET_RATIO` 及其配置项一并删除，`CreateContextCompactionRequest`
不再需要 `effectiveTarget` 与 `estimateRequestTokens` 两个字段。

## 评测配置

| | 生产 | 评测 |
|-|-|-|
| `AGENT_MODEL_CONTEXT_TOKENS` | 1,048,576 | 65,536 |
| `AGENT_MODEL_MAX_OUTPUT_TOKENS` | 32,768 | 12,288 |
| safetyMargin | 52,429 | 3,277 |
| L | 963,379 | 49,971 |
| trigger | 770,703 | 39,976 |
| 触发所需字节（trigger × 2.5） | ≈ 1.93 MB | ≈ 100 KB |

先试过 131,072 / 8,192：任务能跑完但一次压缩都没触发（峰值 80,985 对触发线
86,507），且 8,192 的输出上限会把模型写的大段编辑截断。降到 65,536 / 12,288
之后压缩稳定发生。

## 评测仓库

新建 `~/eval-repos/order-service`，独立 git 仓库，初始提交为全绿状态。

| 项 | 规格 |
|-|-|
| 技术栈 | TypeScript + vitest，无网络依赖、无外部服务 |
| 依赖 | 仅 `typescript` / `vitest` / `@types/node` |
| 规模 | 约 50 文件、4000 行 |
| `src/routes/` | 18 个接口文件 |
| `src/domain/` | 约 12 个文件 |
| `src/storage/` | 约 6 个文件，内存实现 |
| `test/` | 每个接口一个测试文件 |
| 全量测试 | < 20 秒 |
| `.gitignore` | 含 `node_modules` |

### 初始状态：错误处理三种写法并存

每个接口约 5 处报错点，全仓库约 90 处，分布为三种互不相同的写法与响应格式：

```ts
// src/routes/orders.ts
return res.status(404).json({ message: "order not found" });

// src/routes/payments.ts
throw new Error("invalid amount");

// src/routes/inventory.ts
return res.status(400).send("insufficient stock");
```

测试文件按各自的旧格式断言。

### 埋点：`src/routes/legacy-export.ts`

文件开头写死：

```ts
// 注意：本端点的错误响应必须保持 { "err": "..." } 的旧格式。
// 外部对账系统直接解析这个字段，不能并入新的错误码体系。
```

文件名按字母序靠前，早期被读到；改动落在末期。
`test/legacy-export.test.ts` 继续断言 `{ err: ... }`。

## 任务与判据

### 任务输入

单条 user 消息，`maxSteps` 取 512，中途不插话：

> 给所有 HTTP 端点接入统一错误码体系。错误码用 SCREAMING_SNAKE，同一含义在全仓库
> 只能有一个错误码。全部端点改完后 `npm test` 必须全绿。不要新增任何依赖。

2026-09-15 之前的版本写的是「前缀取所在模块名」。那句话让每个模块必然造出自己的
`XXX_ORDER_NOT_FOUND`，判据 A 六遍全部不通过且与压缩无关，故删去，改为把判据的
要求直接写进任务。现在判据 A 检验的是模型是否记得自己早先定过的码。
新提示词的第一遍（K=1，无人值守）：43 步、压缩 2 次、`npm test` 97/97，
A / B / C 全部通过，「订单不存在」只有一个 `ORDER_NOT_FOUND`，压缩后重读 3 次。

期望产出为 `AppError` 类加统一错误中间件，响应统一为
`{ "error": { "code": "...", "message": "..." } }`，`legacy-export` 除外。

### 长程依赖

同一含义只能有一个错误码。orders.ts 早期确定的 `ORDER_NOT_FOUND`，
在第 15 个文件 refunds.ts 必须被复用而非另造 `REFUND_ORDER_MISSING`。
若任务由互不相干的小改动组成，压缩丢失早期内容不产生代价，评测恒为满分。

### 三个判据

| 判据 | 检查方式 | 说明 |
|-|-|-|
| A · 错误码一致 | grep 全部码值，查同义不同名 | 若 agent 自建码表文件并回查，则压缩丢失也不失败——通过不说明问题，不通过才是明确信号 |
| 压缩后重读 | `rereads.sql`，见「指标」 | 不是通过 / 不通过，是 K 的直接产出量 |
| B · 依赖未新增 | `git diff package.json` 为空 | 验「用户消息不被摘要替换」这一不变式；应永远通过，失败即 bug |
| C · 埋点未被改坏 | `legacy-export` 仍返回 `{ err: ... }`，其余 17 个已切换 | 记得、或改前重读均算通过；不记得且未重读算失败 |

判据 C 检验摘要「正文已省略、需要时重读」这一声明是否真的被执行，
是决定压缩幅度上限的依据。

## 执行流程

### 准备

评测仓库 `npm install`、初始提交、确认 `npm test` 全绿。

### 启动评测 server

窗口大小是进程级配置（`server-main.ts:40`），评测需单独起进程：

```
AGENT_MODEL_CONTEXT_TOKENS=65536 \
AGENT_MODEL_MAX_OUTPUT_TOKENS=12288 \
AGENT_COMPACTION_RECENT_PAIRS=1 \
AGENT_SUMMARY_BUDGET_RATIO=0.01 \
PORT=3100 \
node --env-file=.env scripts/eval-server.mjs $HOME/eval-repos/order-service
```

`scripts/eval-server.mjs` 与 `server-main.ts` 共用 `server-bootstrap.ts` 的
`startAgentServer`，只把 `hostDirectoryPicker` 换成一个固定返回该目录的实现，
`selectWorkspace` 之后的 `realpath`、目录校验和 Runtime 预热照常执行。
业务代码里没有评测开关；`npm run start:server` 的行为不变。

端口被上一次评测进程占着时 `listen` 直接失败，起进程前先 `lsof -iTCP:3100`。

数据库不换，按 conversation 区分。

### 每遍的步骤

```
1. cd ~/eval-repos/order-service && git reset --hard && git clean -fd
   （不加 -x，node_modules 已 ignore）
2. POST /v1/agent/conversations:select-workspace {executionMode: "full_access"}
   → 返回的 workspace.canonicalPath 必须等于评测仓库，否则中止
3. POST /v1/agent/conversations/{id}/runs:stream {input, maxSteps: 512}
   → SSE，流结束即本遍结束
4. 跑判据 A/B/C，查 sqlite 取指标
```

2026-09-15 之前第 2 步只能手动点原生目录选择器，7 遍点错 3 次；现在由
`scripts/eval-server.mjs` 注入固定目录，整个流程可无人值守。执行模式必须 full_access，
否则工具审批会卡住。

必须每遍新建会话。对话记录归会话所有、压缩记录跨 Run 延续，
在既有会话追加消息会带入上一遍的全部历史。

换参数需重启 server 进程。

### 轮次

第一遍用现值跑，确认任务达标：步数两三百、压缩八到十次、三个判据可自动判定。
不达标先改任务。之后三四组候选参数各跑两遍。

### 指标

| 来源 | 指标 |
|-|-|
| `run_model_calls` | 按 `kind` 的调用数与 input / cached_input / output token |
| `conversation_context_compactions` | 压缩次数、每次 `covered_through_seq`、**相邻两次相隔步数** |
| `runs` | 总步数、`transcript_bytes`、工具结果占比 |
| `transcript_messages` | **压缩后重读次数**：某次 `read` 的路径更早已读过，两次之间有一次压缩覆盖了那次早读，且两次之间没有对该文件的 `edit`/`write` |
| 判据 | A / B / C 各自通过与否；`npm test` 是否全绿；墙钟 |

「相邻两次相隔步数」与「压缩后重读次数」是 K 的直接产出：K 留得越多，
近端文件越不需要重读。重读只统计 `read` 工具；经 `bash` 的 `cat`、`sed -n`
读文件不计入，某遍若主要靠 bash 读文件，该指标偏低。已有七遍的值：

| 遍 | read 总数 | 压缩后重读 |
|-|-|-|
| k1 a / b | 94 / 176 | 35 / 91 |
| k3 a / b | 139 / 12 | 83 / 1 |
| k5 a / b | 159 / 165 | 89 / 52 |
| 校准后 k1 | 115 | 44 |

k3 b 那遍 12 次 `read`，其余走 bash，正是上面说的失真。这些数字是提示词
修改前的，不与之后的遍比较。
同一批固定同一 provider 与 model。撞上 512 步上限的那遍作废。

## 具体改动

| 文件 | 改动 |
|-|-|
| `src/server-config.ts` | `AgentServerConfig` 增加 `compactionRecentPairs?`、`summaryBudgetRatio?`；`loadAgentServerConfig` 读取对应两个环境变量，新增 `optionalRatio` 校验 |
| `src/application/context-budget.ts` | 构造选项接受 `summaryBudgetRatio`；新增 `summaryOutputTokens` 与 `summaryMaxBytes` 两个推导属性；删除 `targetTokens` |
| `src/application/context-compactor.ts` | 构造选项接受 `recentPairs` 与 `summaryBudget`；`selectEndpoint` 取近端窗口外最深的终点；删除 `SUMMARY_MAX_OUTPUT_TOKENS`、`CONTEXT_SUMMARY_RESERVATION`，以及请求里的 `effectiveTarget` 与 `estimateRequestTokens` |
| `src/application/conversation-store.ts` | `MAX_CONTEXT_SUMMARY_BYTES` 从固定值改为绝对上界，实际值由预算推导 |
| `src/application/context-builder.ts` | 构造 `ContextBudget` 与 `ContextCompactor` 时透传三个新选项 |
| `src/application/conversation-run-service.ts` | `ConversationRunServiceOptions` 增加两个字段并透传给 `ContextBuilder` |
| `src/server-main.ts` | 把 config 的两个新字段传入 `ConversationRunService` |
| `src/application/summary-request.ts` | 字节校验从模块常量改为请求参数 `maxSummaryBytes` |
| `src/application/conversation-store.ts` | `MAX_CONTEXT_SUMMARY_BYTES` 从 16 KiB 提到 64 KiB，语义改为存储层的绝对上界 |
| `src/infrastructure/sqlite/sqlite-conversation-store.ts` | 摘要字节校验改用推导上界 |

无数据库 schema 变更。

## 落地顺序

1. ~~摘要预算由窗口推导~~ 已完成
2. ~~两个环境变量与构造链路透传~~ 已完成
3. ~~`selectEndpoint` 取近端窗口外最深的终点~~ 已完成
4. ~~建评测仓库并埋点~~ 已完成，见 `~/eval-repos/order-service`
5. ~~第一遍验任务~~ 已完成，见下
6. ~~跑候选参数~~ 已完成，K 取 1 / 3 / 5 各两遍，见「候选参数」

## 实测结果

### 两个前置缺陷

评测前六轮全部中途被 harness 掐断，都不是压缩的问题：

- `MAX_TOOL_CALLS_PER_BATCH = 4`。18 个 route 的任务里模型一次要读几十个文件，
  超出即以 `INVALID_MODEL_OUTPUT` 终止整轮。且 DeepSeek 流式解析把这个上限
  写死成 4，与常量脱钩。
- `finish_reason: "length"`。输出被截断判为非法响应，同样终止整轮。

两处都已改：数量不再设限，执行并发另设上限；截断在同一步内告知并重试。

### 摘要预算下限

第一次跑通之后，压缩仍然大量失败，原因由新加的 `context.compaction_failed`
日志给出——摘要在输出上限处被截断，整份作废。下限的影响：

| 下限 | 压缩成功 | 压缩失败 |
|-|-|-|
| 1,024 | 0 | 全部截断 |
| 2,048 | 2 | 6 |
| 2,048 + 提示词告知预算 | 5 | 4 |
| 4,096 + 提示词告知预算 | 10 | 0（1 次死于接口抖动） |

写得完整的摘要用到 1,100–1,450 token，写超被截断的超过 2,048，故下限取 4,096。
提示词不告知预算时模型会按需要写多长写多长。

### 跑道

`AGENT_COMPACTION_RECENT_PAIRS=1`、窗口 65,536 下跑到第 110 步，压缩 10 次，
覆盖点（会话级 seq）30 → 48 → 70 → 96 → 114 → 130 → 148 → 160 → 180 → 200，
相邻间隔 12–26 seq，约合 9–13 步。每次估算从触发线附近回落到 7,000–8,000。
摘要 2,266 → 7,319 字节后稳定在 4,000–5,000。

该轮末尾死于 `DeepSeek request failed`，不是压缩问题。

### 候选参数

2026-09-15，窗口 65,536 / 12,288，DeepSeek `deepseek-v4-pro`，每遍新建会话。
六遍全部跑完：`npm test` 全绿，判据 B、C 全部通过。

| 遍 | K | 步数 | 墙钟 | 压缩 | 相邻覆盖点间隔（seq） | step 输入 token | 摘要输入 token |
|-|-|-|-|-|-|-|-|
| a | 1 | 61 | 478 s | 6 | 14/12/6/12/30 | 1,038,325 | 164,144 |
| b | 1 | 47 | 504 s | 5 | 22/14/12/9 | 633,146 | 157,420 |
| a | 3 | 49 | 446 s | 6 | 8/8/8/10/16 | 909,266 | 122,777 |
| b | 3 | 67 | 553 s | 7 | 24/12/8/12/12/16 | 1,268,321 | 158,898 |
| a | 5 | 68 | 910 s | 10 | 6/14/24/12/22/10/2/2/8 | 1,353,244 | 160,972 |
| b | 5 | 135 | 878 s | 15 | 24/22/6/4/2/12/18/12/14/12/24/20/38/10 | 2,757,152 | 269,963 |

K=3 的 b 遍实际是 `AGENT_SUMMARY_BUDGET_RATIO=0.005`，原因见下一节；
它与 0.01 在评测窗口下等价，故并入 K=3。

**K=5 出局。** 两遍都是压缩最多、最贵的，且出现间隔 2 与 4 的连续压缩：
保留 5 对近端后每次腾出的空间不够下一步的工具结果，下一步又触发。

**K=1 与 K=3 分不出来。** 同一配置两遍之间的差（47 对 61 步、49 对 67 步）
大于两组之间的差，压缩次数都在 5–7。K 保持默认值 1。

**判据 A 六遍全部不通过，但不能归因于压缩。** 「订单不存在」每遍都是 7 个码：
`ORDERS_NOT_FOUND`、`CARTS_ORDER_NOT_FOUND`、`REFUNDS_ORDER_NOT_FOUND`、
`PAYMENTS_ORDER_NOT_FOUND`、`COUPONS_ORDER_NOT_FOUND`、`INVOICES_ORDER_NOT_FOUND`、
`SHIPPING_ORDER_NOT_FOUND`。任务原话要求「前缀取所在模块名」，模型照做，
每个模块自然得到自己的一个码；这与判据 A 期望的跨模块复用直接冲突。
六遍无一例外说明这是提示词决定的，不是丢失早期上下文的结果。
下次改任务时把「前缀取模块名」删掉，或把判据 A 改成检查同一模块内的一致性。

**步数远低于预期。** 方案按两三百步设计，实际 47–135 步。工具批次放开后模型
一次读几十个文件，任务变短。压缩仍触发 5–15 次，评测成立。

### ratio 在评测窗口下不可测

`summaryOutputTokens` 的下限是 4,096。评测窗口 L = 49,971，候选 0.005 / 0.01 / 0.02
分别算出 250 / 500 / 999，全部被下限托住，三个取值等价。要让 ratio 起作用，
L 至少要 205k（0.02）到 819k（0.005），那样的窗口下本任务一次压缩都不触发。
生产窗口 L = 963,379 下 0.005 得 4,817，0.01 与 0.02 都被上限压到 8,192。

ratio 保持默认 0.01。实际起作用的量是下限 4,096，其取值依据是上面的
「摘要预算下限」一节。

### 摘要预算的推导规则

```
summaryOutputTokens = clamp(L × summaryBudgetRatio, 4096, 8192)
summaryMaxBytes     = summaryOutputTokens × bytesPerToken
```

`summaryBudgetRatio` 默认 0.01。生产窗口 L = 963,379 算出 9,633，被上限压回 8,192
（旧值 2,048）；评测窗口 L = 49,971 算出 500，被下限托到 4,096。

### 已完成部分带来的默认行为变化

第三项不是纯粹的加配置项。即使 `AGENT_COMPACTION_RECENT_PAIRS` 用默认值 1，
选点规则也已经从「覆盖最小」变成「覆盖最大」。不设任何环境变量，压缩行为也已经
不同于改动之前。

## 保持不变

- `COMPACTION_TRIGGER_RATIO = 0.8` 与 safetyMargin 的推导不变
- `AGENT_BYTES_PER_TOKEN` 默认 2.5 不变
- 受保护内容的规则不变：canonical 用户消息与最新成功 Skill 调用对原样进入 Provider 视图
- 摘要前缀声明有损并要求重新读盘的语义不变
- 累计摘要的链式转写不变
- `DEFAULT_MAX_STEPS = 512` 不变
- HTTP 接口不变，建会话仍走 `selectWorkspace`；评测入口只替换目录选择器这一个依赖
- 数据库 schema 不变，评测与日常会话共用同一个库
