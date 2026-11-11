# 工具执行中被中断的 Run：补齐工具结果

> 讨论稿。

会话 `4ff6a34b` 在 09-24 被刷新页面取消时，正在执行一个 bash 调用。落库的 transcript 以这个
`assistant(toolCalls)` 结尾，后面没有对应的 `tool` 消息。之后这个会话里的每一次请求都在
`validateTranscriptBatches` 失败，会话就此不可用，直到 09-28 手工删掉那一行才恢复。本方案保证：
Run 无论在工具批次的哪个位置结束，落库的 transcript 里每个工具调用都有对应的结果。不改数据库。

## 当前实现

### 工具步的顺序

`runEventLoop`（`src/agent-loop.ts:390`）的工具步是这样执行的：

```
transcript.push(assistant toolCalls)      ← 先压入调用
yield stepCompleted; throwIfAborted()     ← 这里被取消：只有调用，没有结果
executeAgentToolBatch(...)                ← 审批、执行都在里面；这里被取消或出错：同上
transcript.push(tool results)             ← 只有整批成功才会走到
```

`executeAgentToolBatch`（`src/agent-tool-batch.ts`）有两个特点：

- 已完成调用的结果只存在局部数组 `results` 里；
- 被取消或出现内部异常时，它会等在飞的调用落地（`Promise.allSettled`），然后**直接抛错**。

所以同一批里已经完成的结果、在飞调用的结果，都会一起丢掉。

### 落库

`exposeRunErrors` 捕获错误后，调用 `beforeRunFailed({ cancelled, transcript, ... })`。
`ConversationRunService` 把 `transcript` 里本 Run 新增的消息原样写进 `transcript_messages`，
status 记为 `cancelled` 或 `failed`（`src/application/conversation-run-service.ts:221`）。写入时只校验
单条消息的 schema，不校验工具调用和结果是否成对。

### 读取

下一个 Run 用 `loadConversationTranscript` 读出整段会话，读取时同样不做校验。直到 provider 组请求时，
`createMessages` / `createInput` 调用 `validateTranscriptBatches`，才因为这个调用没有结果而抛出
`TranscriptValidationError`。

### 报错被掩盖

`validateTranscriptBatches` 是在 provider 的 `try` 块里被调用的，抛出的错误会被包成
`DeepSeekProviderError("DeepSeek request failed.")`。`formatInternalError` 只记录 `error.stack`，
不带 `cause`。所以 `runs.internal_error` 里只能看到「DeepSeek request failed.」，看不出真正的原因。
09-28 排查时，是靠在库副本上手工跑 `validateTranscriptBatches` 才定位到的。

### 影响范围

凡是在 `transcript.push(assistant toolCalls)` 之后、`transcript.push(tool results)` 之前结束的 Run，
都会出这个问题：

- 用户取消：点停止，或者刷新、关页面导致 SSE 断开；
- 等待审批（工具审批、文件授权）期间被取消；
- 批次内部抛出非预期异常；
- 父 Run 在 `agent` 工具执行期间被取消。子 Run 自己的 transcript 同理，但子 Run 不会被续跑，
  所以只影响诊断，不影响可用性。

09-28 查过库：除了已经手工修好的 `4ff6a34b`，主会话和子 Run 里都没有悬空的工具调用，**不需要迁移存量数据**。

## 其他 Harness 的做法（凭印象，未核对源码）

- **Claude Code**：用户在工具执行期间中断时，给每个没有结果的 `tool_use` 补一条 `tool_result`，内容是
  「[Request interrupted by user for tool use]」，保证下一轮请求合法。
- **Codex CLI**：Turn 被中止时，给未完成的 function call 记一条 `aborted` 的输出。

两者的共同点：**不删除调用，而是补一个结果**。调用已经发出、可能已经产生副作用，这件事应该让模型知道。

## 目标

- Run 以任何方式结束，落库的 transcript 都满足 `validateTranscriptBatches`。
- 同一批里已经完成的调用，保留真实结果。
- 没完成的调用，补一个说明「被中断」的错误结果，并区分「还没开始执行」和「执行到一半，可能已经产生副作用」。
- transcript 校验失败时，`internal_error` 能直接看出原因。

## 非目标

