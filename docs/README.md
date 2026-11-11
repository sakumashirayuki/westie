# 项目文档

这里汇总使用说明、运行机制、设计背景和语义边界。

## 导航

- [工具与 MCP 配置](./tools-and-mcp.md)：内置工具、执行模式和 MCP Server 配置。
- [项目记忆](./project-memory.md)：跨 worktree 共享的 Markdown 记忆、加载上限、工具和并发规则。
- [Stop Hook](./stop-hook.md)：完成检查的配置和执行规则。
- [Web 服务与会话](./web-runtime.md)：HTTP 接口、持久化和会话诊断。
- [Agent 运行机制](./agent-runtime.md)：运行限制、模型协议、上下文和代码结构。
- [架构决策](./architecture-decisions.md)：自定义 Agent 协议、Provider 分层及 Tool 消息映射的原因。
- [运行边界](./runtime-boundaries.md)：CLI 会话生命周期、滑动窗口、超时与重试的准确语义。
- [侧栏会话区](./sidebar-conversations.md)：会话显示名、运行状态标记、行内操作菜单与改名/删除流程。
- [数据结构与迁移](./data-storage.md)：SQLite 结构版本、每个版本的列变更、升级与降级边界。
- [流式 SSE 协议](./streaming-sse.md)：POST SSE 端点、事件顺序、取消与背压边界。
- [macOS 桌面版](./macos-desktop.md)：Electron 窗口、独立 Node 后端、用户目录配置与桌面验收清单。

## 维护原则

- 按主题建文档，不维护单一的全量汇总文件。
- 新主题新增文件；已有主题只更新对应文件。
- 使用说明与实现细节按主题维护，并在入口处提供链接。
- 只记录仍然成立的结论；设计改变时同步更新或删除过时内容。
