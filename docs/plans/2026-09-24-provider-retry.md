# Provider 失败重试

> 已定稿（2026-09-24）。

现在只要模型调用失败一次，整个 Run 就结束了。自举这类长任务一个 Run 要调几十次模型，遇到一次
429、502 或断流就前功尽弃，用户只能看到 `AGENT_RUN_FAILED`，还得手动重发。本方案在 provider 层
加一层有上限的重试，覆盖连接失败、限流、服务端错误和流中途断开；重试过程通过事件告诉 Web 和
CLI。不改数据库。

## 当前实现

### 两个 provider 都关掉了 SDK 重试

`OpenAIProvider`（`src/providers/openai.ts`）和 `DeepSeekProvider`（`src/providers/deepseek.ts`）
都用 `openai` SDK（6.49.0），调用时传 `timeout: 60_000, maxRetries: 0`（`STREAM_MAX_RETRIES`）。
异常一律包成 `OpenAIProviderError` / `DeepSeekProviderError("… request failed.", { cause })`，
不区分状态码。

SDK 自带的重试（`node_modules/openai/client.js` 的 `retryRequest`）不适合直接打开：

- 只覆盖拿到响应头之前的失败。流开始以后再出错（`hasStreamingBody`、迭代时断连）一律不重试。
- 等待用的 `sleep` 不监听 `AbortSignal`，用户在等待期间点停止，要等 sleep 结束才会生效。
- `Retry-After` 没有上限，服务端说等 10 分钟就真等 10 分钟。
- 整个过程是静默的，UI 看起来就是卡住了。

### 超时只管到响应头

SDK 的 `fetchWithTimeout` 在 `fetch` resolve（拿到响应头）后就 `clearTimeout`。流式 body 没有
任何超时，服务端建连后不再发数据的话，这一步会一直挂着，只能靠用户手动取消。

### 流中途的失败形态

- OpenAI：`response.failed`、`error` 事件抛 `OpenAIProviderError`；`response.incomplete` 且原因
  不是 `max_output_tokens` 也抛这个错；迭代时断连（`terminated`、`ECONNRESET`）被包成
  `"OpenAI request failed."`。
- DeepSeek：`finish_reason: "insufficient_system_resource"`（服务端资源不足，官方建议重试）目前
  在 `completeTurn` 里走到 `ProviderOutputError`，对外报的是 `INVALID_MODEL_OUTPUT`，归错了类。

### 调用方

`LlmProvider.stream` 有两个调用方：

1. `streamProviderTurn`（`src/agent-loop.ts:455`）：把 `output_text.delta` / `tool_arguments.delta`
   实时转成 `answer.delta` / `model.delta` 发给前端，累计 `streamedBytes` 防超大输出，收到
   `completed` 后才写 usage、推进 transcript、执行工具。父 Run 和子 Run 都走这里。
2. `generateProviderSummary`（`src/application/summary-request.ts`）：compaction 摘要，不向外
   转发 delta。

`runEventLoop` 已有一种重试：`ProviderTruncatedOutputError` 时往 transcript 追加提示再调一次，
最多 `MAX_TRUNCATED_OUTPUT_ATTEMPTS = 3` 次。它解决的是"模型输出太长"，与本方案无关，保持不变。

provider 由 `createProviderFromEnvironment`（`src/runtime.ts:105`）统一创建，Web 和 CLI 共用。

### 事件不落库

数据库只存 transcript 和 `run_model_calls`，`AgentEvent` 只走 SSE 实时推送。Web 的
`parseAgentEvent`（`web/src/events.ts:159`）用白名单校验事件类型，遇到未知类型会直接抛错。

## 存在的问题

1. **瞬时故障直接终止 Run。** 限流、网关 5xx、连接重置都是过几秒再试就好的问题。
2. **流卡住时无法自动恢复。** 没有 idle 超时，一步可以无限期挂住。
3. **错误分类过粗。** 401、余额不足、上下文超长这类重试没用的错误，和 502 混在一起；DeepSeek
   资源不足被当成模型输出非法。
4. **对用户不透明。** 失败原因只剩 `Agent run failed.`，等待期间也没有任何提示。

## 目标

- 可重试的失败自动重试，次数和总等待时间都有上限，退避时间带 jitter，遵守 `Retry-After`。
- 流中途失败也能重试，前端能正确丢弃这次失败尝试已经显示的部分输出。
- 等待期间可以随时取消，取消立即生效。
- 重试过程通过事件可见；最终失败时，对外错误码能区分"服务暂时不可用"和"请求本身有问题"。