- 不改取消本身的语义：取消后照样不再产生完成事件，照样不补发 `tool.completed`。
- 不做「Run 与 SSE 解绑」，那是另一份方案。本方案修好之后，刷新页面仍然会取消 Run，只是不会再把会话搞坏。
- 不做读取时的兜底修复。存量数据是干净的，写入端修好就够了；读取时再修一遍会掩盖以后的新 bug。

## 设计

### 1. 新增错误码 `TOOL_INTERRUPTED`

在 `src/protocol.ts` 的 `ToolErrorCode` 和 `src/transcript.ts` 的 `toolErrorCodeSchema` 里登记。
新增 `src/agent-tool-interruption.ts`：

```ts
export type InterruptedPhase = "not_started" | "running";

export function interruptedToolResult(
  call: NativeToolCall,
  phase: InterruptedPhase,
  reason: "cancelled" | "failed",
): ToolResult;
```

它生成的是 `status: "error"`、`code: "TOOL_INTERRUPTED"` 的结果，message 按阶段和原因取以下四种之一：

| | 用户取消 | Run 出错 |
|---|---|---|
| 未开始 | Run 在执行这个工具之前被用户取消，工具没有执行。 | Run 在执行这个工具之前出错结束，工具没有执行。 |
| 执行中 | Run 在这个工具执行期间被用户取消，工具可能已经部分执行，结果未知。 | Run 在这个工具执行期间出错结束，工具可能已经部分执行，结果未知。 |

「执行中」的措辞要明确提醒模型可能有副作用，比如文件写了一半、命令跑了一部分。模型下一轮要先检查现状，
不能当它没执行过。

### 2. 批次在中断时交出部分结果

`executeAgentToolBatch` 捕获中断后，不再直接把原始错误抛出去，而是抛出：

```ts
export class ToolBatchInterruptedError extends Error {
  /** 与 calls 一一对应、顺序一致：已完成的是真实结果，其余是 interruptedToolResult。 */
  readonly results: readonly AgentToolBatchResult[];
  // cause 是原始错误（取消时为 signal.reason）
}
```

- **阶段怎么判断**：已经发过 `tool.started` 的调用（也就是 `launch` 过、进过 `running`）记为 `running`；
  prepare 阶段（等审批、等授权）或队列里还没起飞的，记为 `not_started`。
- **在飞调用的结果**：`executeReadyCalls` 本来就会 `await Promise.allSettled` 等它们落地。工具在执行中
  发现 signal 已 abort 时会直接抛出 `signal.reason`（`src/tools.ts` 的 `execute`），所以被取消的在飞调用
  **拿不到结果**，一律记为 `running` 的合成结果。只有恰好在取消前一刻已经执行完的调用，`allSettled` 里才会
  是 fulfilled，这种情况用它的真实结果。
- **原因怎么判断**：`signal.aborted` 为真时是 `cancelled`，否则是 `failed`。

### 3. agent loop 先补齐 transcript，再往外抛原始错误

`runEventLoop` 的工具步改成：

```ts
transcript.push(assistant toolCalls);
let results: readonly AgentToolBatchResult[];
try {
  yield eventFactory.stepCompleted(stepNumber, "tool", usage);
  signal?.throwIfAborted();
  results = yield* executeAgentToolBatch(...);
} catch (error) {
  transcript.push({
    role: "tool",
    results: error instanceof ToolBatchInterruptedError
      ? [...error.results]
      : turn.calls.map((call) => ({
          toolCallId: call.callId,
          result: interruptedToolResult(call, "not_started", signal?.aborted ? "cancelled" : "failed"),
        })),
  });
  throw error instanceof ToolBatchInterruptedError ? error.cause : error;
}
transcript.push({ role: "tool", results: [...results] });
```

- `stepCompleted` 和 `throwIfAborted` 也放进同一个 `try`，覆盖「调用已压入、批次还没开始」这段空档。
- 往外抛的仍然是原始错误。`exposeRunErrors`、`publicRunError`、取消判断都不用改，`run.error` 的
  code 也不变。
- 子 Run 走的是同一个 `runEventLoop`，自动获得这个行为。

### 4. 兜底断言

`exposeRunErrors` 在调用 `beforeRunFailed` 之前，对要落库的 transcript 跑一次
`validateTranscriptBatches`。如果失败，说明第 3 节有遗漏：

