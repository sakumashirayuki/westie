# 左侧导航栏与 MCP 设置弹窗

> 讨论稿。定稿前不动 `src/`、`web/`、`test/`。

## 背景

Web 端现在的左栏只是一个历史会话列表，所有入口都散在主栏的卡片和按钮里。
MCP 用户级配置的图形化管理已经有了后端（读写 `~/.agents/mcp.json` 的两个端点和一个
「测试连接」探测端点）和一个能用的弹窗，但入口是主栏里孤零零的一个「MCP 设置」按钮，
弹窗右上角是一个写着「关闭」的文字按钮，表单把所有 Server 竖着堆在一起。

本方案做两件事：把左栏升级成正式的应用导航，设置类入口都放在这里；MCP 设置保持
弹窗形态，但按通用的弹窗规范重做，内部改成左列表右表单。弹窗底座用组件库，三个
已有弹窗一起迁上去，样式统一。后端接口不动，只修两处语义。

## 已定的决定

1. 左侧栏做成正式的三段式导航。
2. MCP 设置保留弹窗形态，不做成页面。
3. 弹窗形态按通用规范做，可以引入组件库。

## 一、左侧栏

```text
┌──────────────────────────┐
│ ◆ Agent Harness          │  品牌区：产品名
│ [ + 新建会话 ]            │  主操作，打开现有的「选择执行模式」弹窗
├──────────────────────────┤
│ 历史会话              12 │
│ ▸ my-agent-harness  沙箱 │  现有列表原样保留，含删除、加载更多
│   ~/projects/…           │
│   9月22日 11:45 · 4ff6a3 │
│   web-demo        全权限 │
│   …                      │
│                          │
├──────────────────────────┤
│ ⚙ MCP 服务器             │  导航项，打开 MCP 设置弹窗
└──────────────────────────┘
```

- 三段固定：顶部品牌区加主操作，中间会话列表撑满剩余高度并各自滚动，底部导航区。
  以后「通用设置」「关于」这类入口都加在底部区，本方案只加「MCP 服务器」一项。
- 「新建会话」触发的就是现有的 `dispatchProjectOpen({ type: "open" })`。主栏
  `WorkspacePanel` 里的「打开项目 / 打开其他项目」按钮保留，两个入口指向同一个弹窗。
- 主栏里那个「MCP 设置」按钮删掉。
- 导航项的选中态、hover 态与会话列表条目用同一套颜色，图标用 `lucide-react`。
- 窄屏（现有断点 760px）下左栏变成顶部区块：品牌区和导航项收成一行，会话列表折叠成
  最多 64 高度可滚动，与现在的表现一致。
- 实现上把 `ConversationList` 包进新的 `Sidebar` 组件，列表本身不改；`App.tsx` 里
  左栏渲染 `Sidebar`，把「新建会话」与「MCP 服务器」两个回调传进去。

## 二、弹窗底座

引入 shadcn/ui 的做法：不装成品组件包，把 `Dialog` 一个组件的源码放进
`web/src/components/ui/dialog.tsx`，底层依赖 `@radix-ui/react-dialog`，样式是 Tailwind
类，直接套现有的米绿色调色板。图标用 `lucide-react`。新增依赖只进 `web/`，服务端
仍是三个运行时依赖。

统一的弹窗解剖：

```text
┌─────────────────────────────────────────── ✕ ┐  右上角：图标关闭按钮，aria-label「关闭」
│ 小标题（可选，灰色大写字距）                    │
│ 标题                                          │
│ 说明文字（可选）                                │
│                                               │
│ 正文                                          │
│                                               │
│                         [ 次要动作 ] [ 主动作 ] │  底部动作区，右对齐
└───────────────────────────────────────────────┘
```

行为由 Radix 提供，不再手写：焦点困在弹窗内、打开时聚焦第一个可聚焦元素、Esc 关闭、
点遮罩关闭、关闭后焦点回到触发按钮、`aria-modal` 与标题描述的关联。正在提交时
（`submitting`）禁用关闭手段，这一条现有两个弹窗已经有，迁移时保留。

三个已有弹窗都迁到这个底座上：`AccessModeDialog`、`DeleteConversationDialog`、
新的 `McpSettingsDialog`。前两个内容不变，只换外壳。`SubAgentDrawer` 是抽屉不是
弹窗，不动。

## 三、MCP 设置弹窗

