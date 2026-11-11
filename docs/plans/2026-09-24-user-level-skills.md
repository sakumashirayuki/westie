# 用户级 Skill：`~/.agents/skills`

> 讨论稿。定稿前不动 `src/`、`web/`、`test/`。

现在 Harness 只从 `<workspace>/.agents/skills` 发现 Skill。工具型 Skill（browser-cli、lark-*、
cloud-cli-* 这类）跟人走不跟仓库走，每个 workspace 复制一份很别扭，还会把第三方 Skill 提交进仓库。
`~/.agents/skills` 已经是这些工具的约定安装位置：本机现在有 32 个，CLI 安装器就把
`browser-cli` 链到了这里。本方案让每个 Run 同时发现用户级和 workspace 级 Skill，同名时
workspace 覆盖，思路与 `~/.agents/mcp.json` 一致（见 `2026-09-20-mcp-client.md` 决定 7）。
不改数据库，不改 Web。

## 当前实现

### 发现与加载

`discoverWorkspaceSkills(canonicalWorkspaceRoot)`（`src/infrastructure/workspace-skills.ts`）
扫描 `<workspace>/.agents/skills` 的直接子目录：

- `.agents`、`skills` 和每个 Skill 目录都必须是普通目录（`lstat`，不是符号链接），`realpath`
  后必须在 workspace 内；Skill 目录是符号链接时跳过，并输出 `INVALID_SKILL` 诊断。
- `SKILL.md` 用 `O_NOFOLLOW` 打开，不超过 64 KiB，frontmatter 的 `name` 必须与目录名一致，
  `description` 为 1–1024 字符。
- 合法条目按名称排序，把 `name + description` 渲染成 `<workspace_skills>` catalog，上限
  `MAX_CATALOG_BYTES = 32 KiB`，超限从尾部裁剪并输出 `CATALOG_TRUNCATED`。
- `load(name)` 重新核对根目录与 Skill 目录的 `realpath` 仍等于发现时的值，防止发现和加载
  之间被替换；然后返回完整 `SKILL.md`。

### 接入

- Web：`ConversationRunService.#runEvents` 每个 Run 调一次 `discoverWorkspaceSkills`
  （`src/server-bootstrap.ts:103` 注入并打印诊断），catalog 进 system prompt，Registry 交给
  `createSkillTool`。父 Run 和子 Run 用同一份 catalog。
- CLI：`src/index.ts:35` 直接调用，逻辑相同。
- Registry 不进 `WorkspaceRuntime` 缓存，新装的 Skill 下一个 Run 就能看到，不用重启。

### `skill` 工具与信任边界

`createSkillTool`（`src/tools/skill.ts`）返回 `{ skill, content }`。
`serializeToolResultForModel`（`src/providers/tool-result-boundary.ts:24`）只有在输出**恰好**
这两个键时，才会把结果包成 `workspace_skill_instructions`，其余情况一律按
`untrusted_tool_result` 处理。system prompt 的 `WORKSPACE_SKILL_RESULT_INSTRUCTIONS`
（`src/system-prompt.ts:87`）说明这一层信任的范围。

### 文件访问

- `workspace_sandbox` 下，`read` 读 workspace 外的文件走现有的 read 授权
  （`preflightReadable` → `workspace_grant`）。
- Bash 跑在 Seatbelt 里，`HOME` 是临时目录，读不到真实的 `~`。
- `full_access` 下没有这些限制。

## 存在的问题

1. **用户级目录完全不被读取。** 装在 `~/.agents/skills` 里的 Skill，Harness 看不见。
2. **现有规则会拒绝安装器的常见做法。** `~/.agents/skills/browser-cli` 是指向
   `~/.local/share/cli/skills` 的符号链接，安装器靠它原地更新。workspace 规则禁止符号链接，
   防的是恶意仓库指到仓库外；这个威胁在用户自己的主目录里不存在。
3. **两个来源合并后，裁剪顺序要重新定。** 用现有解析器实测，本机 `~/.agents/skills` 加上本仓库的
   Skill：31 个合法、1 个非法（`repo-cli` 的 `SKILL.md` 超过 64 KiB），catalog 共 16401 字节，
   约为 32 KiB 上限的一半，预算够用。但现在是按名称从尾部裁剪，一旦用户级 Skill 装多了，被丢掉的
   可能是仓库自己的 Skill，而且丢哪个取决于字母序。
4. **模型不知道 Skill 在哪个目录。** `skill` 只返回正文，但 Skill 常引用
   `references/…`、`scripts/…` 这类相对路径。workspace Skill 还能猜到是
   `.agents/skills/<name>/`，用户级 Skill 没法猜。
