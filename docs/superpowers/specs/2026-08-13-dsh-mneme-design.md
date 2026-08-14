# dsh-mneme 跨会话记忆插件 — 设计文档

- **日期**：2026-08-13（初稿）／2026-08-14（更新为当前实现）
- **状态**：已发布（npm `@modusensus/dsh-mneme` v0.1.x）
- **范围**：为 DeepSeek Harness (DSH) 开发一个本地记忆库插件，提供跨会话记忆能力

## 1. 背景与目标

DSH 是 Cordis 插件架构的 Agent 框架。当前会话数据以 JSONL 事件日志形式持久化（`~/.dsh/sessions/`），并已有 `dsh-session-query-sqlite` 提供会话事件全文搜索。但这些能力解决的是"检索历史事件"，不是"跨会话记忆"——模型在新会话中没有用户偏好、项目上下文、关键决策的感知。

**目标**：开发 `dsh-mneme` 插件，为模型提供持久的跨会话记忆系统，包含：

1. **用户画像/偏好**：记住用户偏好、背景、常用环境，新会话开局自动注入
2. **项目知识**：每个项目/任务的进度、关键决策、学到的教训
3. **历史对话检索**：全文搜索历史摘要（类似 claude-mem）
4. **记忆主权**：SQLite + 可人工编辑的 Markdown 双写，记忆透明、可审查、归用户所有
5. **自动巩固**：autoDream 后台去重/合并/冲突裁决，越用越精炼

## 2. 需求决策记录（用户确认）

| 决策点 | 选择 |
|--------|------|
| 记忆内容范围 | 全部：用户画像 + 项目知识 + 历史对话检索 + 规则 |
| 访问方式 | 双通道：自动注入 + 工具调用 |
| 存储技术 | 混合：SQLite（存储 + LIKE 子串搜索）+ Markdown（人类可读镜像） |
| 写入策略 | 主动判断 + 会话结束自动摘要（LLM 提炼） |
| 搜索能力 | LIKE 子串搜索（中英文子串扫描、用户输入转义处理）+ 可选 OpenAI 兼容 embeddings 向量语义搜索 |
| 界面范围 | Web GUI 侧边栏"记忆"面板：浏览/搜索/详情 |
| 用户设置 | 用户画像 + 行为规则，每轮注入系统提示 |
| 自定义指令 | 注册斜杠命令（/名称），触发时交给 Agent |
| 部署方式 | npm 包发布（`@modusensus/dsh-mneme`），`dsh plugin add` 安装 |

## 3. 总体架构

```
┌─────────────────────────────────────────────────┐
│  Layer 1: 记忆引擎（服务层）                      │
│  SQLite 主存储 (LIKE 子串搜索) + Markdown 镜像    │
│  数据文件: ~/.dsh/memory/memory.db + *.md        │
├─────────────────────────────────────────────────┤
│  Layer 2: 模型接口（工具 + 自动注入）              │
│  memory_save / search / list / update / delete   │
│  / forget 6 个工具 + 会话摘要 + 向量语义搜索      │
│  会话开始注入画像 → 会话结束自动提炼摘要           │
├─────────────────────────────────────────────────┤
│  Layer 3: 扩展能力                                │
│  · 用户设置（画像+规则，每轮注入）                 │
│  · 自定义指令（/命令，交给 Agent）                │
│  · API 接口（settings/commands 增删改查）         │
├─────────────────────────────────────────────────┤
│  Layer 4: Web GUI 记忆面板                        │
│  侧边栏"记忆"入口：浏览 / 搜索 / 详情             │
└─────────────────────────────────────────────────┘
```

### 3.1 目录结构

