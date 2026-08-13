# dsh-memory 记忆库插件 — 设计文档

- **日期**：2026-08-13
- **状态**：已获用户批准
- **范围**：为 DeepSeek Harness (DSH) 开发一个本地记忆库插件，提供跨会话记忆能力

## 1. 背景与目标

DSH 是 Cordis 插件架构的 Agent 框架。当前会话数据以 JSONL 事件日志形式持久化（`~/.dsh/sessions/`），并已有 `dsh-session-query-sqlite` 提供会话事件全文搜索。但这些能力解决的是"检索历史事件"，不是"跨会话记忆"——模型在新会话中没有用户偏好、项目上下文、关键决策的感知。

**目标**：开发 `dsh-memory` 插件，为模型提供持久的跨会话记忆系统，包含：

1. **用户画像/偏好**：记住用户偏好、背景、常用环境，新会话开局自动注入
2. **项目知识**：每个项目/任务的进度、关键决策、学到的教训
3. **历史对话检索**：全文搜索历史摘要（类似 claude-mem）

## 2. 需求决策记录（用户确认）

| 决策点 | 选择 |
|--------|------|
| 记忆内容范围 | 全部：用户画像 + 项目知识 + 历史对话检索 |
| 访问方式 | 双通道：自动注入 + 工具调用 |
| 存储技术 | 混合：SQLite（索引+搜索）+ Markdown（人类可读镜像） |
| 写入策略 | 主动判断 + 会话结束自动摘要（LLM 提炼） |
| 界面范围 | 基础查看界面（Web GUI 侧边栏"记忆"面板：浏览/搜索/详情） |
| 部署方式 | 方案 A：本地插件包，profile 用 `file:` 依赖引用 |

## 3. 总体架构

```
┌─────────────────────────────────────────────────┐
│  Layer 1: 记忆引擎（服务层）                      │
│  SQLite 主存储 (FTS5全文搜索) + Markdown 镜像     │
│  数据文件: ~/.dsh/memory/memory.db + *.md        │
├─────────────────────────────────────────────────┤
│  Layer 2: 模型接口（工具 + 自动注入）              │
│  memory_save / memory_search / memory_list 等工具 │
│  会话开始注入画像 → 会话结束自动提炼摘要           │
├─────────────────────────────────────────────────┤
│  Layer 3: 基础查看界面（Web GUI 记忆面板）         │
│  侧边栏"记忆"入口：浏览 / 搜索记忆条目             │
└─────────────────────────────────────────────────┘
```

### 3.1 目录结构

```
dsh-memory/
├── package.json          # 插件清单（name, main, peerDeps）
├── tsconfig.json
├── src/
│   ├── index.ts          # 插件入口：注册工具、注入、摘要
│   ├── store/
│   │   ├── sqlite.ts     # SQLite + FTS5 存储实现
│   │   └── markdown.ts   # Markdown 镜像同步
│   ├── tools.ts          # memory_save / search / list / update / delete / forget
│   ├── inject.ts         # 会话启动时的记忆注入
│   └── summarize.ts      # 会话结束自动摘要（LLM）
├── client/
│   └── index.ts          # Web GUI 记忆面板（client 插件）
└── lib/                  # 编译输出（DSH 加载用）
```

### 3.2 技术底座

- **存储**：Node 24 内置 `node:sqlite`（自带 FTS5，DSH 会话搜索插件同款），零额外原生依赖
- **LLM 摘要**：复用 DSH 已有的模型通道（`dsh-llm`）
- **插件框架**：Cordis（DSH 同源）

## 4. 数据模型

### 4.1 文件位置

```
~/.dsh/memory/
├── memory.db           # SQLite 主存储（含 FTS5 索引）
├── preferences.md      # 用户画像镜像（人类可读）
├── projects.md         # 项目知识镜像
├── decisions.md        # 关键决策镜像
└── history.md          # 历史对话检索摘要镜像
```

### 4.2 SQLite 表结构

```sql
-- 记忆条目主表
CREATE TABLE memories (
  id          TEXT PRIMARY KEY,      -- UUID
  type        TEXT NOT NULL,         -- preference | project | decision | history
  title       TEXT NOT NULL,         -- 简短标题
  content     TEXT NOT NULL,         -- 记忆正文
  tags        TEXT DEFAULT '[]',     -- JSON 数组 ["dsh","插件"]
  importance  INTEGER DEFAULT 3,     -- 1-5，注入优先级
  source      TEXT,                  -- 来源（session id / 手动）
  created_at  TEXT NOT NULL,         -- ISO 时间
  updated_at  TEXT NOT NULL
);

-- FTS5 全文搜索索引（中文友好：unicode61 + trigram）
CREATE VIRTUAL TABLE memories_fts USING fts5(
  title, content, tags,
  content='memories', content_rowid='rowid'
);
```

### 4.3 记忆类型体系