5. **边界识别写死了两个键。** 给 `skill` 输出加任何字段，结果都会被悄悄降级成不可信数据，
   模型会把 Skill 当成普通数据而不是工作流程。测试不一定能发现这一点。

## 关键决定

**1. 两个来源，同名时 workspace 覆盖。**
与 `mcp.json` 一致：用户级是默认工具箱，仓库可以用同名 Skill 定制。本机就有现成的例子：
仓库里的 `doc-reader` 会覆盖 `~/.agents/skills/doc-reader`。被覆盖的用户级条目输出新诊断
`SKILL_SHADOWED`，不算错误。

**2. 用户级放开目录符号链接，workspace 规则不变。**
用户级的 `~/.agents`、`~/.agents/skills` 和其中每个 Skill 目录都可以是符号链接，`realpath`
后不限制必须在主目录内。安装器和 dotfiles 管理器都会这么链，内容是用户自己装的。仍然保留的检查：
- `SKILL.md` 本身不能是符号链接（`O_NOFOLLOW`），并且必须在 canonical Skill 目录内；
- 发现时记下 canonical 路径，`load` 时重新核对，防止中途被替换。

workspace 侧的所有检查一字不改。

**3. catalog 上限保持 32 KiB，workspace 排前面。**
先放 workspace 条目（按名称排序），再放用户级条目（按名称排序，已被覆盖的剔除）。超限只会从
用户级尾部裁剪，所以 workspace Skill 永远不会被用户级 Skill 挤掉。`CATALOG_TRUNCATED` 的
message 列出被省略的名称。

catalog 在固定请求层，不参与压缩，每次 Run 都会带上。本机现在是 16 KiB 左右，控制它的办法是
少装用不上的用户级 Skill，而不是提高上限。以后如果需要按 workspace 挑选启用哪些用户级 Skill，
见后续项。

**4. `skill` 工具输出加 `source` 和 `directory`，边界同步识别。**
输出改为 `{ skill, content, source: "workspace" | "user", directory }`，其中 `directory` 是
canonical Skill 目录的绝对路径。`serializeToolResultForModel` 接受两种形状：新的四键形状，
以及历史 transcript 里的旧两键形状；包装后的对象把 `source` 和 `directory` 一起带给模型。
system prompt 补一句：Skill 里的相对路径按 `directory` 解析，读取仍走普通工具和原有权限。

`instructionTrust` 维持 `"workspace"` 这个取值，`WORKSPACE_SKILL_INSTRUCTIONS_TYPE` 常量名
也不改，避免连锁改动；用户级 Skill 获得和 workspace Skill 相同的信任范围，文案里把
"workspace skill instructions" 改成 "skill instructions"。

**5. 支撑文件的访问不加任何豁免。**
`workspace_sandbox` 下读用户级 Skill 的 references 会弹 read 授权，Seatbelt 里的 Bash 也跑不了
这些 Skill 要求的 CLI。这是有意的：给 Skill 目录开读豁免、为某个 CLI 放行 Seatbelt，都属于
权限变更，不在这个方案里做。browser-cli 这类要操作本机应用的 Skill，实际需要 `full_access`，
这一点写进 README。

**6. 不改名。**
模块、`discoverWorkspaceSkills`、`WorkspaceSkillRegistry` 保持原名，只加参数和字段。改的
只有模型和用户能看到的文字：catalog 标签改成 `<skills>`，`skill` 工具的 description、
catalog 前导语里的 "workspace skills" 改成 "skills"。

## 各部分细节

### 发现

签名改为：

```ts
discoverWorkspaceSkills(
  canonicalWorkspaceRoot: string,
  options?: { readonly homeDir?: string },  // 缺省 os.homedir()，测试指向临时目录
): Promise<WorkspaceSkillRegistry>
```

- 两个来源各自扫描，产出带 `source` 的条目，再合并：同名时保留 workspace 条目，用户级条目
  输出 `SKILL_SHADOWED`。
- 单条校验（大小、UTF-8、frontmatter、name 与目录名一致）两边共用；只有符号链接和
  "必须在根目录内"这两条按来源区分。
- 用户级根目录不存在是正常情况，不出诊断；存在但不可读或不是目录，输出
  `INVALID_SKILLS_ROOT`，同时不影响 workspace 侧的发现。反过来也一样。
- `WorkspaceSkillDescriptor` 加 `source`；`WorkspaceSkillDiagnostic["code"]` 加
  `"SKILL_SHADOWED"`。
- `load(name)` 的"发现后被替换"检查按条目自己的来源重做。用户级条目核对根目录和 Skill 目录的
  `realpath` 与发现时一致，不再要求它们是普通目录。