## 非目标

- 不重试 `ProviderOutputError`（模型产出结构非法）。这是模型行为问题，重试可能掩盖 bug，
  以后要做也另开方案。
- 不改 `ProviderTruncatedOutputError` 的现有处理。
- 不做熔断、多 key 轮换或切换备用模型。
- 不给重试次数加环境变量配置，先用常量。

## 设计

### 1. 错误分类：provider 抛 `ProviderTransientError`

在 `src/provider-protocol.ts` 新增：

```ts
/** 瞬时故障：同一请求稍后重发大概率成功。只有这个类型会被重试。 */
export class ProviderTransientError extends Error {
  readonly reason: ProviderTransientReason;
  /** 服务端建议的等待时间（Retry-After / retry-after-ms），已解析成毫秒。 */
  readonly retryAfterMs?: number;
}

export type ProviderTransientReason =
  | "rate_limited"      // 429（除 insufficient_quota）
  | "server_error"      // 5xx、OpenAI response.failed 里的 server_error
  | "overloaded"        // 503/529、DeepSeek insufficient_system_resource
  | "timeout"           // 408、连接超时、流 idle 超时
  | "connection";       // 连接失败、流中途断开
```

两个 provider 共用一个分类函数 `classifyProviderError(error): ProviderTransientError | undefined`
（新文件 `src/providers/provider-errors.ts`），在各自的 `catch` 里先调用它：命中就抛
`ProviderTransientError`（`cause` 保留原始错误），否则按现在的方式抛。规则如下：

| 输入 | 结果 |
|---|---|
| `APIConnectionTimeoutError`、408 | `timeout` |
| `APIConnectionError`、迭代时的 `TypeError: terminated` / `ECONNRESET` / `UND_ERR_SOCKET` | `connection` |
| 429 且 `error.code !== "insufficient_quota"` | `rate_limited` |
| 500、502、504 | `server_error` |
| 503、529 | `overloaded` |
| OpenAI `response.failed` 且 `error.code` 为 `server_error` / `rate_limit_exceeded` | 对应类型 |
| OpenAI `error` 事件，`code` 同上 | 对应类型 |
| DeepSeek `finish_reason: "insufficient_system_resource"` | `overloaded` |
| 其他 4xx（400/401/402/403/404/409/422…）、429 `insufficient_quota` | 不重试 |

- `409` 在 SDK 里算可重试（lock timeout），但这两家 API 的 409 都不是这个意思，不重试。
- 响应头里有 `x-should-retry` 时按它来，与 SDK 行为一致。
- `retryAfterMs` 的解析和 SDK 相同：先看 `retry-after-ms`，再看 `retry-after`（秒数或 HTTP 日期）。
  负数、NaN 一律丢弃。

### 2. 流 idle 超时

在两个 provider 的流迭代里加一个 idle 计时器：连续 `STREAM_IDLE_TIMEOUT_MS = 180_000` 没有收到
任何 chunk/event，就 abort 这次请求，并抛 `ProviderTransientError("timeout")`。

- 用一个内部 `AbortController` 串接 `request.signal`，idle 超时触发的是内部 controller。
  `catch` 里要区分"用户取消"（`request.signal.aborted`，照原样抛）和"idle 超时"（转成 transient）。
- 180 秒是为推理模型留的：OpenAI 推理模型在思考期间可能很长时间不发任何 delta。要是实测还会
  误杀，就再调大，但不能去掉。
- 现有的 `REQUEST_TIMEOUT_MS = 60_000`（到响应头为止）保持不变。

### 3. 重试位置：`RetryingProvider` 装饰器

新文件 `src/providers/retrying-provider.ts`：

```ts
export class RetryingProvider implements LlmProvider {
  constructor(inner: LlmProvider, policy?: RetryPolicy, deps?: { sleep?, random?, now? });
  // model / contextWindowTokens / maxOutputTokens 透传 inner
  stream(request): AsyncIterable<ProviderStreamEvent>;
}
```

放在装饰器里，而不是写在 `agent-loop`，理由有三：父 Run、子 Run、compaction 摘要一次全覆盖；
provider 自身仍然只管"一次请求"，测试不用改；`createProviderFromEnvironment` 在最外层包一层即可。

`stream` 的逻辑：

