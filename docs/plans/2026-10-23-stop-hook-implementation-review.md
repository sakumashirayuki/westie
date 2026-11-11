# Stop Hook 实施前核对

状态：待确认。事实基线：`262ff2c4b6bf6d247d46f59609ee1c9897b10a31`（本分支 `feature/stop-hook` 的起点）。
对应[产品方案](./2026-10-23-stop-hook-product-spec.md)与[技术方案](./2026-10-23-stop-hook-technical-spec.md)。

技术方案的接口、错误码、进程模型、数据库影响和测试矩阵与当前代码一致，可以按第 6.1 节的顺序实施。下面四条是方案文字与当前代码不一致、或方案未写清的地方，每条给出当前代码行为、冲突点和本文采用的解释。

## 1. Web 轨迹的 `step.completed` 文案

**当前实现。** `web/src/components/RunTrace.tsx` 把 `step.completed.actionType` 映射为三步：`final` 显示“生成回答”，`tool` 显示“调用工具”，其余显示“思考中”。

**冲突。** 技术方案 3.5 第 8 步要求检查拒绝时发布本步 `step.completed(waiting)`。`waiting` 在 Web 上显示为“思考中”，而这一步的实际含义是“完成检查要求继续”。方案 3.10 没有新增事件类型，也没有给出该步的文案。

**采用的解释。** `actionType` 枚举保持不变，只在 `RunTrace` 里根据该步已有的 `stop_hook` 工具轨迹，把“思考中”改为“完成检查要求继续”。公开事件结构不变。

## 2. `runs.system_prompt` 快照是否包含 Hook 段落

**当前实现。** `ConversationRunService.#runEvents()` 组装 system prompt 后立即调用 `recordRunSystemPrompt` 落库，运行期使用的也是同一份字符串。

**冲突。** 方案 3.8 要求系统提示词解释 `stop_hook_result`，但 4.1 对 `conversation-run-service.ts` 的改动只写了“读取配置、构建脚本 Hook，并注入父循环”。

**采用的解释。** 每个 Run 在组装 prompt 前先确定是否启用 Hook（读取配置），再调用 `assembleSystemPrompt({ stopHook })`；快照包含 Hook 段落，与运行期一致。未配置项目的 prompt 逐字节不变。

## 3. 宿主 runner 的 stdin

**当前实现。** `HostSandboxRunner` 用对象展开把 `SandboxCommand` 透传给 `runSpawnedCommand()`；`MacOsSeatbeltSandboxRunner.run()` 逐字段构造 `runSpawnedCommand()` 的参数。

**采用的解释。** `SandboxCommand` 与 `SpawnedCommand` 增加可选 `stdin?: string`；`runSpawnedCommand()` 在注册完所有监听器后 `child.stdin.end(stdin)` 并监听 stdin 的 `error` 事件（EPIPE 不产生未处理异常，其余写入错误进入现有终止清理路径）；`MacOsSeatbeltSandboxRunner.run()` 显式透传。`HostSandboxRunner` 不改代码，由单元测试覆盖。

## 4. `workspace_sandbox` 下 `stop_hook` 的授权范围

**当前实现。** 默认策略链为 `fullAccessAllowsEverything → conversationGrantsUpgradeConfirm → mcpToolsNeedConfirmation → fixedRules`。`conversationGrantsUpgradeConfirm` 自己调用 `ToolGrantStore.matchedScopeKind()` 判断命中，不经 `deriveGrantOptions()`。

**冲突。** 技术方案 4.2 只让 `deriveGrantOptions("stop_hook", ...)` 返回空数组。该函数只决定审批卡片提供哪些授权按钮，`InteractionBroker.isValidResponse()` 也不读它的返回值，因此会话级授权仍然能被升级成 allow，与“每次检查单独批准”不符。

**采用的解释。** 两处都按方案做：`deriveGrantOptions("stop_hook", ...)` 返回空数组（审批卡片只有“允许一次”），`conversationGrantsUpgradeConfirm` 对 `stop_hook` 直接返回后一层的决定（策略层不把会话授权升级成 allow），`fixedRules` 增加 `stop_hook: confirm`。`full_access` 仍由链首直接 allow。测试覆盖两处：`test/tool-grants.test.ts` 断言没有会话级候选，`test/tool-permissions.test.ts` 预先写入 `stop_hook` 会话级授权后策略仍返回 confirm。

补充：当前 HTTP 交互响应 schema（`src/http/interaction-routes.ts`）还不接受 `grant` 字段，所以会话级按钮即使出现也无法通过 HTTP 生效；这是既有问题，本 MR 不依赖它。

## 5. 检查记录的范围

初版实现只把“已应用的拒绝”写进 transcript，放行与因 steering 作废的结果都丢弃。这个取舍当时没有依据：放行记录决定了会话历史里能否看出“这一轮检查过并通过”，作废记录是 `applied:false` 的唯一来源，故障记录决定了本轮失败后能否诊断出是脚本挂了。现在三条路径都写记录：