### catalog

```xml
<skills>
  <skill>
    <name>…</name>
    <description>…</description>
  </skill>
</skills>
```

条目里不写来源，模型选 Skill 用不着这个信息。来源在 `skill` 工具的结果里给出。

### 接入点

- `src/server-bootstrap.ts`：`discoverWorkspaceSkills(root, { homeDir: homedir() })`，与
  MCP 的注入方式一致。
- `src/index.ts`：CLI 同样处理。
- `ConversationRunService` 的 `discoverWorkspaceSkills` 选项签名不变，由 bootstrap 闭包带上 `homeDir`。

## 具体改动

| 文件 | 改动 |
|-|-|
| `src/infrastructure/workspace-skills.ts` | 两个来源的发现与合并、用户级符号链接规则、`source`、`SKILL_SHADOWED`、workspace 优先的裁剪顺序、`<skills>` 标签、`load` 按来源复核 |
| `src/tools/skill.ts` | 输出加 `source`、`directory`；description 去掉 "workspace" |
| `src/providers/tool-result-boundary.ts` | 同时识别四键和旧两键形状，序列化时带上 `source`、`directory` |
| `src/system-prompt.ts` | catalog 前导语和 skill 信任说明的文案；补"相对路径按 `directory` 解析" |
| `src/server-bootstrap.ts`、`src/index.ts` | 注入 `homeDir` |
| `test/workspace-skills.test.ts` | 见验收第 1–6 条，全部用临时目录作 `homeDir` |
| `test/skill-tool.test.ts`、边界相关测试 | 见验收第 7 条 |
| `README.md`、`docs/runtime-boundaries.md`、`docs/architecture-decisions.md` | Skill 发现一节改成两个来源，写明用户级符号链接规则、裁剪顺序、覆盖规则和"操作本机应用的 Skill 需要 full_access" |

## 保持不变

- workspace Skill 的所有校验规则，包括符号链接和边界检查。
- catalog 32 KiB 上限、`SKILL.md` 64 KiB 上限、frontmatter 规则、`skill` 工具 512 KiB 输出上限。
- 权限：`skill` 工具规则、read 授权、Seatbelt profile 全都不动。
- 数据库、Web、`WorkspaceRuntime` 缓存、上下文压缩对 Skill 保护组的处理。
- `WORKSPACE_SKILL_INSTRUCTIONS_TYPE` 常量名和 `instructionTrust` 取值。

## 验收

自动化测试（`homeDir` 一律指向临时目录，不碰真实主目录）：

1. 只有用户级 Skill 时能被发现，`source` 是 `user`；用户级根目录不存在时不出诊断。
2. 同名时 workspace 条目生效，用户级条目出 `SKILL_SHADOWED`。
3. 用户级根目录是符号链接、Skill 目录是符号链接（目标在 `homeDir` 外）都能加载；workspace 侧
   同样的布局仍被拒绝，原有的符号链接测试不改。
4. 用户级 `SKILL.md` 是符号链接时被拒绝；用户级 Skill 目录在发现后被换成另一个链接时，`load` 失败。
5. 一侧根目录非法不影响另一侧的发现。
6. catalog 超过 32 KiB 时只裁用户级尾部，workspace 条目全部保留，诊断列出被省略的名称。
7. `skill` 结果带 `source` 和 `directory`，并被包装成 skill 指令；旧两键形状的历史结果仍被识别；
   多出其他键或状态不是 success 时仍是 `untrusted_tool_result`。
8. `npm run check`、`npm test` 通过（Seatbelt 内嵌套 `sandbox-exec` 的已知失败除外，列出用例名由宿主复跑）。

宿主验收（在宿主上做，会用到真实的主目录和浏览器）：

9. 对本仓库跑一次发现：`browser-cli` 在 catalog 里且来源是 `user`，`doc-reader` 来自 workspace
   并出 `SKILL_SHADOWED`，`repo-cli` 出 `INVALID_SKILL`，没有 `CATALOG_TRUNCATED`。
10. `full_access` 会话里让 Harness "用 browser-cli 打开 https://x.com/home 看是否已登录"：它能加载
    Skill、按 `directory` 找到 `references/`，并在已登录状态下完成任务。

## 后续项

- 按 workspace 选择启用哪些用户级 Skill（白名单或黑名单），用来控制 catalog 体积。
- `workspace_sandbox` 下对已发现的 Skill 目录开只读豁免，免掉 read 授权弹窗。
- 是否以及如何让 Seatbelt 内的 Bash 使用 browser-cli 这类本机 CLI，另开话题。
- Web 端展示当前 Run 加载了哪些 Skill、来源和诊断。