```
for attempt = 1..maxAttempts:
  try:
    for await event of inner.stream(request): yield event
    return
  catch error:
    if request.signal?.aborted: throw（原样）
    if !(error instanceof ProviderTransientError): throw
    if attempt == maxAttempts: throw ProviderUnavailableError(attempts, lastReason, { cause: error })
    delay = computeDelay(attempt, error.retryAfterMs)
    if delay === undefined（Retry-After 超过上限）: throw ProviderUnavailableError(...)
    if 本次调用已等待总时长 + delay > maxTotalDelayMs: throw ProviderUnavailableError(...)
    yield { type: "retrying", attempt: attempt + 1, maxAttempts, delayMs: delay, reason: error.reason }
    await abortableSleep(delay, request.signal)
```

`RetryPolicy` 默认值（常量，放在同一文件）：

| 参数 | 值 | 说明 |
|---|---|---|
| `maxAttempts` | 5 | 含首次，即最多重试 4 次 |
| `baseDelayMs` | 1_000 | 第 n 次重试的上限为 `base × 2^(n-1)` |
| `maxDelayMs` | 30_000 | 单次退避上限 |
| `maxRetryAfterMs` | 60_000 | 服务端要求等更久就不等了，直接失败 |
| `maxTotalDelayMs` | 120_000 | 单次 `stream` 调用累计等待上限 |

- 退避用 full jitter：`delay = random() × min(maxDelayMs, base × 2^(n-1))`。
- 有 `retryAfterMs` 时：`delay = max(retryAfterMs, 退避值)`；`retryAfterMs > maxRetryAfterMs` 直接失败。
- `abortableSleep`：`setTimeout` 加上对 signal 的 `abort` 监听，取消时立即 reject `signal.reason`。
  用 `await using` 还是 `try/finally` 清理监听器，取决于项目里现有的 disposable 工具，实现时按现有写法来。
- 同一个 `request` 对象原样重发：transcript、tools、systemPrompt 都是只读的，重发安全。

新增错误类型（`src/provider-protocol.ts`）：

```ts
/** 重试耗尽或等待超限：服务暂时不可用。 */
export class ProviderUnavailableError extends Error {
  readonly attempts: number;
  readonly reason: ProviderTransientReason;
}
```

### 4. 协议：`ProviderStreamEvent` 增加 `retrying`

```ts
| {
    readonly type: "retrying";
    readonly attempt: number;      // 即将开始的是第几次尝试（≥2）
    readonly maxAttempts: number;
    readonly delayMs: number;
    readonly reason: ProviderTransientReason;
  }
```

语义：**这次调用到目前为止 yield 的所有 delta 作废**，下一次尝试会从头开始输出。

由装饰器发出，内部 provider 不发。两个消费方的改动：

- `streamProviderTurn`：收到 `retrying` 时把 `streamedBytes` 清零，然后 yield
  `eventFactory.modelRetrying(stepNumber, …)`（见下一节）。`completedTurn` 不可能已经有值，因为
  `completed` 之后 provider 不会再失败；为了保险，这种情况照旧按 `ProtocolError` 处理。
- `generateProviderSummary`：收到 `retrying` 时把 `sawToolArguments` 置回 `false`，其他不变。

为什么流中途重试是安全的：transcript 推进、usage 记账、工具执行，全都在收到 `completed` 之后
才发生。失败尝试的输出只存在于前端显示里，没有任何副作用。

### 5. AgentEvent：`model.retrying`

`src/agent-events.ts` 新增：

```ts
ModelRetrying: "model.retrying"
// data: { attempt, maxAttempts, delayMs, reason }，带 step
```

- 不受 `includeModelDeltas` 控制，总是发出，因为用户需要知道为什么卡住了。
- 子 Run 的这个事件照常通过 `subagent.event` 冒泡。

**Web**

- `web/src/events.ts`：类型定义和 `eventTypes` 白名单加上 `model.retrying`，并校验 data 字段。
- `web/src/run-state.ts`：收到后把对应 step 的 `assistantText` 清空；如果 `answerKind` 是
  `"pending"` 且这段 answer 来自该 step，也一并清空。然后在 step 上记一个
  `retry: { attempt, maxAttempts, reason, until }`。收到该 step 的下一个 `answer.delta`、
  `model.delta` 或 `step.completed` 时清掉这个标记。
