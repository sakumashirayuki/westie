// 桌面版验收与配置的唯一说明文件；其他文档只指向这里。
# macOS 桌面版（westie）

首期交付自用 macOS 应用：Electron 窗口加载随包分发的独立 Node 后端，继续使用现有页面、HTTP API 和 SSE。Web 运行方式保持不变，技术方案见 [docs/plans/2026-10-18-macos-desktop-technical-spec.md](./plans/2026-10-18-macos-desktop-technical-spec.md)。

## 环境要求

- macOS（首期只在 Apple Silicon 上构建和验证 arm64）
- Node.js 22.23 或更高版本、npm 10 或更高版本（仅开发机需要，用户机器不需要）
- macOS Command Line Tools（构建进程收容 helper）
- 首次准备依赖：在仓库根目录执行 `npm ci`，同时安装后端和 Web 依赖。

## 开发与打包

```bash
npm run desktop:dev     # 构建后端/页面 → 准备 runtime → 启动 Electron
npm run desktop:pack    # 构建 → 准备 runtime → 生成 arm64 .app 与 dmg
npm run test:desktop    # 桌面进程与 runtime 准备用例（不启动真实后端）
```

- `scripts/prepare-desktop.mjs` 在 `.desktop-runtime/dev-runtime` 内准备独立 Node（版本固定在该脚本的 `NODE_VERSION`）、后端生产依赖、`dist/src`、`dist/native`、`web/dist` 和 `desktop/backend-entry.mjs`。构建产物缺失时脚本直接报错。
- Node 压缩包及官方 SHA256 校验值保存在 `.desktop-cache/node/`，按版本、系统和架构区分。每次准备 runtime 时校验缓存，命中后无需请求 Node 下载站；缺失或校验失败时重新下载并校验。清理 `.desktop-runtime` 会保留缓存；删除 `.desktop-cache` 可清空缓存。后端生产依赖仍通过 `npm ci` 安装。
- 开发模式从 `.desktop-runtime/dev-runtime` 解析 runtime，安装版从 `Contents/Resources/runtime` 解析，其余启动流程相同。
- 修改前端、后端或 Electron 代码后，退出应用再执行 `npm run desktop:dev`。桌面开发与安装版共用同一个用户数据目录和应用身份，运行桌面开发前先退出已安装的 westie。

## 用户目录

```text
~/Library/Application Support/westie/
  .env                        首次启动生成的配置，权限 0600
  agent-harness.sqlite        桌面版独立数据库（含 -wal、-shm）
  logs/backend.log            后端 stdout/stderr，每次启动截断，单次上限 10 MiB
```

首次启动会生成配置模板并弹出提示，通过“配置”菜单的“打开配置目录”编辑，重启后生效。首期没有配置页面，也不热更新配置。

## 配置

- 模板只含 Provider、API Key、模型容量、`TAVILY_API_KEY` 和可选 `PATH`；不包含 `HOST`、`PORT`、`AGENT_DATABASE_PATH`、`CORS_ALLOW_ORIGIN`。
- 变量优先级：继承环境 → 用户 `.env` → 桌面宿主固定值。宿主固定 `HOST=127.0.0.1` 与 `PORT=3000`（仅供现有配置校验），写入用户目录数据库的绝对路径，并删除 `CORS_ALLOW_ORIGIN`。端口由 `startAgentServer({ port: 0 })` 交给操作系统分配。
- `PATH` 由用户 `.env` 或继承环境的条目，加上 `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` 去重组成。通过 nvm 等安装的命令需要在 `.env` 里补上 bin 目录，或在 MCP 配置里写绝对命令路径；首期不执行用户的 shell 初始化文件。
- 应用内 Node 只用于启动后端，不替换用户工具链的 node。应用不打印完整环境或密钥；后端日志沿用已有内容，不宣称完全无敏感数据。

## 生命周期

- 双击应用：获取单实例锁 → 读取配置 → 用 `runtime/bin/node` 启动 `desktop/backend-entry.mjs`（`cwd` 为 runtime 根目录，stdio 为 `["ignore","pipe","pipe","ipc"]`）→ 后端监听 `127.0.0.1:0` 后通过 IPC 发送唯一的 `{ type: "ready", url }` → 窗口加载该 URL。
- 启动最多等待 30 秒；spawn 失败、配置错误、超时或就绪前退出都会显示原生错误对话框，并带上日志路径。
- 运行中后端异常退出时关闭窗口、显示错误并结束应用；首期不自动重试正在执行的任务。
- 关闭最后一个窗口或按 Cmd+Q：发送 `{ type: "shutdown" }`，最多等待 20 秒；超时强制终止并记录异常退出。下次启动由已有 `recoverStaleRuns()` 恢复未完成记录。
- Electron 意外退出导致 IPC 断开时，后端执行同样的清理。后端被 SIGKILL 或失去调度能力时，无法保证 detached MCP 和外部工具被清理，这是首期保留的边界。

