# 项目记忆

项目记忆是保存在本机、不随仓库提交的 Markdown 文件。同一 Git 仓库的主工作目录、worktree 和子目录共用一个记忆目录；不同仓库和独立 clone 分开。用户在会话中明确说出「记住 / 修改 / 忘记」时，父 Agent 用 `memory` 工具读写这些文件并报告结果。

## 目录位置与归属

| 配置 | 来源 | 必填 | 默认值 | 作用 |
| --- | --- | --- | --- | --- |
| `AGENT_MEMORY_ROOT` | 服务环境变量 | 否 | 服务账号 home 下的 `.my-agent-harness/memory` | 记忆根目录；设置时必须是绝对路径，否则服务启动失败 |

每个项目占根目录下一个以 `sha256(UTF-8(projectKey))` 命名的子目录。`projectKey` 复用会话已保存的项目身份：Git 仓库是 `git:<canonical common dir>`，普通目录是 `dir:<canonical directory>`。例如 `/repo/app` 与 `/repo/worktrees/fix` 的 common dir 都是 `/repo/app/.git`，两者读写同一个目录。

- 会话已保存项目身份时，Run 直接使用它。
- 历史会话没有保存身份时，Run 复用项目识别读取当前工作目录。已知工作区类型是 `main`、`worktree` 或 `subdirectory` 时只接受 `git:` 身份；Git 不可用、超时或解析失败时，本轮记忆不可用，会话照常运行。
- 记忆目录按需创建，权限为用户私有。

## 文件格式

`MEMORY.md` 是启动索引，其余 `.md` 是详情文件。文件是唯一权威数据，可以用任意编辑器直接修改。system prompt 的记忆说明和 `memory` 工具描述都会写明这一点；`list` 在记忆目录存在时总包含 `MEMORY.md`，即使它尚未创建。

`list` 只返回名字符合工具规则、且确实是普通文件的条目；名字被目录或符号链接占用时不列出。`write` 遇到被占用的名字返回 `EDIT_CONFLICT` 并提示换名，不会替换该条目。

```text
~/.my-agent-harness/memory/<sha256>/MEMORY.md   - 集成测试需要 Redis；详情见 testing.md
~/.my-agent-harness/memory/<sha256>/testing.md  # 集成测试
                                                执行测试前启动 Redis。
```

## 每个 Run 的加载

父 Run 的 system prompt 里增加一个 `<project_memory>` 区块，内容是有界的 `MEMORY.md`：

| 对象 | 单位 | 上限 | 超限行为 |
| --- | --- | --- | --- |
| 启动索引 | 行 / UTF-8 字节 | 200 行 / 25 KiB | 先到哪个上限就在哪里按完整行截断（约 1 KiB 的行读到第 25 行就停下），文件不变；界面提示未加载，并给出下一行行号 |
| `read` 单次返回 | 行 / 转义后字节 | 200 行 / 32 KiB | 返回完整行与下一行行号；单行超限报错，提示拆行。文件按块流式读取，只保留当前页 |
| `write` 文件内容 | UTF-8 字节 | 1 MiB | 拒绝写入，原文件不变；人工编辑不受限。写前校验以流式哈希读取现有文件，不整份读入内存 |
| 写入等待 | 秒 | 5 | 返回失败，不修改文件 |

索引读取有界：按块读取并逐行累计，下一行放不下时只补读它在预算内的前缀判断是否已结束，然后停止读文件。截断点之后的字节不读入内存，也不参与 UTF-8 校验；截断点之前的非法编码仍报 `unavailable: encoding`。目录不存在是空记忆；目录存在但不可访问、或路径被其他类型占用时，本轮报 `unavailable: read`，不显示为空记忆。

详情文件的 `read` 同样按块流式读取，只保留这一页；返回的 `sha256` 覆盖本次实际读到的字节，`nextLine` 为 null 时就是完整文件的校验值，可直接用于写回或删除。需要修改一个要分页读的大文件时，先把各页读到 `nextLine` 为 null，拼成完整内容再写回；分页未读完的 `sha256` 不能用于写前校验。

索引快照随每个 Run 的 system prompt 记录到 `runs.system_prompt`。同一 Run 使用同一份快照，工具读取的是磁盘当前内容。记忆不可用时，system prompt 不含区块，`memory` 工具不注册，`run.started` 事件带 `{"memory":{"status":"unavailable","reason":"identity" | "read" | "encoding"}}`；截断时带 `{"status":"truncated","nextLine":201}`。

## `memory` 工具

六个输入字段都必填，不适用的填 `null`。

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `action` | 是 | `list`、`read`、`write`、`delete` |
| `file` | 是，可为 null | `list` 为 null；其他动作是单层 `.md` 文件名，UTF-8 字节数不超过 200 |
| `start_line` | 是，可为 null | `read` 的起始行，默认 1 |
| `limit` | 是，可为 null | `read` 的最大行数，默认 50 |
| `content` | 是，可为 null | `write` 的完整新内容 |
| `expected_sha256` | 是，可为 null | 写已有文件或删除时是上次 `read` 返回的校验值；创建文件为 null |

```json
{"action":"write","file":"testing.md","start_line":null,"limit":null,"content":"# 集成测试\n执行测试前启动 Redis。\n","expected_sha256":null}
{"file":"testing.md","sha256":"<64 位十六进制>"}
```

错误码：文件不存在 `FILE_NOT_FOUND`，输入组合非法 `INVALID_TOOL_INPUT`，校验值不符或文件已被创建 `EDIT_CONFLICT`，I/O 错误与写等待超时 `TOOL_EXECUTION_FAILED`。

## 并发与范围

同一服务进程内，同一记忆目录的写入和删除串行执行；取得写入位置后重新计算文件校验值，与 `expected_sha256` 不一致时返回冲突，由 Agent 重新读取后再处理。写入用同目录临时文件加 rename，读取不会看到半成品。外部编辑器和其他服务进程的写入不在保护范围内。

第一版不自动从会话提取记忆，不提供个人跨项目记忆、跨机器同步或独立 clone 共享。忘记只修改或删除记忆文件，不删除会话记录和已记录的 Run system prompt。

## 人工检查

```bash
AGENT_MEMORY_ROOT=/tmp/memory-root node --env-file=.env dist/src/server-main.js
```

在两个同仓库 worktree 的会话里分别要求「记住」和「使用」同一条事实，然后检查 `MEMORY.md` 是否只出现在一个 `<sha256>` 目录下。