- UI：step 上显示一行状态，例如 `模型服务限流，3 秒后重试（2/5）`，倒计时根据 `until` 在前端计算。
  文案按 `reason` 映射。子 Run 卡片复用同一个组件。

**CLI**

不改。`src/index.ts` 通过 `runAgent` 只拿最终 answer，不消费流式事件，所以不存在部分输出需要
回退的问题。重试只会表现为等得久一点；最终失败时，报错信息里带上 `ProviderUnavailableError` 的
message。

### 6. 对外错误码

`publicRunError`（`src/agent-loop.ts`）新增一个分支：

```ts
if (error instanceof ProviderUnavailableError) {
  return {
    code: "MODEL_UNAVAILABLE",
    message: `Model service is temporarily unavailable (${reason}) after ${attempts} attempts.`,
  };
}
```

不可重试的 provider 错误（401、400 等）仍然是 `AGENT_RUN_FAILED`，本方案不细分。`internalError`
里保留完整 cause 链，排查时足够用。Web 对 `MODEL_UNAVAILABLE` 显示"稍后重试"的提示，复用现有
run error 的展示位置。

### 7. 用量记账

失败的尝试拿不到 usage（流没走到 `completed`），但服务端可能已经计费了一部分 output。本方案
**不记**这些尝试，`run_model_calls` 仍然是每个 step 一行，已知的少计问题写进
`docs/plans/2026-08-19-token-usage-accounting.md` 的已知问题里。以后要做的话，可以在 `retrying`
事件里带上已经流出的字节数，再按估算记账。

### 8. 接入

`createProviderFromEnvironment` 返回 `new RetryingProvider(inner)`。测试里直接构造 provider 的
地方不受影响；需要重试行为的测试自行包一层，并注入假的 `sleep` / `random`。

## 测试

新增 `test/retrying-provider.test.ts`，注入假的 `sleep`、`random`：

- 第 1 次抛 `ProviderTransientError`，第 2 次成功：先 yield `retrying`，再原样 yield 第 2 次的事件。
- 第 1 次已经 yield 了两个 delta 才失败：`retrying` 排在这两个 delta 后面，第 2 次的 delta 从头开始。
- 非 transient 错误（`ProviderOutputError`、普通 `Error`）：不重试，原样抛出。
- 重试耗尽：抛 `ProviderUnavailableError`，`attempts === 5`，`cause` 是最后一次的错误。
- `retryAfterMs = 5_000` 时，delay ≥ 5000；`retryAfterMs = 90_000` 时，不等待直接失败。
- 累计等待超过 `maxTotalDelayMs`：提前失败。
- 等待期间 abort：立即 reject `signal.reason`，不再发起下一次尝试。
- full jitter：`random = 0.5` 时，第 3 次重试的 delay 为 `0.5 × 4000`。

`test/provider-errors.test.ts`：分类表逐行覆盖，包括 `insufficient_quota`、`x-should-retry`、
`retry-after` 的秒数和 HTTP 日期两种格式。

provider 测试（`openai-provider.test.ts`、`deepseek-provider.test.ts`）补充：

- `createStreamingResponse` 抛出 SDK 的 `RateLimitError`（429）时，provider 抛 `ProviderTransientError`。
- 流中途抛 `TypeError("terminated")` 时，得到 `connection`。
- idle 超时：假流先发 1 个 chunk 然后永远不 resolve；用 fake timers 推进 180 秒，得到 `timeout`，
  而且内部请求被 abort。
- 用户取消优先：idle 计时器和用户 abort 同时存在时，抛的是 `signal.reason`。
- DeepSeek `insufficient_system_resource` 得到 `overloaded`。

`agent-loop.test.ts`：

- provider 先输出部分文本，然后 `retrying`，然后完整成功：事件序列里有 `model.retrying`，最终
  `answer.completed` 只包含第二次的内容，transcript 只追加一条 assistant 消息，usage 只记一次。
- 流出 `MAX_PROVIDER_TURN_BYTES - 1` 字节后 `retrying`，第二次再输出同样多字节：不会误触发
  `ProviderTurnTooLargeError`。
- `ProviderUnavailableError`：得到 `run.error`，code 为 `MODEL_UNAVAILABLE`。

`context-compactor.test.ts` 或 summary 的测试：`retrying` 之后 `sawToolArguments` 被重置。

Web：`run-state` 的测试覆盖"收到 `model.retrying` 清空该 step 的 assistantText 和 pending answer"
和"下一个 delta 清掉 retry 标记"；`events.ts` 的测试覆盖新事件的解析，以及非法 data 被拒绝。