## 窗口与执行边界

窗口使用 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`，保持 `webSecurity` 开启，只允许导航到本次后端 Origin。外部 HTTP/HTTPS 链接交给系统浏览器，其他协议拒绝。页面不增加 preload 或 IPC API；HTTP 仍只绑定 loopback，随机端口不承担身份认证。

文件与目录选择继续使用后端 osascript；工作区来自用户选择的 canonical path，与后端启动 cwd 分开。Seatbelt 权限、Full Access 和 MCP 执行方式不变。

## 数据

桌面版使用独立数据库，现有 Web 数据库保留，表结构与迁移规则见 [数据结构与迁移](./data-storage.md)。

窗口内左栏的会话呈现与操作语义见 [侧栏会话区](./sidebar-conversations.md)，与 Web 版共用同一套界面。

桌面版与 Web 版共用同一套迁移：启动时按 `PRAGMA user_version` 把库升级到当前版本，不删库重建。升级前的备份由使用者自行负责。

## 验收记录

1. 后端生命周期：`server-lifecycle` 与 `shutdown` 用例覆盖端口 0、幂等 close、运行中取消与资源释放；`npm run test:desktop` 用假 Node 可执行文件覆盖 ready、早退、超时、非法 URL、父通道断开、shutdown 超时强杀和非零退出。（通过）
2. 打包内容：`electron-builder --mac --arm64 --dir` 生成的 `.app` 放在含空格的路径下检查；`runtime/bin/node`、`runtime/dist/native/process-containment-helper` 与主可执行文件均为 arm64 且可执行；包内没有仓库 `.env`、`.data`、用户数据库和服务日志；`Contents/Resources/runtime` 含 `node_modules`（openai、yaml、zod）。（通过）
3. 打包后的后端：用包内 `runtime/bin/node` 启动 `runtime/desktop/backend-entry.mjs`，收到 `{"type":"ready","url":"http://127.0.0.1:60580"}`，`GET /`（Accept: text/html）返回 200 且含 React 根节点，`GET /v1/agent/conversations` 返回 200，发送 shutdown 后退出码 0。（通过）
4. 安装包产物：`electron-builder --mac --arm64` 生成 `dist-desktop/westie-0.1.0-arm64.dmg`（约 171 MB，`.app` 约 444 MB），未签名、未公证。（通过）
5. 回归：`npm run check` 通过；`npm run test:desktop` 10 项通过；Web 前端 31 个测试文件、241 项通过；Web 版 3000 端口服务在验证期间保持运行。（通过）
6. 需要图形会话的人工验收（本环境无法完成，见下）：从 Finder 双击打开窗口；窗口内选择工作区并对话、执行 read/Bash、触发审批、连接 stdio 与 HTTP MCP、文件选择器确认与取消、退出后重开读取历史；在流式生成、待审批、Bash 执行、MCP 运行期间分别退出并检查无残留进程；重复启动只有一个后端；运行中后端异常退出有提示。

实测环境：macOS 15.7.7、arm64、开发机 Node v22.23.1、打包后端 Node v22.23.1、Electron 44.9.0（内置 Node 24.22.0）。启动时长尚未实测。

### 本环境的限制

当前会话运行在受限沙箱里：`sandbox-exec` 直接执行返回 `sandbox_apply: Operation not permitted`，Electron 渲染进程初始化同样失败（`sandbox initialization failed: Operation not permitted`，GPU 进程随之退出）。因此：

- `npm run test:server` 中依赖真实 Seatbelt 的 `macos-seatbelt-sandbox-runner` 与 `runtime`（默认工具）用例会以 `SANDBOX_UNAVAILABLE` 失败，这是环境限制，不是代码回归。
- 无法在本环境打开 Electron 窗口，第 6 条只能由有图形会话的开发机完成。

## 已知限制

- 未签名、未公证：只用于自用，跨机器分发的签名、公证和带隔离属性的安装验证不在首期。
- 不支持 Windows 与 Linux；Intel 构建需在对应架构验证后提供。
- 没有桌面内热更新；页面开发继续使用 Vite 流程（`npm run build:server` + `npm run start:server` + `npm run dev:web`）。