| type | 含义 | 示例 |
|------|------|------|
| `preference` | 用户画像/偏好 | "用户用中文交流，Windows 环境" |
| `project` | 项目知识/进度 | "记忆插件项目：方案B，SQLite+Markdown混合" |
| `decision` | 关键决策/教训 | "选定 node:sqlite 避免原生依赖" |
| `history` | 对话历史摘要 | 每次会话结束自动提炼的摘要 |

### 4.4 Markdown 镜像同步规则

- 每次写入/更新记忆时，按 `type` 追加或重写对应 `.md` 文件（按 `updated_at` 倒序）
- **双向同步，人工优先**：若检测到用户手动修改了 `.md`，下次同步时以人工修改为准合并回 SQLite

### 4.5 检索策略

- FTS5 `unicode61` + `trigram` tokenizer（中英文混合友好，DSH 会话搜索同款）
- 排序：`importance` 降序 + FTS5 相关度

## 5. 模型接口设计

### 5.1 通道 1：自动注入

**会话启动时**（每次新会话/恢复会话）：
1. 读取全部 `preference` 类型条目 + `importance >= threshold` 的高优先级条目
2. 以"记忆摘要"块注入系统提示开头：

```
[记忆库] 来自 dsh-memory 的上下文：
- 用户偏好：中文交流，Windows 环境，喜欢结构化回答
- 高优先级记忆：正在开发 dsh-memory 记忆插件（方案B，SQLite+Markdown混合）
```

**会话进行中**：工作区路径命中 `project` 记忆关键词时，追加相关片段。

**会话结束时**（`session/event` 提交时触发，参考 `dsh-session-title` 插件模式）：
1. LLM 对本次会话生成 2-3 条结构化摘要（学到什么、决定了什么、用户偏好新信息）
2. 写入 `history` 类型 + 按内容分类写入 `project` / `decision` / `preference`
3. **去重合并**：与已有条目相似度高的（FTS5 检索 + LLM 判断）合并更新而非新增

### 5.2 通道 2：工具

| 工具 | 功能 |
|------|------|
| `memory_save` | 主动记录一条记忆（类型、内容、标签、重要性） |
| `memory_search` | 全文搜索记忆库，返回相关条目（含来源和更新时间） |
| `memory_list` | 按类型列出记忆（分页） |
| `memory_update` | 修改已有记忆 |
| `memory_delete` | 删除记忆 |
| `memory_forget` | 标记记忆为"不再需要注入"（降权而非删除） |

### 5.3 权限边界

- 工具注册在 `ctx.tools`（与 DSH 现有工具同级）
- 自动注入和摘要默认开启，可在插件配置中关闭

## 6. Web 界面（基础查看）

- **入口**：GUI 侧边栏"记忆"入口（参考 `dsh-client-ui-*` slot 机制）
- **功能**：
  - 📋 列表：按类型标签页浏览，显示标题、内容摘要、重要性、更新时间
  - 🔍 搜索：全文搜索（复用后端 FTS5）
  - 👁️ 详情：点击查看完整内容
  - ✏️ 编辑/删除：基础操作（可只读降级）

## 7. 插件配置

```yaml
- id: dsh-memory
  name: dsh-memory
  config:
    memoryDir: ~/.dsh/memory        # 存储目录（默认）
    autoInject: true                # 会话启动自动注入
    autoSummarize: true             # 会话结束自动摘要
    maxInjectedItems: 5             # 最多注入几条
    importanceThreshold: 3          # 注入的最低重要性
```

## 8. 测试策略

| 层 | 测试 | 工具 |
|----|------|------|
| 存储单元 | SQLite CRUD、FTS5 中文搜索、去重 | node:test |
| Markdown 同步 | 双向同步、人工修改优先 | node:test |
| 工具层 | memory_save/search/list 行为 | node:test（mock ctx） |
| 集成验证 | 启动 DSH web profile，插件加载、工具可用、面板渲染 | 手动 + Playwright |

## 9. 交付验收标准

1. ✅ `dsh --profile web` 启动无错误，插件注册成功
2. ✅ 模型可调用 `memory_save` / `memory_search` 存取记忆
3. ✅ 新会话开局能看到注入的记忆摘要
4. ✅ Web 侧边栏出现"记忆"面板，可浏览/搜索
5. ✅ 会话结束时自动生成摘要入库
6. ✅ Markdown 镜像文件可读、可手工编辑

## 10. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 中文分词效果 | 使用 `trigram` tokenizer（DSH 会话搜索验证过的方案） |
| 记忆膨胀/噪声 | 去重合并 + importance 分级 + forget 降权 |
| 插件与 DSH 版本兼容 | 跟随 `@deepseek-ai/cordis` peerDependencies 版本 |
| node:sqlite 实验性 | DSH 会话搜索插件已在使用，Node 24 稳定 |