```
dsh-mneme/
├── package.json          # 插件清单（name, main, peerDeps, dsh.bundle）
├── cordis.patch.yml      # Cordis 补丁
├── src/
│   ├── index.js          # 插件入口：注册工具、注入、摘要、设置、命令
│   ├── store.js          # SQLite + LIKE 子串搜索存储实现
│   ├── mirror.js         # Markdown 镜像同步（双向、人工优先）
│   ├── tools.js          # memory_save / search / list / update / delete / forget
│   ├── inject.js         # 会话启动时的记忆注入
│   ├── summarize.js      # 会话结束自动摘要（LLM）
│   ├── dream.js          # autoDream 自动巩固（去重/合并/归档/裁决）
│   ├── dream/decisions.js# 巩固决策清单校验
│   ├── embedding.js      # OpenAI 兼容 embeddings 向量语义搜索
│   ├── settings.js       # 用户画像 + 行为规则 + 自定义指令存储
│   ├── commands.js       # 自定义斜杠命令注册
│   ├── api.js            # 设置/命令增删改查 + /vector-config 向量配置 API
│   ├── config.js         # 插件配置（扁平键）
│   └── service.js        # 服务层编排（注入候选/去重/镜像同步）
├── lib/                  # DSH 加载目录：scripts/sync-lib.js 从 src 逐字节拷贝
│   └── client.js         # Web GUI 记忆面板（单文件，仅存在于 lib）
└── test/                 # 152+ node:test 测试
```

### 3.2 技术底座

- **存储**：Node 24 内置 `node:sqlite`（LIKE 子串搜索，中英文子串扫描、用户输入转义），零额外原生依赖
- **LLM 摘要**：复用 DSH 已有的模型通道（`dsh-llm`）
- **向量搜索**：向量配置通过 Web/API 的 `/api/dsh-mneme/vector-config` 端点存到 SQLite `user_settings` 表（不在插件配置）；调用外部 OpenAI 兼容 `/embeddings` 端点（支持 OpenAI、SiliconFlow、智谱、本地 Ollama 等），失败自动降级为 LIKE 子串搜索
- **插件框架**：Cordis（DSH 同源）

## 4. 数据模型

### 4.1 文件位置

```
~/.dsh/memory/
├── memory.db           # SQLite 主存储（memories + user_settings/custom_commands 表）
├── *.md                # 各类型记忆的 Markdown 镜像（人类可读、可编辑）
```

### 4.2 SQLite 表结构