```text
┌────────────────────────────────────────────────────────────── ✕ ┐
│ MCP SERVERS                                                     │
│ MCP 服务器                                                       │
│ 管理用户级 ~/.agents/mcp.json，所有项目可用；同名的项目级配置会覆盖它。 │
├──────────────────┬───────────────────────────────────────────────┤
│ [ + 新增 ]        │ 名称        [ playwright            ]         │
│                  │ 类型        (•) stdio   ( ) http              │
│ ● playwright  st │ 命令        [ npx                   ]         │
│ ○ filesystem  st │ 参数        [ -y                    ]         │
│ ○ internal-do ht │             [ @playwright/mcp@latest ]  + 添加 │
│                  │ 环境变量     KEY [        ] VALUE [ ${VAR}  ] + │
│                  │ 超时（毫秒） [ 60000 ]                          │
│                  │                                               │
│                  │ ○ 测试连接    上次：成功，21 个工具              │
│                  │                                 [ 删除此服务器 ] │
├──────────────────┴───────────────────────────────────────────────┤
│ 有未保存的修改                             [ 取消 ] [ 保存 ]      │
└──────────────────────────────────────────────────────────────────┘
```

- 弹窗宽度上限 880px，高度上限 85vh，正文区内部滚动，头尾固定。
- **左列表**：每个 Server 一行，显示名字和类型标签，选中态高亮；行首圆点表示这次
  打开后的测连接结果，灰色未测、绿色成功、红色失败。顶部「新增」加一个空白 Server
  并选中它，名字输入框自动聚焦。空列表时右侧显示引导文字和一个「新增第一个服务器」。
- **右表单**：只显示选中 Server 的字段。类型用单选而不是下拉；`stdio` 显示命令、参数、
  工作目录、环境变量；`http` 显示地址、请求头；两者都有超时。参数是一行一个输入框加
  「添加」，不再是「每行一个」的多行文本；环境变量和请求头是键值两列，同样逐行添加。
  `${VAR}` 的说明放在值输入框的占位文字里。
- **校验**：名字规则（小写字母、数字、单个连字符，1 到 32 位）和必填项在失焦时校验，
  错误显示在字段下方；保存时有任何错误就禁用保存并把第一个错误所在的 Server 选中。
  同名冲突在左列表里标红。
- **测试连接**：只测当前选中的 Server，用的是表单里的草稿而不是已保存的值。进行中
  按钮变为「正在连接…」并禁用；结果显示在按钮旁：成功给工具数，失败给后端返回的
  一句话。结果只在本次打开期间保留。
- **保存**：整份写回，和现有端点一致。有未保存修改时底部左侧显示提示；此时点 ✕、Esc
  或遮罩，弹出一个小的确认弹窗「放弃修改？」，用的是同一个 Dialog 底座。保存成功后
  弹窗保持打开，提示变为「已保存」两秒后消失。保存失败在底部显示后端错误，不关弹窗。
- **删除**：右表单底部的「删除此服务器」只从草稿里移除并选中相邻项，真正落盘仍靠
  「保存」，所以不需要二次确认。
- **读取失败**：打开时 `GET` 失败，正文区显示错误和「重试」，不展示空表单，避免用户
  以为没有配置然后保存一份空文件把原有配置清掉。这是现有实现的一个真实风险。
- 保存端点要求服务绑定 loopback；非 loopback 时弹窗仍可打开查看和测连接，保存按钮
  禁用并说明原因。

## 四、后端要改的两处

后端接口、存储、探测保留现有的未提交实现，只改语义：

1. **用户级 `cwd` 的解析基准。** 现有实现相对 `~` 解析并新增了 `resolveUserMcpCwd`，
   与 `2026-09-20-mcp-client.md` 决定 7 写的「按 workspace 相对路径解析」相反。本方案
   采纳现有实现：用户级 Server 不属于任何 workspace，`cwd` 相对主目录更说得通；
   缺省仍是 workspace 根。需要同步改 `2026-09-20-mcp-client.md` 的配置一节、README
   已经写对了。`McpServerPool` 起用户级 Server 时也要用这个基准，而不是只有探测用。
2. **读取失败与空配置的区分。** `GET /v1/agent/mcp-config` 在文件不存在时返回空列表，
   在文件非法时也返回空列表加诊断。前端要靠诊断区分「没有配置」和「配置坏了」，
   后者要按第三节「读取失败」处理。接口不改，前端消费诊断即可。
