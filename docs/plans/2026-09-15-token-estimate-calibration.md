# 用真实 usage 校准 token 估算

上下文预算的所有比较都在 token 量纲上做，但估算值是拿 UTF-8 字节数除以一个写死的
系数得到的。2026-09-15 的压缩评测（`2026-09-11-context-compaction-eval.md`）
给出了同一步的估算值与 Provider 返回的真实值，估算稳定高出三到五成。
本方案让系数在 Run 内跟着真实 usage 走。

## 当前实现

### 估算链路

`context-budget.ts` 的 `ContextBudget` 在构造时收下 `bytesPerToken`
（缺省 `DEFAULT_BYTES_PER_TOKEN = 2.5`，可由 `AGENT_BYTES_PER_TOKEN` 覆盖），
之后作为私有常量使用：

```
estimateTokens(request) = REQUEST_OVERHEAD_TOKENS(1024) + ceil(requestBytes / bytesPerToken)
```

`ContextBuilder.buildContext` 每步调用它两次：一次判断投影是否达到 `triggerTokens`
决定要不要压缩，一次在返回前把结果通过 `onRequestEstimate` 写到 stderr，
事件名 `context.request_estimate`，字段含 `runId`、`step`、`estimatedInputTokens`。

`ContextBuilder` 由 `conversation-run-service.ts:109` 按 Run 构造。

### 真实 usage 链路

`agent-loop.ts` 的 `streamProviderTurn` 在 Provider 流结束时拿到 `ProviderUsage`
（`inputTokens`、`cachedInputTokens`、`outputTokens`、`reasoningTokens`），
立即写入 `RunUsageLog`，Run 结束后落到 `run_model_calls` 表。DeepSeek 的
`inputTokens` 来自 `prompt_tokens`，OpenAI 来自 `input_tokens`，都是本次请求的
全部输入 token，含命中缓存的部分。

两条链路只在事后靠 `(runId, step)` 对账，运行时互不知道对方。

### 实测偏差

评测 k1-r0.01-b 一遍（会话 `039efeb1`，DeepSeek `deepseek-v4-pro`，中文任务加
TypeScript 仓库）：

| step | 估算 | 真实 | 估算 / 真实 |
|-|-|-|-|
| 3 | 4,643 | 2,846 | 1.63 |
| 10 | 26,714 | 19,861 | 1.35 |
| 30 | 37,562 | 28,280 | 1.33 |
| 45 | 11,514 | 7,869 | 1.46 |
| 47 | 12,573 | 8,691 | 1.45 |

扣掉 1,024 的固定开销后反推，这类对话的真实系数在 3.3 到 3.7 字节每 token，
写死的 2.5 是按另一次任务的 3.59 打七折得来的保守值。

## 存在的问题

**压缩比需要的早触发三到五成。** 触发线 `triggerTokens` 是真实 token 量纲，估算
高估 1.4 倍意味着真实占用只到触发线的 70% 就开始压缩，窗口有三成从未被用到。
评测里压缩间隔偏密、K=5 出现连续两步压缩，一部分是这个原因。

**反方向没有保护。** 系数是全局一个值，换成 token 更密的内容（大段英文散文、
JSON 数字）时估算会偏低，`inputTokenLimit` 的硬上限检查会放行真实超限的请求，
由 Provider 报错收场。

**每次 Provider 或语言混比变化都要人工改配置。** `AGENT_BYTES_PER_TOKEN`
是进程级常量，同一进程里不同会话共用。

## 目标实现

### 一次校准长什么样

Run 的第 10 步，`buildContext` 算出本次请求 64,093 字节，按当前系数 2.5 估成
`1024 + 25,638 = 26,662`。Provider 返回 `inputTokens = 19,861`。校准器得到一个
观测值：

```
observed = 64,093 / (19,861 − 1,024) = 3.40
```

按指数平滑并入当前系数：`2.5 × 0.5 + 3.40 × 0.5 = 2.95`。第 11 步起估算改用 2.95，
再下一步并入下一次观测，几步后收敛到 3.4 附近。系数始终限制在 `[1.0, 8.0]`。

### 一、校准器

新文件 `src/application/token-rate-calibrator.ts`，纯函数加一个不可变值：

```ts
export interface TokenRateState {
  readonly bytesPerToken: number;
  readonly observations: number;
}

export function observeTokenRate(
  state: TokenRateState,
  sample: { readonly requestBytes: number; readonly inputTokens: number },
): TokenRateState;
```

规则：

- 有效 token 数取 `inputTokens − REQUEST_OVERHEAD_TOKENS`，不足 2,048（两倍固定
  开销）或 `requestBytes` 为 0 时丢弃该样本，返回原状态。请求很小时固定开销的
  误差占主导：实测第 1 步真实 1,726 token 扣掉开销只剩 702，一个样本就把系数
  顶到上限 8，之后五步低估两成；
- 观测值 `requestBytes / effectiveTokens`，先钳到 `[1.0, 8.0]`；
- 第一次观测直接采用观测值，之后按 `α = 0.5` 指数平滑；
- 每次返回新对象，不改入参。

`α = 0.5` 的理由：一个 Run 通常几十步，前几步的样本最小、噪声最大，需要在
五步以内追上真实值；同时单步异常样本（例如一次工具结果全是数字）经一次平滑后
影响减半，两步后基本消失。

### 二、`ContextBudget` 可派生

`ContextBudget` 保持不可变，新增：

```ts
withBytesPerToken(bytesPerToken: number): ContextBudget
```

返回一个只有系数不同的新实例。`inputTokenLimit`、`triggerTokens`、
`summaryOutputTokens` 不依赖系数，值不变；`summaryMaxBytes` 依赖系数，
新实例按新系数重算。