```sql
-- 记忆条目主表
CREATE TABLE memories (
  id          TEXT PRIMARY KEY,      -- UUID
  type        TEXT NOT NULL,         -- preference | project | decision | history | summary
  title       TEXT NOT NULL,         -- 简短标题
  content     TEXT NOT NULL,         -- 记忆正文
  tags        TEXT NOT NULL DEFAULT '[]', -- JSON 数组 ["dsh","插件"]
  importance  INTEGER NOT NULL DEFAULT 3, -- 1-5，注入优先级
  forgotten   INTEGER NOT NULL DEFAULT 0, -- 1 = 已忘记（不再注入，可恢复）
  archived    INTEGER NOT NULL DEFAULT 0, -- 1 = 已归档（搜索结果排除）
  source      TEXT,                  -- 来源（session id / 手动）
  embedding   TEXT,                  -- 向量序列化（可选，供向量语义搜索）
  created_at  TEXT NOT NULL,         -- ISO 时间
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_memories_type ON memories(type);
CREATE INDEX idx_memories_importance ON memories(importance);

-- 无 FTS5：搜索为 LIKE 子串扫描（title/content/tags，通配符 % _ \ 转义使输入按字面
-- 匹配；中英文子串都支持，记忆库通常较小，全表扫描足够快）

-- 用户设置表（画像/规则）
CREATE TABLE user_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 自定义指令表
CREATE TABLE custom_commands (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  instruction TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

### 4.3 记忆类型体系

| type | 含义 | 示例 |
|------|------|------|
| `preference` | 用户画像/偏好 | "用户用中文交流，Windows 环境" |
| `project` | 项目知识/进度 | "dsh-mneme 项目：SQLite+Markdown 混合" |
| `decision` | 关键决策/教训 | "选定 node:sqlite 避免原生依赖" |
| `history` | 对话历史摘要 | 每次会话结束自动提炼的摘要 |
| `summary` | autoDream 巩固后摘要 | 合并多条记忆后的精简结论 |

### 4.4 Markdown 镜像同步规则

- 每次写入/更新记忆时，按 `type` 追加或重写对应 `.md` 文件（按 `updated_at` 倒序）
- **双向同步，人工优先**：若检测到用户手动修改了 `.md`，下次同步时以人工修改为准合并回 SQLite

### 4.5 检索策略

- **LIKE 子串匹配**：对 title/content/tags 做子串扫描，通配符（% _ \）转义后输入按字面匹配，中英文子串都支持（无 FTS5）
- 排序：标题命中优先，然后 `importance` 降序 + `updated_at` 倒序
- **可选向量语义搜索**：通过 `/api/dsh-mneme/vector-config` 配置 embeddings 端点（存 user_settings 表）后，语义匹配字面不同但意思相近的记忆；无配置/失败时自动回退 LIKE 子串搜索

## 5. 模型接口设计

### 5.1 通道 1：自动注入

**会话启动时**（每次新会话/恢复会话）：
1. 候选集：`summary` 优先，其次全部 `preference`，再按 `importance >= threshold` 的高优先级条目（`history` 不注入，forgotten/archived 排除）
2. 按优先级排序后截取前 `maxInjectedItems` 条（默认 5），以"记忆摘要"块注入系统提示开头

**会话进行中**：工作区路径命中 `project` 记忆关键词时，追加相关片段。

**会话结束时**（`session/event` 提交时触发，参考 `dsh-session-title` 插件模式）：
1. LLM 对本次会话生成 2-3 条结构化摘要（学到什么、决定了什么、用户偏好新信息）
2. 写入 `history` 类型 + 按内容分类写入 `project` / `decision` / `preference`
3. **去重合并**：同类型下标题相同的条目合并更新而非新增（service 层 saveWithDedupe）

### 5.2 通道 2：工具

| 工具 | 功能 |
|------|------|
| `memory_save` | 主动记录一条记忆（类型、内容、标签、重要性） |
| `memory_search` | LIKE 子串搜索 + 向量语义搜索记忆库，返回相关条目 |
| `memory_list` | 按类型列出记忆（分页） |
| `memory_update` | 修改已有记忆 |
| `memory_delete` | 删除记忆 |
| `memory_forget` | 标记记忆为"不再需要注入"（降权而非删除） |

### 5.3 用户设置与自定义指令

- **用户设置**：用户画像（self-description）+ 行为规则，每轮注入系统提示
- **自定义指令**：注册斜杠命令（`/名称`），触发时把指令交给 Agent
- 通过 Web GUI 或 API 增删改查，实时生效

### 5.4 权限边界

- 工具注册在 `ctx.tools`（与 DSH 现有工具同级）
- 自动注入和摘要默认开启，可在插件配置中关闭
- 向量搜索失败时静默降级，不阻断记忆读写

## 6. Web 界面（记忆面板 + 设置）

- **入口**：GUI 侧边栏"记忆"入口（参考 `dsh-client-ui-*` slot 机制）
- **功能**：
  - 📋 列表：按类型标签页浏览，显示标题、内容摘要、重要性、更新时间
  - 🔍 搜索：LIKE 子串搜索 + 语义（向量）搜索
  - 👁️ 详情：点击查看完整内容
  - ✏️ 编辑/删除：基础操作（可只读降级）
  - ⚙️ 设置：用户画像 / 行为规则 / 自定义指令管理

## 7. 插件配置

```yaml
- id: dsh-mneme
  name: dsh-mneme
  config:
    memoryDir: ~/.dsh/memory         # 存储目录（默认）
    autoInject: true                 # 会话启动自动注入
    autoSummarize: true              # 会话结束自动摘要
    maxInjectedItems: 5              # 最多注入几条（默认 5）
    importanceThreshold: 3           # 注入的最低重要性（1-5）
    autoDream: true                  # 后台自动巩固（autoDream）
    dreamThresholdCount: 10          # 记忆数超过即触发巩固
    dreamThresholdChars: 5000        # 累计字数超过即触发巩固
    dreamDelayMs: 2000               # 写入后静默延迟（毫秒）
    dreamProvider: ""                # autoDream 使用的模型通道
    dreamModel: ""                   # autoDream 使用的模型名