3. **管理接口不展开 `${VAR}`。** 运行时读取会把 `${VAR}` 换成真实值；管理接口若复用
   这条路径，明文会经前端回到保存请求、再写进文件。GET/PUT 的响应必须走不展开的读取，
   只有「测试连接」在服务端临时展开。

## 具体改动

| 文件 | 改动 |
|-|-|
| `web/package.json` | 新增 `@radix-ui/react-dialog`、`lucide-react` |
| `web/src/components/ui/dialog.tsx` | 新增，shadcn 风格的 Dialog 封装：Root、Content、Header、Title、Description、Footer、Close |
| `web/src/components/Sidebar.tsx` | 新增，三段式左栏，内含 `ConversationList` |
| `web/src/components/ConversationList.tsx` | 去掉 `aside` 外壳和圆角卡片样式，改为纯列表，由 `Sidebar` 承载 |
| `web/src/components/McpSettingsDialog.tsx` | 新增，替代 `McpSettingsPanel.tsx`；左列表右表单、校验、测连接、未保存确认 |
| `web/src/components/McpSettingsPanel.tsx`、`.test.tsx` | 删除 |
| `web/src/components/AccessModeDialog.tsx`、`DeleteConversationDialog.tsx` | 换到 `ui/dialog` 底座，内容不变 |
| `web/src/App.tsx` | 左栏渲染 `Sidebar`；删掉主栏「MCP 设置」按钮；MCP 弹窗状态与读取错误处理 |
| `web/src/mcp-settings-state.ts` | 新增，草稿、选中项、校验、脏标记的 reducer，与 `project-open-state.ts` 同形 |
| `src/mcp/server-pool.ts` | 用户级 Server 的 `cwd` 用 `resolveUserMcpCwd` |
| `docs/plans/2026-09-20-mcp-client.md` | 配置一节改为用户级 `cwd` 相对主目录 |
| `web/src/components/Sidebar.test.tsx` | 三段渲染；导航项回调；窄屏类名 |
| `web/src/components/ui/dialog.test.tsx` | 关闭按钮的 aria-label；标题描述关联 |
| `web/src/components/McpSettingsDialog.test.tsx` | 列表与表单渲染；选中切换；`http` 与 `stdio` 字段切换；名字校验；同名标红；读取失败态；非 loopback 禁用保存 |
| `web/src/mcp-settings-state.test.ts` | 新增、删除、编辑、脏标记、校验错误定位 |
| `web/src/components/AccessModeDialog.test.ts`、`DeleteConversationDialog.test.ts` | 按新外壳调整断言 |
| `test/mcp-server-pool.test.ts` | 用户级 `cwd` 基准 |

## 保持不变

- 三个后端端点的路径、请求与响应形状；`mcp-config-store.ts` 的原子写。
- `ConversationList` 的数据与交互：选中、删除、加载更多、错误重试。
- `WorkspacePanel`、`ConversationComposer`、`RunTrace` 等主栏组件。
- `SubAgentDrawer` 的抽屉形态。
- 服务端运行时依赖仍是 `openai`、`yaml`、`zod`。

## 验收

1. `npm run check` 与 `npm test` 全绿。
2. 打开首页：左栏三段可见；点「新建会话」弹出选择执行模式弹窗，右上角是 ✕ 图标；
   Esc 关闭后焦点回到「新建会话」按钮。
3. 点左栏底部「MCP 服务器」：弹窗打开，左列表列出 `~/.agents/mcp.json` 里的 Server，
   选中第一个，右侧显示它的字段；`stdio` 与 `http` 切换时字段随之变化。
4. 新增一个 Server 不填名字直接保存：保存按钮禁用，名字字段下方有错误；填入与已有
   Server 相同的名字：列表里两项标红。
5. 选中一个配好的 Server 点「测试连接」：按钮进入进行中态，完成后显示工具数，列表行首
   圆点变绿；改成一个不存在的命令再测，显示失败原因，圆点变红。
6. 改一个字段后按 Esc：弹出「放弃修改？」确认；选择留下，修改仍在；点保存，底部显示
   「已保存」，`~/.agents/mcp.json` 内容更新，下一个 Run 能看到新配置。
7. 把 `~/.agents/mcp.json` 改成非法 JSON 再打开弹窗：正文显示读取失败和重试，没有
   空表单，保存按钮不可用。
8. 窄于 760px：左栏变顶部区块，导航项与品牌区同行，会话列表可滚动。