| 情形 | decision | applied | 写入位置 |
| --- | --- | --- | --- |
| 检查故障（含未获批准、超时、输出非法） | `error` | `false` | 发布 `tool.completed(status=error)` 之后、抛出 `STOP_HOOK_FAILED` 之前，带 2 KiB 诊断摘录。检查自己已发布完成事件时不补发；只有检查没发出完成事件时才由编排模块补一条，前端始终只有一张卡片 |
| 检查期间到达新消息或子任务结果 | 实际结果（`allow` / `block`） | `false` | 作废候选、进入下一步之前 |
| 应用了的拒绝 | `block` | `true` | 继续补做之前 |
| 放行 | `allow` | `true` | assistant 最终回答之前 |

用户取消不写记录：取消走原有 cancelled 路径，脚本输出不作为证据。作废判断直接看 steering 队列与子任务状态，不复用 `needsBarrierToContinue()`——后者在没注册 steering 订阅时不做检查。

## 6. 检查失败的诊断信息

初版实现把两种失败原因都压成了同一句话：`ToolRegistry` 只对 `ToolExecutionError` 保留错误码，脚本退出码非 0、stdout 非法等协议错误被包装成 `TOOL_EXECUTION_FAILED` + “Tool execution failed.”，而 `SandboxRunnerError`（超时、输出超限、资源上限、收容失败）没有转换，同样落成这句话。现在：

| 失败来源 | 工具错误码 | message |
| --- | --- | --- |
| `SandboxRunnerError`（超时、输出超限、CPU/内存/进程/磁盘上限、收容失败、沙箱不可用） | runner 的原始码，如 `COMMAND_TIMEOUT` | runner 的原始消息 |
| 脚本退出码非 0、stdout 不是单个 JSON、决策字段非法、`reason` 超长 | `STOP_HOOK_OUTPUT_INVALID` | 具体说明 + stderr 摘录（上限 2 KiB） |
| 审批被拒/过期、未获批准 | `TOOL_APPROVAL_DENIED` / `TOOL_APPROVAL_EXPIRED` | 工具层原有消息 |
| 输入 JSON 超过 8 MiB | `STOP_HOOK_INPUT_TOO_LARGE` | 超限说明 |

决策形状用 zod 的 `discriminatedUnion` + `strictObject` 校验（`reason` 非空、按 UTF-8 字节 ≤ 4 KiB），失败详情由 `z.prettifyError()` 生成，会指出具体字段，例如 `✖ reason must be at most 4096 bytes → at reason`。决策在校验后才离开 `stop_hook` 工具，所以字段级说明随 `tool.completed(status=error)` 和 `run.error` 一起到达前端。

zod 4.4.3 的 `strictObject` 在未知键检查中跳过 `__proto__`，脚本输出里的顶层 `__proto__` 键会被放过；`parseDecision` 先显式拒绝这个自有键（`Object.hasOwn`），再交给 zod 校验，严格输出契约不依赖 zod 版本行为。

`StopHookFailedError` 携带这个 `code`，`run.error` 的 message 统一为 `<code>: <message>`，检查记录里的 `reason` 也是同一串。前端先收到 `tool.completed(status=error)` 再收到 `run.error`，卡片不会停在“执行中”。`STOP_HOOK_OUTPUT_INVALID` 是新增的工具错误码，只出现在 `stop_hook` 这个内部工具上。

## 7. 主循环与检查模块的职责划分

主循环只控制执行顺序：处理取消与用户追加消息，判断继续还是结束，并且只读检查的返回值。检查的其余职责全部在 `src/application/stop-hook-session.ts`：

| 位置 | 负责 |
| --- | --- |
| `agent-loop.ts` | 结束屏障、`yield*` 转发检查事件、按返回值决定继续或接受、取消复查、`step.completed` 与 `run.completed`；不捕获检查异常 |
| `application/stop-hook-session.ts` | 组装检查输入、转发检查事件、捕获 `StopHookFailedError` 并写故障记录与补发完成事件、写放行/拒绝/过期记录、执行 `maxContinuations`、判断候选是否过期 |
| `application/command-stop-hook.ts` | 启动脚本进程、stdin 输入与 stdout 决策解析、把脚本与 runner 错误转换成带诊断码的异常 |

结束路径读起来是四步：

```ts
// 1. 是否还有待处理输入（结束屏障）
const barrier = needsBarrierToContinue(options);
// 2. 执行完成检查（事件原样转发；失败由检查模块记录后抛出）
const checked = yield* runStopHookCheck({ hook: stopHook, transcript, step: stepNumber, candidateAnswer: content, appliedRejections, eventFactory, signal }, isStale);
// 3. 复查取消与新输入
signal?.throwIfAborted();
if (checked.kind !== "allowed") { yield stepCompleted(waiting); return { done: false, ... }; }
// 4. 接受最终回答
yield* acceptFinalAnswer(...);
```

主循环不再检查 `tool.completed` 的内容：事件只负责展示，检查的返回值与异常负责控制执行，两套判断只剩一处。补做次数是主循环里的一个数字 `appliedRejections`，`StopHookOutcome.rejected` 直接返回新的数字。

## 8. 实施顺序

按技术方案 6.1 的四步，每步完成后提交一次，最后统一补 README 与 `docs/runtime-boundaries.md`。宿主测试环境当前为 `MY_AGENT_HARNESS_SANDBOX=full-access-tagged`，需要真实创建 Seatbelt 的用例标记为待宿主验证。
