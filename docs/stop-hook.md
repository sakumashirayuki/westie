# Stop Hook（项目完成检查）

项目可以在 `.agents/stop-hook.json` 配置一个完成检查脚本。主 Run 的模型给出最终回答、且当前子任务和用户追加消息都已处理完毕之后，Harness 先执行该脚本；只有脚本放行，候选回答才会作为最终回答发布并落库。CLI、子 Run 和上下文摘要调用不执行检查。

```json
{"command":"node .agents/check-completion.mjs","timeoutMs":30000,"maxContinuations":2}
```

| 配置项 | 含义 | 默认值 | 约束 |
| --- | --- | --- | --- |
| `command` | 检查脚本命令 | 必填 | 非空，UTF-8 上限 8 KiB，由 `/bin/zsh -f -c` 在 workspace 根目录执行 |
| `timeoutMs` | 单次检查超时 | 30000 | 整数 100–120000 |
| `maxContinuations` | 每个 Run 允许脚本要求补做的次数 | 2 | 整数 0–5 |

配置文件的规则与 `AGENTS.md` 一致：必须是 workspace 内普通文件，`.agents` 目录和配置文件都拒绝符号链接，上限 64 KiB，要求严格 UTF-8，拒绝未知字段。配置在每个主 Run 开始时读取一次，运行中修改不影响当前 Run；文件缺失表示不启用检查。配置文件存在但非法时，本轮以 `STOP_HOOK_CONFIG_INVALID` 失败。

脚本从 stdin 读取一个 JSON 对象（`event`、`conversationId`、`runId`、`workspaceRoot`、`executionMode`、`input`、`step`、`continuations`、`candidateAnswer`、`transcript`），stdout 只输出以下两个对象之一，stderr 写日志：

```json
{"decision":"allow"}
```

```json
{"decision":"block","reason":"空输入测试未通过，请修复后继续验证。"}
```

空 stdout、多个 JSON 对象、未知字段、空 `reason`、超过 4 KiB 的 `reason`、非零退出码都算检查故障。检查通过内部 `stop_hook` 工具执行：该工具对模型不可见，沿用会话的执行模式、Seatbelt 策略、资源限制、白名单环境、取消和进程清理；`workspace_sandbox` 下每次检查都要单独批准且不提供会话级授权，`full_access` 下免审批。Harness 不向脚本提供模型 API Key，脚本自行调用模型产生的用量不计入 `run_model_calls`。

| 情况 | 结果 |
| --- | --- |
| 放行 | 候选回答作为最终回答发布，按原有流程落库 |
| 要求继续 | 被拒绝的候选回答不发布、不写入 transcript；以 `source: "stop_hook"` 的 user 消息记录原因，模型在当前 Run 内补做 |
| 拒绝次数达到 `maxContinuations` | 本轮以 `STOP_HOOK_LIMIT_REACHED` 失败 |
| 检查执行失败、超时、输出非法或未获批准 | 本轮以 `STOP_HOOK_FAILED` 失败；`run.error` 的 message 以具体错误码开头，例如 `COMMAND_TIMEOUT: Command timed out after 30000ms.`、`STOP_HOOK_OUTPUT_INVALID: The completion check did not print a single JSON object on stdout. stderr: ...`，前端先收到 `tool.completed(status=error)` 再收到 `run.error` |
| 检查期间到达用户追加消息 | 该次结果记为未应用（`applied:false`）、不消耗补做次数，模型先处理新消息再重新检查 |
| 达到步数上限的交接步 | 不执行检查，`stopReason` 为 `step_limit`，界面提示交接内容未经过完成检查 |

检查的输入 JSON 上限 8 MiB，脚本 stdout 与 stderr 合计上限 48 KiB，两者超限都按检查故障处理。每次检查都写一条 `source:"stop_hook"` 的 user 消息，字段是 `command`、`step`、`decision`（`allow` / `block` / `error`）、`reason` 与 `applied`：应用了的拒绝是当前 Run 补做的依据，放行和未应用的过期结果只是历史证据，故障记录带 2 KiB 以内的诊断摘录。记录在 assistant 最终回答之前写入，候选回答全文不写入历史。
