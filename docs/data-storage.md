# 数据结构与迁移

记录 `src/infrastructure/sqlite/schema.ts` 无法直接表达的结论：版本如何演进、每个版本改了什么、降级与升级的边界。`schema.ts` 保留当前完整建表结构；本文记录存量库如何从旧版本升级到该结构，具体 DDL 仍以代码为准。

## 版本机制

结构版本记录在 SQLite 的 `PRAGMA user_version`，代码侧的 `LATEST_SCHEMA_VERSION`（`src/infrastructure/sqlite/migrations.ts`）是唯一事实来源。

- 启动时在写事务中读取 `PRAGMA user_version` 并判断数据库是否为空。空库直接使用 `schema.ts` 的当前完整 DDL 建表，并将版本号写到当前版本；已有库按版本逐步执行 `migrations.ts` 中的升级步骤。新建库和升级后的存量库必须得到相同的当前结构。
- 已有库的待执行迁移、必要的数据转换和版本号更新在同一个事务中；迁移后执行 `CREATE TABLE IF NOT EXISTS` 补建缺少的表，沿用此前的初始化行为。失败时整个初始化事务回滚，服务不会开始监听请求；成功后才继续恢复运行状态并启动 HTTP 服务。
- `user_version = 0` 只表示未记录迁移版本，不能单独证明数据库为空。非空数据库必须包含 `conversations` 表，否则启动失败；迁移过程中结构不符合所需条件时同样失败。这不是对已有表结构的完整校验。
- 当前版本代码遇到高于 `LATEST_SCHEMA_VERSION` 的数据库时抛出 `SchemaVersionError`，拒绝降级运行。引入版本检查之前的旧程序不会读取该版本号，因此不能依赖旧程序主动拒绝打开新库。
- 迁移只前向进行，不写降级路径；升级前的备份由使用者自行负责，代码不做自动备份。

## 版本 1：会话标题

会话需要一个独立于工作区路径的名称。此前侧栏标题由 `basename(workspace_root)` 现算，同一目录下的多个会话无法区分。

`conversations` 从 7 个物理列变为 8 个：

| 列 | 变更 | 类型与约束 |
| --- | --- | --- |
| `id` | 不变 | `TEXT PRIMARY KEY` |
| `revision` | 不变 | `INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)` |
| `workspace_root` | 不变 | `TEXT NOT NULL` |
| `execution_mode` | 不变 | `TEXT NOT NULL CHECK (execution_mode IN ('workspace_sandbox', 'full_access'))` |
| `active_run_id` | 不变 | `TEXT NULL REFERENCES runs(id) ON DELETE SET NULL` |
| `created_at` | 不变 | `TEXT NOT NULL` |
| `updated_at` | 不变 | `TEXT NOT NULL` |
| `title` | **新增** | `TEXT NULL CHECK (title IS NULL OR length(title) BETWEEN 1 AND 120)` |

- 主键、外键、其他 CHECK/UNIQUE 约束和 `conversations_updated_at_id_idx` 索引均不变。
- `title` 保存普通文本，不是 JSON，数据库按 CHECK 约束校验长度。
- `NULL` 表示未命名，界面回退显示 `basename(workspace_root)`。空串因 CHECK 约束无法落库，规范化在 `ConversationService` 完成。
- `schema.ts` 的当前建表 DDL 直接包含 `title`。从 version 0 升级时，迁移用 `ALTER TABLE conversations ADD COLUMN title`，已有行取 `NULL`；会话、轮次、Run、转录等其它表的行数不变。新库不再重复执行该 `ADD COLUMN`。
- 改名只写 `title`，不改 `updated_at` 与 `revision`：列表按 `updated_at DESC, id DESC` 排序，改名不能让会话跳到顶部；`revision` 只随 Run 状态变化。

## 版本 3：项目归属查询索引

为 `conversations(project_key, updated_at DESC, id DESC)` 新增索引，加速按项目查找最近的会话归属。迁移只创建索引，不修改会话数据或表字段。

## 验证

`test/sqlite-migrations.test.ts` 覆盖：空库按当前 `schema.ts` 建表、完整旧版库升级后行数与列名及约束一致、二次初始化幂等、`title` 的 CHECK 边界、迁移失败回滚、未知非空结构拒绝启动，以及库版本高于 `LATEST_SCHEMA_VERSION` 时拒绝降级。