# 注意：配置键全部扁平，无嵌套 embeddings 块。向量搜索配置通过 Web/API 的
# /api/dsh-mneme/vector-config 端点存到 SQLite user_settings 表，不在插件配置中。
```

## 8. 测试策略

| 层 | 测试 | 工具 |
|----|------|------|
| 存储单元 | SQLite CRUD、LIKE 中英文子串搜索、去重 | node:test |
| Markdown 同步 | 双向同步、人工修改优先 | node:test |
| 工具层 | memory_save/search/list 行为 | node:test（mock ctx） |
| autoDream | 决策清单校验、合并/归档/裁决 | node:test |
| autoDream 审计 | 每次裁决入 `dream_runs`（快照 digest + 决策 + outcome + receipt），幂等重放 | node:test |
| 三轴线压测 | 长会话检索 Recall@k、冲突仲裁可重放、多 Agent 并发 | scripts/stress-dsh.js（mock LLM） |
| 向量搜索 | embeddings 调用、降级回退 | node:test |
| 集成验证 | 启动 DSH web profile，插件加载、工具可用、面板渲染 | 手动 + Playwright |

## 9. 交付验收标准

1. ✅ `dsh --profile web` 启动无错误，插件注册成功
2. ✅ 模型可调用 6 个 `memory_*` 工具存取记忆
3. ✅ 新会话开局能看到注入的记忆摘要
4. ✅ Web 侧边栏出现"记忆"面板，可浏览/搜索
5. ✅ 会话结束时自动生成摘要入库
6. ✅ Markdown 镜像文件可读、可手工编辑
7. ✅ 用户画像/规则每轮注入，自定义指令可注册触发
8. ✅ 向量搜索配置后可用，未配置时自动降级 LIKE 子串搜索
9. ✅ autoDream 自动巩固（去重/合并/归档/冲突裁决）
10. ✅ 152 个 node:test 测试全部通过（含审计与三轴线压测不变量），CI 自动运行
11. ✅ 每次 autoDream 裁决写入审计（输入快照 digest + 决策清单 + 逐 id 去向 + receipt），可回放定位静默错误

## 10. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 中文搜索准确率 | LIKE 子串扫描对中英文子串匹配直观可靠；记忆库通常较小，全表扫描开销可忽略 |
| 记忆膨胀/噪声 | 去重合并 + importance 分级 + forget 降权 + autoDream 巩固 |
| 向量搜索依赖外部 API | 未配置/失败时自动降级 LIKE 子串搜索，不阻断读写 |
| 插件与 DSH 版本兼容 | 跟随 `@deepseek-ai/cordis` peerDependencies 版本 |
| node:sqlite 实验性 | DSH 会话搜索插件已在使用，Node 24 稳定 |

## 11. 后续规划

- **Rerank 重排**：向量初筛 + 重排精排（如 `gte-rerank-v2`），提升语义检索准确率
- **embedding 端点可配置**：支持换用本地开源模型（如 text-embedding-3-small）
- ✅ **长会话压测（已实现）**：`npm run stress` —— 检索准确率（Recall@k、陈旧残留率）、冲突裁决可重放仲裁集、多 Agent 并发（丢更新/重复合并/事务恢复）
- ✅ **来源链 / 裁决审计（已实现）**：每次 autoDream 裁决写入 `dream_runs`（输入快照 sha256 digest + 决策清单 + 逐 id 去向 + receipt `dsh-mneme:run:<id>:<status>:<hash>:<count>:<applied>`），conflict 胜者带来源注释，可回放验证；合并/冲突应用已幂等（重复应用无累积副作用）
- **分层记忆**：原始事件层 / 摘要层 / 规则层分离，召回按层回退