### 三、`ContextBuilder` 接收 usage

`AgentContextBuilder` 接口新增可选方法：

```ts
observeUsage?(report: {
  readonly step: number;
  readonly usage: ProviderUsage;
}): void;
```

`ContextBuilder`：

- `buildContext` 把返回给 Provider 的那份投影的 `requestBytes` 按 `step` 记下
  （只保留最近一步）；
- `observeUsage` 用记下的字节数和 `usage.inputTokens` 调 `observeTokenRate`，
  得到新系数后用 `withBytesPerToken` 换掉 `#budget`；`step` 对不上时忽略；
- `RequestEstimateReport` 新增字段 `bytesPerToken`，让 `context.request_estimate`
  日志能看到每一步用的系数。

`ContextCompactor` 在构造时拿到的 `summaryBudget` 不跟着变。摘要预算是一次性
配置，评测里 4,096 token 的下限已经保证摘要写得完，不需要随系数漂移。

### 四、Agent Loop 回传

`agent-loop.ts` 的 `streamProviderTurn` 在 `usageLog.record` 之后，若
`completedUsage` 存在且 `options.contextBuilder?.observeUsage` 存在，调用它。
放在 `assertTurnSize` 之前：即使这一步的输出因超限被拒，输入侧的观测仍然有效。

### 五、系数的起点

每个 Run 从配置值起步（`AGENT_BYTES_PER_TOKEN` 或 2.5），不跨 Run 持久化。
起点偏保守只影响前几步，且方向是早压缩而非超限，可以接受。

## 具体改动

| 文件 | 改动 |
|-|-|
| `src/application/token-rate-calibrator.ts` | 新增 `TokenRateState`、`observeTokenRate`，常量 `TOKEN_RATE_SMOOTHING = 0.5`、`MIN_BYTES_PER_TOKEN = 1`、`MAX_BYTES_PER_TOKEN = 8`、`MIN_SAMPLE_TOKENS = 2048` |
| `src/application/context-budget.ts` | 新增 `withBytesPerToken`；`bytesPerToken` 改为只读公开属性供日志与派生使用 |
| `src/application/context-builder.ts` | `#budget` 改为可重新赋值；记录最近一步的 `requestBytes`；新增 `observeUsage`；`RequestEstimateReport` 增加 `bytesPerToken` |
| `src/agent-loop.ts` | `AgentContextBuilder` 增加可选 `observeUsage`；`streamProviderTurn` 回传 |
| `test/token-rate-calibrator.test.ts` | 丢弃无效与过小样本、首次直接采用、平滑、钳位、不改入参 |
| `test/context-budget.test.ts` | `withBytesPerToken` 返回新实例且原实例不变 |
| `test/context-builder.test.ts` | 观测后下一步的估算变化；估算下降到触发线以下时不再压缩；`step` 不匹配时忽略 |
| `test/agent-loop.test.ts` | 每步完成后以该步 `step` 与 `usage` 调用 `observeUsage`；Provider 无 usage 时不调用 |

无数据库 schema 变更。`run_model_calls` 与 `context.request_estimate` 日志
已经足够事后核对校准效果。

## 保持不变

- `REQUEST_OVERHEAD_TOKENS = 1024`、`COMPACTION_TRIGGER_RATIO = 0.8`、
  safetyMargin 的推导。
- `AGENT_BYTES_PER_TOKEN` 的语义：进程级起点值，不再是全程常量。
- 摘要预算 `summaryOutputTokens` 与传给 `ContextCompactor` 的 `summaryMaxBytes`。
- `ContextLimitExceededError` 的触发条件与错误信息。
- `RunUsageLog` 与 `run_model_calls` 的记账口径。
- CLI 入口（`src/index.ts`）不使用 `ContextBuilder`，不受影响。

## 验收

1. 单元测试全部通过。
2. 用评测配置重跑一遍任务，`context.request_estimate` 里的 `bytesPerToken`
   在前五步内离开 2.5 并稳定在 3 到 4 之间，`estimatedInputTokens` 与同步的
   `run_model_calls.input_tokens` 之比落在 0.9 到 1.1。
3. 同一任务的压缩次数少于校准前的 5 到 7 次。

## 实测结果

2026-09-15，评测配置（窗口 65,536 / 12,288，K=1，DeepSeek `deepseek-v4-pro`），
校准版跑一遍与校准前同配置的两遍对比：

| | 步数 | 压缩次数 | 覆盖点间隔 | step 输入 token |
|-|-|-|-|-|
| 校准前 a | 61 | 6 | 14/12/6/12/30 | 1,038,325 |
| 校准前 b | 47 | 5 | 22/14/12/9 | 633,146 |
| 校准后 | 65 | 3 | 38/33 | 1,495,403 |

`npm test` 全绿，判据 B、C 通过。压缩从 5 到 6 次降到 3 次，间隔翻倍；
step 输入 token 上升是窗口被用满的直接结果。

估算与真实的比值：

| step | 估算 / 真实 | 系数 |
|-|-|-|
| 1 | 1.95 | 2.50 |
| 2 | 0.84 | 8.00 |
| 8 | 0.90 | 3.74 |
| 16 | 1.00 | 3.27 |
| 32 | 0.99 | 3.41 |
| 64 | 0.99 | 3.50 |

第 16 步起误差在 1% 以内，系数稳定在 3.3 到 3.5。第 2 步的 8.00 就是没有样本
门槛时第 1 步小请求造成的过冲，`MIN_SAMPLE_TOKENS` 在这次运行之后加入，
这遍数据里不含它的效果。