## 验收

1. `npm run check`、`npm test` 通过，上面列的用例都在。
2. 用一个本地假的 Responses/Chat Completions HTTP 服务（`node:http`，放在 `test/support/`），通过
   真实 SDK 客户端（`baseURL` 指过去）验证：先返回 429 带 `retry-after: 1`，再返回正常流，Run 成功，
   SSE 里能看到一条 `model.retrying`。
3. 同一个假服务：先发两个 delta 然后 `socket.destroy()`，再返回正常流，最终答案里不含第一次的内容。
4. 同一个假服务：一直返回 503，Run 以 `MODEL_UNAVAILABLE` 结束，总耗时不超过累计等待上限加上各次请求的时间。
5. 同一个假服务：返回 401，不重试，只发出一次请求。
6. （宿主）Web 上手动触发一次重试，确认状态行、倒计时显示正确，部分输出被清掉，子 Run 卡片也正常。
7. （宿主）用实际使用的推理模型跑一个长思考任务，确认不会被 idle 超时误杀。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/provider-protocol.ts` | `ProviderTransientError`、`ProviderUnavailableError`、`retrying` 事件 |
| `src/providers/provider-errors.ts` | 新增，分类与 Retry-After 解析 |
| `src/providers/retrying-provider.ts` | 新增，装饰器、退避、可取消 sleep |
| `src/providers/openai.ts` / `deepseek.ts` | catch 里调分类函数；idle 超时；DeepSeek 资源不足 |
| `src/runtime.ts` | 包 `RetryingProvider` |
| `src/agent-loop.ts` | 处理 `retrying`、`publicRunError` 新分支 |
| `src/agent-events.ts` | `model.retrying` |
| `src/application/summary-request.ts` | 处理 `retrying` |
| `web/src/events.ts`、`run-state.ts`、step 组件 | 解析、状态、展示 |
| `test/*` | 见上 |
| `docs/streaming-sse.md`、`README.md`、`docs/runtime-boundaries.md`、`docs/architecture-decisions.md` | 新事件、错误码、重试策略 |

## 待定

1. **`maxAttempts = 5`、累计等待 120 秒是否合适。** 自举场景倾向于多等；交互场景用户可以随时
   手动停止，多等一会儿的代价不大。我倾向于就用这组值。
2. **idle 超时 180 秒。** 需要用实际用到的推理模型跑一次，确认思考期间确实会有事件，或者确认
   不会静默超过 3 分钟。

## 实现记录（2026-09-28）

harness 自举到一半，Run 因刷新页面被取消，剩余部分由我接手完成。与上文设计的偏离，以及接手时修掉的问题：

- **idle 超时抽成 `StreamAttempt`**（`src/providers/stream-attempt.ts`，用 `using` 声明）。两个 provider 不再各写一遍计时器和 signal 串接。
- **请求阶段的失败也要归类。** 接手前的版本只在流迭代时归类错误，`createStreamingResponse` / `createStreamingChatCompletion` 直接抛出的 429、5xx、连接错误原样冒泡，最常见的限流根本不会重试。
- **SDK 错误要用 `instanceof` 判断。** openai 6.49.0 的 `APIConnectionTimeoutError`、`APIConnectionError`、`APIUserAbortError` 的 `name` 都是 `"Error"`，按类名判断一律失效。
- **idle 中止后，SDK 的流会静默结束**（`core/streaming.js` 在中止时 `return`，不抛错）。所以循环结束后要检查 `attempt.throwIfIdleTimedOut()`，否则 OpenAI 会报「流在 completed 之前结束」而不重试，DeepSeek 会把半截输出当成最终回答。
- **没有 `request.signal` 时也要把内部 signal 传给 SDK**，否则 idle 超时中止不了请求。
- **顺手修的原有问题：** OpenAI 的 `ProviderTruncatedOutputError` 以前会被 catch 包成 `OpenAIProviderError`，agent loop 的截断重试对 OpenAI 从来没有生效过。原测试把这个错误行为固化了，已改成断言 `ProviderTruncatedOutputError`。
- 验收第 2–5 条在 `test/provider-retry-http.test.ts`：真实 OpenAI SDK 通过真实 HTTP 连接访问本地假服务（`test/support/fake-chat-completions-server.ts`），只把退避等待换成记录。