- 往 stderr 写一条 `transcript.invalid_on_failure` 诊断，带 runId 和校验错误；
- **照样落库**，不能因此丢掉整个 Run 的记录。

`beforeRunCompleted` 路径同样加上这个断言。正常完成的 Run 按理不可能不成对，出现了就是 bug。

这里只断言，不修复。理由同「非目标」第 3 条：自动修复会掩盖问题。

### 5. 让 transcript 校验错误能被看见

- 两个 provider 把 `createMessages(...)` / `createInput(...)` 移到 `try` 之前调用，
  `TranscriptValidationError` 原样抛出，不再被包成「request failed」。
- `publicRunError` 把 `TranscriptValidationError` 映射为 `INVALID_TRANSCRIPT`，message 写
  「会话记录不完整，无法继续」，和模型输出非法的 `INVALID_MODEL_OUTPUT` 区分开。
- `formatInternalError`（`agent-loop.ts` 和 `conversation-run-service.ts` 各有一份）改为连同 `cause`
  链一起输出，每层写成 `Caused by: <stack>`，总长仍截断在 64 KiB。重复的两份顺便合成一份。

## 测试

`test/agent-tool-batch.test.ts`（没有就新建）：

- 三个可并行的调用：第一个完成后取消，第二个正在执行，第三个在排队。`ToolBatchInterruptedError.results`
  依次是：真实结果、`running` 的合成结果、`not_started` 的合成结果，`cause` 是 `signal.reason`。
- 取消时恰好有一个在飞调用已经执行完：它保留真实结果，不被合成结果覆盖。
- 在审批等待中取消：该调用得到 `not_started`、`cancelled`。
- 批次内部抛出非预期异常：`reason` 为 `failed`，`cause` 是原始异常。

`test/agent-loop.test.ts`：

- **执行中取消**：落库（`beforeRunFailed`）的 transcript 以 `tool` 消息结尾，能通过 `validateTranscriptBatches`；
  事件流末尾没有 `tool.completed`；在库副本上接一条新的 user 消息后，下一个 Run 能正常请求 provider。
- **`stepCompleted` 之后、批次开始之前取消**：所有调用都是 `not_started` 的合成结果。
- **`agent` 工具执行中取消父 Run**：父 transcript 成对；子 Run 的 transcript 也成对。
- **兜底断言**：构造一个绕过第 3 节的失败路径（比如假的 batch 直接抛错），stderr 出现
  `transcript.invalid_on_failure`，Run 照样落库。

provider 测试：

- 传入不成对的 transcript，两个 provider 都抛 `TranscriptValidationError`，不是 `…ProviderError`。

`test/conversation-run-service.test.ts`：

- 端到端：工具执行中取消，然后在同一个会话里再发一条消息，第二个 Run 正常完成，provider 收到的
  transcript 里有那条 `TOOL_INTERRUPTED` 结果。
- `internal_error` 里包含 `Caused by:`。

## 验收

1. `npm run check`、`npm test` 通过。
2. （宿主）起服务，让 Agent 跑一个耗时的 bash（比如 `sleep 30`），执行期间刷新页面。然后在同一个会话里
   发「继续」，Run 能正常开始，模型能说出上一个命令被中断了。
3. （宿主）同样的操作，改成在工具审批弹窗等待时刷新页面。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/protocol.ts`、`src/transcript.ts` | 错误码 `TOOL_INTERRUPTED` |
| `src/agent-tool-interruption.ts` | 新增，`interruptedToolResult` |
| `src/agent-tool-batch.ts` | `ToolBatchInterruptedError`，记录调用阶段，保留已完成调用的真实结果 |
| `src/agent-loop.ts` | 工具步补齐 transcript；兜底断言；`INVALID_TRANSCRIPT`；`formatInternalError` 带 cause |
| `src/providers/openai.ts`、`deepseek.ts` | transcript 校验移出 `try` |
| `src/application/conversation-run-service.ts` | 共用 `formatInternalError` |
| `web/src/…` | `TOOL_INTERRUPTED` 的工具卡片显示为「已中断」（如果现有错误卡片的文案不合适） |
| `docs/runtime-boundaries.md`、`docs/architecture-decisions.md` | 取消时 transcript 的收尾规则 |

## 待定

1. **Run 出错（不是取消）时也补合成结果吗？** 我倾向于补：不补的话，一次内部异常同样会让会话从此不可用。
