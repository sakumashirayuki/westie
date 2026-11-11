# 工具与 MCP 配置

默认注册以下本地工具：

- `get_current_time`：查询指定时区的当前时间
- `read`：按行读取 workspace 内的 UTF-8 文本文件，默认单次返回 1000 行；Web 会话可经系统文件选择器单次授权读取一个项目外文件
- `grep`：使用 ripgrep 正则搜索文件内容，支持限定路径和 glob，返回路径、行号和匹配行
- `glob`：用 gitignore 风格的 glob 按文件名找文件，返回按修改时间倒序的 workspace 相对路径
- `write`：创建或完整覆盖 workspace 内的文本文件
- `edit`：按唯一文本匹配编辑 workspace 内的文件
- `web_search`：通过 Tavily Basic Search 查询网络，返回最多 5 条标题、链接、摘要和相关度
- `web_fetch`：抓取一个公开 HTTP(S) URL，把 HTML 转成带标题、列表和链接的可读文本，`offset`/`limit` 分页长页面
- `todo`：维护当前任务步骤清单。每次提交整份清单替换上一条；清单不落库，只留在 transcript 里，Web 端把它渲染成任务卡片
- `skill`：当 workspace 或用户主目录存在合法 Skill 时，按名称加载完整 `SKILL.md`
- MCP 工具：来自用户级 `~/.agents/mcp.json` 与 workspace 级 `.agents/mcp.json` 配置，名字形如 `mcp__<server>__<tool>`，其余与内建工具一样参与校验、并行、结果边界和上下文预算
- `memory`：读写当前项目的跨会话记忆文件（仓库外的 Markdown），只在父 Agent 注册；见 [项目记忆](./project-memory.md)
- `bash`：在 macOS Seatbelt 沙箱中从 workspace 根目录执行 zsh 命令
- `agent`：把一个自足的子任务交给子 Run。子 Run 用同一 Provider、同一套工具（不含 `agent`、`memory` 与项目记忆区块）和同一权限边界在全新 transcript 上运行，最多 128 步，只把最终回答作为工具结果放回父 transcript；同一批次里的多个 `agent` 调用并行执行。仅 Web 会话注册，CLI 不注册

CLI 以启动进程时的当前目录作为 workspace root；Web 运行台要求用户先通过 macOS 系统目录选择器打开项目，创建的 Conversation 在整个生命周期内固定绑定该 canonical workspace。

每个 Web Conversation 创建时必须选择不可变的执行模式。`workspace_sandbox` 下，`write`、`edit` 会拒绝 workspace 路径逃逸和指向外部的符号链接；`read`、`grep` 默认采用相同边界，项目外普通文件只有 `read` 可以通过系统选择器获得单次授权；每次 Bash 仍要求单次确认。`full_access` 下，`read/grep/write/edit/bash` 可访问宿主用户可访问的任意文件和网络，Bash 直接执行。两种模式的子进程都使用环境变量白名单，Harness 的模型和 Tavily API Key 均保留在主进程；Full Access 可直接读取磁盘中的凭据文件。

`web_search` 在两种执行模式下均可直接使用。Harness 主进程把查询词发送给 Tavily 固定搜索接口，采用 Basic Search，并关闭 Tavily 生成式答案、原始网页正文和图片。工具返回搜索结果摘要，结果页由使用者按需访问。Tavily API Key 保留在 Harness 主进程环境中。

`web_fetch` 同样在两种模式下免审批。它由 Harness 主进程发起 GET 抓取，不携带本机 Cookie 或凭据，固定 User-Agent；响应体上限 2 MiB，转换后文本单次上限 48 KiB、输出上限 96 KiB，用 `offset`/`limit` 续读。`workspace_sandbox` 下只允许公开地址：回环、私网（RFC 1918）、链路本地、IPv6 ULA、`localhost` 与 `.local` 域名都会被拒绝；`full_access` 下不做地址检查，与该模式下 Bash 可访问任意网络一致。已知缺口是地址检查用的 DNS 解析与 `fetch` 实际连接用的解析是两次查询，存在 DNS rebinding 窗口，Node 内建 `fetch` 不暴露连接钩子，见 [运行边界](./runtime-boundaries.md)。

## MCP 工具配置

MCP Server 配置有两个位置，格式相同：跟人走的放 `~/.agents/mcp.json`，所有 workspace 可见；跟仓库走的放 `<workspace>/.agents/mcp.json`。两份按 Server 名合并，同名以 workspace 的为准。

```jsonc
{
  "servers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    },
    "internal-docs": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_MCP_TOKEN}" }
    }
  }
}
```

- `type` 为 `stdio`（Harness 起子进程）或 `http`（Streamable HTTP 端点）。
- `env` / `headers` 里的 `${VAR}` 从 Harness 进程的 `.env` 展开，展开值不回文件、不进 transcript、不进诊断；变量缺失时该 Server 被跳过。
- 模型看到的是 `mcp__<server>__<tool>`：`mcp__github__create_issue`。
- `workspace_sandbox` 下每次 MCP 调用需要用户确认（工具在沙箱外执行），可选「本会话允许」；`full_access` 下不审批。MCP 工具不进并行列表，v1 串行执行。
- Server 起不来、配置非法或单个工具 schema 转不成 zod 时只产生 stderr 诊断并跳过，不影响 Run 和其他 Server；一份配置文件非法也不影响另一份。文件规则同 `AGENTS.md`（普通文件、拒绝符号链接、上限 64 KiB、严格 UTF-8，用户级文件须在主目录内），改配置下一个 Run 生效。
- 用户级配置里 stdio 的 `cwd` 按主目录相对路径解析；workspace 级 stdio 的 `cwd` 按 workspace 相对路径解析。Server 连接按 workspace 分别建立，全局 Server 在每个 workspace 各起一份。

## MCP 设置面板

Web 运行台右上角的「MCP 设置」按钮打开一个面板，图形化管理用户级 `~/.agents/mcp.json`，不需要手写 JSON：新增 / 编辑 / 删除 Server、切换 stdio/http 类型、维护 `env` 与 `headers`（键值对，支持 `${VAR}`）、填 `timeoutMs`，「测试连接」会真起一个进程连一次并回报成功或失败原因。保存走全量覆盖写回 `~/.agents/mcp.json`，下一次 Run 生效。

- 面板只管理用户级配置；workspace 级 `<workspace>/.agents/mcp.json` 仍按文件进版本库，不在面板里编辑。
- 读写与测试连接都要求受信任的宿主动作 Origin；写回还要求服务绑定 loopback（非 loopback 绑定的服务拒绝），因为 stdio Server 在宿主机直起、能执行命令。
- 表单里的 `env` / `headers` 原样保存（含 `${VAR}` 引用），保存前会校验每个 `${VAR}` 是否已在 `.env` 里定义，缺失会就地报错而不会留到 Run 时才失败。
