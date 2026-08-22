<p align="center"><strong>中文 | <a href="docs/SEMANTIC.md">English（语义增强）</a></strong></p>

# dsh-mneme

[![npm version](https://img.shields.io/npm/v/@modusensus/dsh-mneme?color=blue&label=npm)](https://www.npmjs.com/package/@modusensus/dsh-mneme)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Awesome](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![tests](https://img.shields.io/badge/tests-716%20passed-success)](https://github.com/modusensus/dsh-mneme)
[![CI](https://img.shields.io/github/actions/workflow/status/modusensus/dsh-mneme/test.yml)](https://github.com/modusensus/dsh-mneme/actions)
[![node](https://img.shields.io/badge/node-24%2B-blue)](https://nodejs.org)
[![npm downloads](https://img.shields.io/npm/dm/@modusensus/dsh-mneme?color=blue&label=downloads)](https://www.npmjs.com/package/@modusensus/dsh-mneme)
[![coverage](https://img.shields.io/codecov/c/github/modusensus/dsh-mneme/main)](https://codecov.io/gh/modusensus/dsh-mneme)

> 给 DeepSeek Harness 的跨会话记忆插件：让 Agent 记住你、记住项目、自动整理记忆。**Mneme**（Μνήμη）——希腊记忆女神 Mnemosyne 之名，掌管记忆与梦境，正如 autoDream 在后台巩固记忆。

`dsh-mneme` 是一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件，为 Agent 提供持久的跨会话记忆能力。它借鉴了 Claude 的 **Dream 机制** 与 cc-haha / Claude Code 的 **autoDream** 实现思路——不仅**存储**记忆，还会**自动巩固**（去重、合并、冲突裁决、摘要生成），让记忆库越用越精炼。

## ⏱️ 30 秒理解

**一句话**：给 Agent 装上跨会话记忆——记住你、记住项目，并在后台自动整理，越用越懂你。

| ① 写入 | ② 存储 | ③ 进化 |
|--------|--------|--------|
| 对话中模型主动记录（`memory_save`）；会话结束自动提炼（`autoSummarize`） | SQLite 主库 + 人类可编辑 Markdown 镜像；实体 / 属性 / 时间轴三层结构化 | 新会话自动注入相关记忆；autoDream 后台去重 / 合并 / 归档，记忆库自我精炼 |

```bash
# 30 秒上手
dsh plugin --profile web add @modusensus/dsh-mneme
dsh web
```

**它不是什么**（边界声明）：

- 不是向量数据库——语义搜索是可选增强，默认零额外依赖
- 不替代会话日志——它存的是「值得跨会话记住的」精炼知识
- 不改变模型本身——进化的是记忆库与每次注入的上下文
- 删对话 ≠ 删记忆——开启会话生命周期后，删除会话只是把该会话出生的记忆**软隐藏**（可恢复），数据不丢

## ✨ 功能

### 记忆存储（SQLite + Markdown 镜像）

- **SQLite 主存储**：`~/.dsh/memory/memory.db`，`node:sqlite` 内置，零原生依赖
- **Markdown 镜像**：`preferences.md` / `projects.md` / `decisions.md` / `history.md` / `summary.md`，人类可读、可手工编辑（**人工修改优先**合并回库）
- **4+1 种记忆类型**：`preference`（偏好）/ `project`（项目）/ `decision`（决策）/ `history`（历史）/ `summary`（总览）
- **镜像同步状态机（v0.3.6+）**：mirror 与主库强一致，用 `generation`（期望轮次）/ `applied_generation`（已应用轮次）建模同步债务
  - 业务写操作在**自身事务内原子递增** desired generation——崩溃在 COMMIT 后、渲染前，重启也能凭 durable 债务恢复，绝不静默跳过（v0.3.8）
  - `generation` 用 SQLite 原子语句递增，多进程并发零丢失；带 `CHECK` 上界，负数/溢出拒绝
  - 逐 type 记录 `committed / failed / pending` 回执，健康端点区分 `ok / degraded / unknown`
  - 状态写失败不静默：同步失败落日志并留债务，重启自动收敛

### 模型工具（7 个）

| 工具 | 功能 |
|------|------|
| `memory_save` | 记录一条记忆（自动按标题去重合并） |
| `memory_search` | 全文搜索（中文子串友好，可启用向量语义搜索） |
| `memory_list` | 按类型分页列出（`include_archived=true` 可查看已归档） |
| `memory_update` | 修改已有记忆 |
| `memory_delete` | 删除记忆（v0.6.0 支持 `query` 按描述删除，不只能靠记忆 ID） |
| `memory_forget` | 抑制注入（降权不删除，可恢复） |
| `memory_archive` | 归档/恢复记忆（v0.2.5；归档后隐藏于列表/搜索/注入/整理，`archived=false` 可恢复） |

### 自动注入 + 会话摘要

- **自动注入**：新会话开局注入记忆摘要（`summary` 优先 + 少量高重要性条目）
- **会话摘要**：`turn/end` 时用 LLM 提炼本次会话的偏好/决策/教训，自动入库（过滤 plugin 注入上下文，避免污染）

### autoDream 自动记忆整理 🧠

- **触发**：记忆数 > 10 或总字符 > 5000 时，异步自动触发（不阻塞写入）
- **决策清单式整理**：LLM 输出 `keep` / `merge` / `archive` / `conflict` / `update` 决策清单，服务端校验后逐条应用
  - `merge`：合并主题相近的条目，保留信息最完整者
  - `archive`：归档过时/冗余条目（可恢复，不物理删除）
  - `conflict`：裁决矛盾信息，胜者保留、败者归档并追加溯源注释
  - `update`（v0.2.1）：直接修正单条记忆的过时/错误内容（单 id / 必须实际变化 / 非 summary / 24h 保护 / 每次 ≤2）
- **失败追踪（v0.2.1）**：用户纠正记忆时写入 `failure_memories` 表（旧值/新值），为后续自进化积累数据
- **摘要生成**：整理后生成"记忆库总览"（单一实例），作为下次会话的优先注入
- **Fail-safe**：非法 LLM 输出（未知 id / 非法 action / 跨类型合并 / 越界 importance）拒绝整单，绝不破坏记忆库
- **裁决审计**：每次运行写入 `dream_runs` 审计表（输入快照 sha256 digest + 完整输入快照 + 决策清单 + 逐 id 去向 + receipt），可离线回放；merge / conflict / update 幂等应用，重放/并发重复执行无累积副作用；update 记录 `_before` 快照

#### dreamMaxTokens 调优指南

默认 `4096` 已覆盖常规记忆库。当**记忆量大**（数万字符以上）时，决策清单与摘要可能超过默认预算，建议按规模调大：

| 记忆库规模 | 建议 `dreamMaxTokens` |
|-----------|----------------------|
| 常规（<1 万字） | `4096`（默认） |
| 中等（1 万-5 万字） | `65536` |
| 大型（5 万字以上） | `131072`（上限） |

> 若使用**思考型模型**（如 deepseek-v4-flash / DeepSeek-R1 类），模型可能把全部预算花在 reasoning 上导致正文为空（日志出现 `no json array in llm output`）。此时把 `dreamReasoningEffort` 设为 `off` 显式关闭思考（实测 8192 token 预算不再被推理吃光，输出恢复正常）；sleep 侧对应 `sleepReasoningEffort`。默认 `none` 不传该字段，完全沿用模型自身默认，行为与旧版本一致。

### Sleep Mode 系统级睡眠 💤（v0.4.0，opt-in）

从 autoDream 的"被动阈值触发"升级为"主动定时维护 + 分层压缩"。系统空闲 `sleepIdleMinutes` 分钟自动执行深度维护，**默认关闭**（`sleepModeEnabled: false`），开启后行为：

- **可中断**：AbortController 实现，用户恢复活动即中止当前周期（`noteWrite` 重置空闲计时 + 中断信号）
- **串行安全**：睡眠周期走 `service.enqueue` 串行队列，与 autoDream 严格不重叠；`minRefTimeMs` 防止快照后被召回的记忆被误降级
- **四阶段深度维护**：
  1. `conflict_resolution`：全库冲突消解，strictness 三级可配（gentle 0.92 / normal 0.85 / aggressive 0.75）
  2. `archival_demotion`：按 `last_accessed_at` 分层——30 天未召回压成摘要（原文进 `_full_content`，可无损恢复）、90 天完全归档
  3. `pattern_discovery`：LLM 扫描近期记忆提炼规律，产出 `type=pattern` 记忆，evidence 强校验防伪造
  4. `relation_completion`：检测孤立实体并补全隐含关系（共现 `related_to` / 项目 `part_of` / 技术 `depends_on`）
- **Fail-safe**：每阶段独立 try/catch，LLM 故障只跳过对应阶段；无 LLM 路由时纯规则降级（demotion/relations）照常执行
- **审计延续**：睡眠周期写入 `dream_runs`，`run_type='sleep'`，与 autoDream 共用审计表可追溯

> 配置详见 `docs/SLEEP.md`；迁移说明见 `docs/MIGRATION.md`。

### 会话生命周期：把对话当存档点 💾（v0.6.0，opt-in）

**默认关闭**（`sessionLifecycleEnabled: false`，保持旧行为）。开启后，会话被删除/销毁（DSH `session/disposed` 事件）时，自动把该会话内出生（`session_id` 溯源）的记忆**软隐藏**——不再出现在检索/注入/列表/整理，但**不删除**，随时可恢复：

- **与 `archived` 正交**：`archived` 是用户/AI 主动"长期保留但安静"，`session_disposed_at` 是会话删除被动隔离，两者互不覆盖。恢复会话绝不复活你手动归档的记忆
- **全局记忆免疫**：存量无 `session_id` 的记忆视为全局，永不参与会话清理
- **幂等 + 熔断**：dispose/restore 状态守卫幂等（重复调用 no-op）；事件回调内部异常 catch 住，不抛进 DSH 会话清理流程
- **恢复**：整会话 `service.restoreBySession(sessionId)` 一键还原；`service.listBySession(sessionId, { includeDisposed: true })` 可查看当前隐藏了哪些（DTO 带 `disposed` 标记）

### Wiki-Link 双向链接 🔗（v0.6.1，opt-in）

**默认关闭**（`wikiLinkEnabled: false`）。开启后，记忆正文支持 `[[target]]` / `[[显示|target]]` 双括号链接语法：保存时自动解析并记录跨记忆 `links_to` 关系（partial 唯一索引只对 links_to 去重），记忆详情旁出现反向链接面板，点击可跳转来源记忆。提供只读 API：backlinks / forward-links / wikilink-resolve（输出脱敏）。

### Tag 系统 🏷️（v0.6.2，opt-in）

`autoTagEnabled` 默认关。开启后：正文 `#标签` 即时标记（规则 `[a-zA-Z0-9_一-龥-]+`，≤20 字符，非法/超长自动丢弃）；autoDream 整理后 LLM 自动打 1-3 个标签（`autoTagMaxPerRun=10` 频控，fail-safe）；tags 存 `entity_attrs`；`tag:` 搜索前缀可与关键词/`entity:`/`attr:` 组合；mirror 顶部渲染 `#tag` 行；记忆面板标签可点击（过滤）、添加、移除（`manualTagEnabled` 默认开）。存储与搜索能力始终可用，`autoTagEnabled` 只控制自动打标。

### 目录视图 📁（v0.6.3）

记忆面板新增「目录」视图：以 Tag 为轴心的一级手风琴文件夹，无标签记忆自动沉底到「无标签」兜底组；组内按重要性/时间双降序；点击条目直达详情页。数据由 `GET /api/dsh-mneme/directory` 提供（只读、排除 disposed/archived/forgotten）。

### Tag 加权召回 ⚖️（v0.6.4，opt-in）

`tagBoostEnabled` 默认关。开启后，三路召回合并出候选后做 tag 加权重排：候选记忆 tags 与 Query 提取 tags（`#xxx` + 已知 tag 列表）交集 → 分数 `×1.15`；与当前 Session 热记忆 tags 交集 → `×1.08`（可叠加，上限 1.0）。关闭时行为与旧版完全一致，可用 `evaluateRetrieval` 开关对比调优。

官方设置面板 → 「记忆库设置」→「记忆」标签：按类型浏览、全文搜索；启用向量搜索后可用「语义」切换做向量召回。

### 用户设置（画像 / 规则）与自定义指令 ⚙️

官方设置面板 → 「记忆库设置」标签：

- **用户画像**：一段自由文本描述用户自己（角色、背景、偏好），**每轮注入**到系统提示，让 Agent 始终遵循
- **规则**：Agent 必须遵守的行为规则列表（如"回答先给结论"），同样每轮注入
- **自定义指令**：注册斜杠命令（`/名称`），触发时把用户定义的指令内容交给 Agent。命令持久化到 SQLite，启动时自动注册到 DSH 命令表，增删实时生效

> 画像与规则通过独立的 `[用户设置]` 注入区块（优先级高于记忆库），即使记忆为空也会注入。

### 向量搜索（语义搜索）🔎

可选能力：接入 OpenAI 兼容的 embeddings API，让搜索能命中**字面不同但语义相近**的记忆。

**配置**：官方设置 → 「记忆库设置」→ 滚动到底部「向量搜索」区块：

| 字段 | 说明 |
|------|------|
| `启用向量搜索` | 总开关；开启后记忆面板出现「语义」切换 |
| `API 地址 (Base URL)` | OpenAI 兼容端点，如 `https://api.openai.com/v1`；也支持 SiliconFlow、智谱、本地 Ollama 等 |
| `API Key` | 对应服务的密钥 |
| `模型名` | embedding 模型，如 `text-embedding-3-small`、`text-embedding-v3`、`bge-m3` 等 |

保存配置后点「重建索引」，为已有记忆批量补建向量（新写入的记忆会自动嵌入）。之后在记忆面板输入查询并点「语义」，即可用向量召回语义相关结果；向量服务不可用时自动回退全文搜索。

> ⚠️ 密钥仅保存在本机 `~/.dsh/memory/memory.db` 的 `user_settings` 表，不会上传，也不会写入代码仓库。
> 需要 embedding 而非 rerank 模型：如阿里云 `text-embedding-v3` 可用，`qwen3-vl-rerank` 是 rerank 模型（不走 `/embeddings`）。

### 语义增强（Semantic）🧠

v0.2 起新增**完全离线的语义记忆引擎**（本地模型 + 精排 + 聚类）：

- **本地 Embedding**：三后端可选——ONNX（`Xenova/bge-small-zh-v1.5`，离线）/ Ollama / OpenAI 兼容，失败自动逐级降级，最差回退关键词搜索
- **Rerank 精排**：`Xenova/bge-reranker-base` 对召回候选交叉编码精排，提升 Top-K 准确率
- **autoDream 语义增强**：对记忆向量聚类（`clusterMemories`），自动发现主题相近 / 疑似矛盾的记忆，巩固更精准
- **搜索流水线**：混合召回（关键词 + 向量）→ Rerank → Top-K

配置只需在 `cordis.patch.yml` 里设置 `embedProvider`（默认 `openai`，保持 v0.1 行为；改为 `local` 即离线）。升级无需迁移数据。

### 实体结构化记忆（Entity Gene）🧬

v0.3.0 起新增**记忆基因**层：从记忆里抽取**命名实体**、**带时间轴的属性**、**实体间关系**，让搜索从"字面关键词"升级为"按实体/属性精确召回"。

- **三表**：`entities` / `entity_attrs`（`valid_until` 快照式时间轴）/ `entity_relations`，旧库打开自动建表，幂等无迁移成本
- **自动抽取**：`entityExtractionEnabled=true` 后，新写入的记忆 fire-and-forget 触发 LLM 抽取（同名实体去重、属性存时间轴、关系追加；失败绝不阻塞写入）
- **实体搜索**（`searchMemories` 前缀路由，`entitySearchEnabled` 默认开）：
  - `entity:阿尔托` → 属性精确关联的记忆（`_score 1.0`）排在关键词提及（`_score 0.7`）之前
  - `attr:国籍=芬兰` → 精确匹配该属性值的记忆
  - `attr:国籍` → 该属性键的**全部**当前有效记忆（value 为空契约）
- **autoDream 联动**：update 决策写 `supersedes` 自引用（属性版本被替代）；merge 决策把 loser 的属性归属迁移到 keeper（keeper 已有同键当前值则失效）

> 📖 详见 [实体结构化记忆设计](docs/ENTITIES.md) · [语义增强架构](docs/SEMANTIC.md) · [本地模型部署指南](docs/LOCAL_MODEL.md) · [从 v0.1 升级说明](docs/MIGRATION.md)

### 记忆质量过滤 🧼（v0.4.6，默认开）

写库前对每条记忆做**启发式质量打分**（纯函数，无 I/O、无共享状态）：元记忆词汇（谈论记忆系统本身）、自指类型标签、内容过短、重复度高、与近期记忆近似重复都会扣分（0-100）：

- `score ≥ 60`：正常存储
- `30 ≤ score < 60`：`quality_score` 落库，注入排序改为按 `importance × quality/100` 降权（degraded）
- `score < 30`：归档并标记 `low_quality`——仍可显式搜索召回，只是**永不自动注入**

`memoryQualityFilter.enabled` 可整体关闭，`archiveThreshold` / `degradeThreshold` / `minContentLength` 可调。

### LLM 消耗审计 📊（v0.4.6，默认开）

每次**后台 LLM 调用**（autoDream 整理 + 摘要、autoSummarize 压缩）都会写入 `llm_audit_logs` 表：`tokens` / `duration` / `status` / `source`（由哪个触发产生）。失败调用记为 `status=error`，绝不阻塞功能本体；`retentionDays`（默认 90）在启动时清理超期行。新增两个只读 API：

- `GET /api/dsh-mneme/semantic/llm-audit?page=&pageSize=&source=` — 分页查询 + 按 source 过滤
- `GET /api/dsh-mneme/semantic/llm-audit/stats?days=` — 近 N 天按 source 汇总预算（tokens / 次数 / 失败数）

> 只读端点，与 list/search/semantic 一样在设置 `apiToken` 后仍保持开放。

### 记忆库主区视图与记忆图谱 🕸️（v0.5.0）

记忆功能从侧边栏抽屉收进**主内容区全宽 tab**（conversation.view 插槽，与「对话 / Trajectory」并列），侧边栏「记忆」入口点击后直接激活该 tab。页面顶部子 tab 行切换三个子视图：

- **记忆（三栏浏览）**：左栏分类树（类型 + 计数）/ 中栏时间树（月 → 日两级倒序、可折叠）/ 右栏详情（**全文不截断** + 复制全文）；语义搜索内嵌工具栏开关（防抖 250ms），`entity:` 前缀可「在图谱中查看」
- **图谱**：输入实体名，加载以该实体为中心的关联网络——
  - 服务端只读 ego-graph API：`GET /api/dsh-mneme/semantic/graph/ego?entity=<name>&depth=1|2`（BFS 层级遍历，`limit` 防大图失控，实体不存在 404；配套 `/semantic/graph/entity-attrs` 查实体属性）
  - 前端**零依赖手写 SVG 力导向布局**（插件运行时无法 require vis-network 等第三方库）：斥力 + 弹簧 + 向心引力物理模拟，节点按类型着色、按提及次数定半径，支持拖拽、点节点看属性、点边跳回来源记忆
- **设置**：画像 / 规则 / 指令 / 向量配置，限宽居中

图谱 ↔ 记忆双向互跳：图谱详情侧的关联记忆可点击，记忆边的「来源记忆」按 memory_id 直跳三栏视图并自动定位。

### 三路召回融合与会话热记忆 🔎（v0.5.0）

- **BM25 稀疏第三路召回**（`src/search/bm25.js`）：与向量召回、FTS5/LIKE 关键词并列——ASCII 词元 + CJK bigram 分词、IDF 加权（归一化 [0,1]），专有名词 / ID / 代码片段等散词查询不再依赖子串命中。融合规则：未召回行按 `0.3×BM25分` 回填；仅向量召回行获得词法加分；LIKE 已命中行不叠分。`bm25SearchEnabled` 可关
- **自适应阈值**（`src/search/adaptive.js`）：取代固定 `0.65` 截断——`entity:`/`attr:` 前缀放宽 0.5，短查询（<5 字符）收紧 0.7，长查询（>50）放宽 0.6，Top1/Top5 分差 > 0.3 时放宽让尾部进 Rerank；显式传 `threshold` 或 `adaptiveThresholdEnabled=false` 走旧行为
- **会话级短期热记忆**（`src/hot-memory.js`）：最近 N 轮对话（默认 5 轮，`hotMemoryRounds`）按 token 预算（默认 2000，`hotMemoryMaxTokens`）滚动截断，从会话事件日志无状态重建、不落库；注入顺序为「短期上下文 → 长期记忆召回 → 摘要」
- **选择性注入**：query 向量可用时注入候选按主题相似度重排（`selectiveInjectEnabled` 可关）；**搜索时语义去重**为激进选项（`searchSemanticDedup=true` 显式开启，近重复行 Rerank 前丢弃）
- **召回基准**（`scripts/benchmark-recall.js`）：标准查询集驱动，计算 Recall@5 与 MRR，`legacy`（三特性全关）vs `fused`（默认配置）双跑对比

## 🆕 最近版本亮点

| 版本 | 亮点 |
|------|------|
| **v0.6.7** | 记忆面板前端增强：记忆删除端点 + autoTag 手动开关 + 目录 VS Code 式文件树 + 面板卡片式布局（分类栏 + search/tree/detail 三卡）；716 测试全绿 |
| **v0.6.6** | kimi-k3 复验 4 项修复：autoTag 跳过已打标记忆并合并、tag: 搜索召回统计门控（避免零召回拖垮 TopK）；710 测试全绿 |
| **v0.6.5** | 整合 v0.6.2-0.6.4：Tag 系统 + 目录视图 + Tag 加权召回（全部 opt-in）；709 测试全绿 |
| **v0.6.4** | Tag 加权召回：query/session tag 交集 boost（`tagBoostEnabled` 默认关） |
| **v0.6.3** | 目录视图：Tag 文件夹 + 无标签兜底 + 点击跳详情 |
| **v0.6.2** | Tag 系统：`#标签` + autoDream 自动打标 + `tag:` 搜索 + 面板 chips |
| **v0.6.1** | Wiki-Link 双向链接（笔记化记忆库第一步）：[[笔记]] 跨记忆链接 + 反向链接面板 + links_to partial 唯一索引；654 测试全绿 |
| **v0.6.0** | 会话生命周期（把对话当存档点）：`session_disposed_at` 独立字段软隐藏会话删除的记忆（与 `archived` 正交，可恢复）+ `memory_delete` 支持描述删除 + 事件订阅熔断；阿里云 kimi-k2.7-code 审查 4 项修复；628 测试全绿 |
| **v0.5.0** | 主区「记忆库」视图（取代侧边栏抽屉）+ 记忆图谱可视化（ego-graph API + 零依赖 SVG 力导向）+ BM25 三路召回融合 + 自适应阈值 + 会话热记忆 + 召回基准评测；593 测试全绿 |
| **v0.4.2** | autoSummarize 自定义模型：`summarizeProvider`/`summarizeModel` 配置项，可独立指定轻量模型（如 qwen3.6-plus）用于会话摘要，节省主模型 token；473 测试全绿 |
| **v0.4.0** | 系统级睡眠 Sleep Mode：空闲触发的四阶段深度维护（冲突消解 / 归档降级 / 模式发现 / 关系补全），可中断、串行安全、fail-safe，分层压缩释放冷记忆；471 测试全绿 |
| **v0.3.9** | 修复第三方审计 4 项 FAIL：CAS 同事务原子化、Mirror 降级回执透传、逐 type 物理终态收敛、Generation 强整数校验与并发初始化稳定化 |
| **v0.3.8** | audit peer 复验 6 项运行时阻断全部修复：desired generation 同事务原子递增（崩溃窗口不再静默跳过）、同步失败不静默、原子 generation 增量（多进程零丢失）、逐 type committed/failed/pending 回执、读取失败显式 unknown、generation 上界/负数 CHECK |
| **v0.3.7** | 启动竞态修复：人工编辑 md 镜像后重启向量重建失败（回灌移入 init 就绪后 + scheduleEmbed 就绪门） |
| **v0.3.6** | mirror 同步状态机：generation/applied_generation 债务建模、F-NEW-03 mirror 健康状态、持久 dirty + 启动 recoverMirror |
| **v0.3.0** | 记忆基因：实体/属性/关系三表 + 时间轴 + 实体搜索 + autoDream supersedes |

## 🗺️ 进化路线图

| 版本 | 状态 | 主题 | 说明 |
|------|------|------|------|
| v0.2.x | ✅ 完成 | 语义增强 + 反思更新 | 本地 Embedding/Rerank/聚类、`failure_memories` 失败追踪 |
| v0.3.0 | ✅ 完成 | 记忆基因 | entities/attrs/relations 三表 + 时间轴 + 实体搜索 |
| v0.3.6–0.3.8 | ✅ 完成 | 镜像一致性 + 审计加固 | generation 同步状态机、audit peer 6 项运行时阻断修复、450 测试全绿 |
| v0.3.9 | ✅ 完成 | 审计加固 A/B/D/F | compareAndUpdate 同事务原子性、degraded 回执、逐 type 物理终态、整数 fail-closed、并发初始化稳定 |
| **v0.4.0** | ✅ 完成 | 系统级睡眠 Sleep Mode | 空闲触发的四阶段深度维护（冲突消解 / 归档降级 / 模式发现 / 关系补全）、分层压缩、可中断串行 fail-safe；471 测试全绿 |
| **v0.4.2** | ✅ 完成 | autoSummarize 自定义模型 | `summarizeProvider`/`summarizeModel` 配置项支持，可独立指定轻量模型（如 qwen3.6-plus）用于会话摘要，节省主模型 token；473 测试全绿 |
| **v0.4.3** | ✅ 完成 | autoDream 大记忆量修复 | issue#9 B+A：`dreamMaxTokens` 上限 32768→131072 + `dreamReasoningEffort`/`sleepReasoningEffort` 思考开关（none 默认，主对话不受影响）；478 测试全绿 |
| **v0.4.4** | ✅ 完成 | autoDream 决策覆盖修复 | issue#9 方案C：滑动窗口 `dreamMaxSnapshotSize`(默认200，updated_at 倒序截断) + 隐式 keep `dreamImplicitKeep`(默认true) + 覆盖率下限 `dreamMinExplicitCoverage`(默认50%) + 固定决策 schema；487 测试全绿 |
| **v0.4.5** | ✅ 完成 | epistemic trust + recall eval | 记忆可信度分级 `trustEpistemicWeighting`（observation>inferred>subjective：检索排序优先高可信、注入标注 `[verified]`、dream merge/conflict 偏向高可信；opt-in 默认关）+ 检索评估 `evaluateRetrieval` 落库 `recall_evals`（`evalPersistTestResults` opt-in 默认关，生产检索始终走 `recall_runs` 无条件隔离）；518 测试全绿 |
| **v0.4.6** | ✅ 完成 | 8 项修复（向量链路 + 注入/质量/审计） | 向量链路修复（embedSingle 适配 / `autoReindexOnBoot` 存量回填 / `vector_meta` 元数据）+ 注入语义召回 `hybridInject` + 同标题追加 `content_history` + 注入长度上限（单条 300 / 整块 1500）+ 记忆质量过滤 `memoryQualityFilter` + LLM 消耗审计 `llmAudit`（表 + 埋点 + 只读 API）；553 测试全绿 |
| **v0.4.7** | ✅ 完成 | schema 迁移幂等化 | 并发打开同一 db 时 `PRAGMA table_info` 检查与 ALTER 非原子，可能重复 `ADD COLUMN` 报 duplicate column name；改用 `addColumn` helper 吞掉竞态（try/catch），12 处迁移统一收口 |
| **v0.5.0** | ✅ 完成 | 召回融合与记忆可视化 | 主区「记忆库」视图 + 记忆图谱（ego-graph API + 零依赖 SVG 力导向）+ BM25 三路召回融合 + 自适应阈值 + 会话热记忆 + 召回基准；593 测试全绿 |
| **v0.6.0** | ✅ 完成 | 会话生命周期 | 把对话当存档点：`session_disposed_at` 软隐藏会话删除的记忆（与 `archived` 正交、可恢复）+ `memory_delete` 描述删除 + 事件熔断；628 测试全绿 |
| **v0.6.1** | ✅ 完成 | Wiki-Link 双向链接 | 笔记化记忆库第一步：`[[target]]` 跨记忆链接 + 反向链接面板 + links_to partial 唯一索引；654 测试全绿 |
| **v0.6.2** | ✅ 完成 | Tag 系统 | `#标签` 解析 + autoDream 自动打标 + `tag:` 搜索 + 面板 chips + mirror `#tag` 行（全部 opt-in） |
| **v0.6.3** | ✅ 完成 | 目录视图 | Tag 文件夹手风琴 + 无标签兜底 + 点击跳详情 + `GET /api/dsh-mneme/directory` 端点 |
| **v0.6.4** | ✅ 完成 | Tag 加权召回 | query/session tag 交集 boost（×1.15 / ×1.08），`tagBoostEnabled` 默认关 |
| **v0.7.0+** | 🚀 远期 | 自进化记忆 | 兴趣漂移跟踪 + 跨 workspace 记忆共享（等 DSH 支持） |

> 新能力一律做成**可开关的功能**（配置启用/关闭），默认保守开启、不破坏现有行为。`failure_memories` 表与 autoDream 决策引擎已为后续反思性成长铺好路。

## 📦 安装

### 前置条件

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）
- Node 24+（`node:sqlite`）

### 安装步骤

#### 方式一：npm 安装（推荐）

dsh-mneme 是一个 **bundle**（声明了 `dsh.bundle` manifest），安装即自动激活，无需手动写配置：

```bash
# 1. 安装插件（自动注册 bundle 层）
dsh plugin --profile web add @modusensus/dsh-mneme

# 2. 重启
dsh web
```

> 如需自定义配置（阈值、延迟等），可在 `~/.dsh/profiles/web/cordis.patch.yml` 中按 `id: dsh-mneme` 覆盖默认值（见下方配置表）。

#### 方式二：从源码安装

```bash
git clone https://github.com/modusensus/dsh-mneme.git
cd dsh-mneme
dsh plugin --profile web add .
dsh web
```

#### 自定义配置（可选）

默认配置即可用。如需调整，在 `~/.dsh/profiles/web/cordis.patch.yml` 中覆盖：

```yaml
- id: dsh-mneme
  name: '@modusensus/dsh-mneme'
  config:
    memoryDir: ~/.dsh/memory
    autoInject: true
    autoSummarize: true
    maxInjectedItems: 5
    importanceThreshold: 3
    autoDream: true
    dreamThresholdCount: 10
    dreamThresholdChars: 5000
    dreamDelayMs: 2000
    # 会话生命周期（v0.6.0，默认关）：会话被删时软隐藏其记忆，可恢复
    # sessionLifecycleEnabled: false
```

## ⚙️ 配置

| 键 | 默认值 | 说明 |
|----|--------|------|
| `memoryDir` | `~/.dsh/memory` | 记忆存储目录（SQLite + Markdown） |
| `autoInject` | `true` | 会话启动自动注入记忆 |
| `autoSummarize` | `true` | 会话结束自动提炼摘要 |
| `summarizeProvider` / `summarizeModel` | 空 | 摘要的 LLM 路由覆盖（空=使用当前会话模型）；推荐轻量模型节省主模型 token |
| `maxInjectedItems` | `5` | 最多注入几条记忆 |
| `importanceThreshold` | `3` | 注入的最低重要性（1-5） |
| `autoDream` | `true` | 自动记忆整理开关 |
| `dreamThresholdCount` | `10` | 触发整理的记忆条数阈值 |
| `dreamThresholdChars` | `5000` | 触发整理的总字符阈值 |
| `dreamDelayMs` | `2000` | 整理异步延迟（去抖） |
| `dreamProvider` / `dreamModel` | 空 | dream 的 LLM 路由覆盖（显式配置优先于 agent 默认模型；留空则回退到 agent 默认模型） |
| `dreamMaxTokens` | `8192` | dream LLM 调用最大 token 数（上限 131072；大记忆量建议调大，见下方调优指南） |
| `dreamReasoningEffort` | `none` | dream LLM 推理强度透传：`off` / `low` / `medium` / `high` / `none`（`off`=显式关闭思考，思考型模型（如 deepseek-v4-flash）必须用它，否则推理会烧光 token 预算导致正文为空；`none`=不传该字段，沿用模型默认） |
| `apiToken` | 空 | 可选 API 鉴权 token；设置后写操作与密钥接口要求 `Authorization: Bearer <apiToken>` |
| `embedProvider` | `openai` | 语义后端：`openai`（默认，兼容 v0.1）/ `local`（ONNX 离线）/ `ollama` |
| `localEmbedModel` | `Xenova/bge-small-zh-v1.5` | 本地 ONNX embedding 模型 |
| `localEmbedDimension` | `512` | 本地 embedding 向量维度 |
| `localEmbedDevice` | `cpu` | 本地推理设备：`cpu` / `gpu` |
| `localEmbedBatchSize` | `8` | 本地 embedding 批大小（1-64） |
| `ollamaBaseUrl` | `http://localhost:11434` | Ollama 服务地址 |
| `ollamaModel` | `nomic-embed-text` | Ollama embedding 模型 |
| `embedModelCacheDir` | 空 | 模型缓存目录（空 = 用户级 `~/.dsh/mneme/models`） |
| `embedModelMirror` | `https://hf-mirror.com` | 模型下载镜像源 |
| `vectorSearchTopK` | `20` | 向量搜索返回 Top-K |
| `vectorSearchThreshold` | `0.65` | 向量搜索相似度阈值 |
| `hybridSearchVectorWeight` | `0.6` | 混合搜索向量权重 |
| `hybridSearchKeywordWeight` | `0.4` | 混合搜索关键词权重 |
| `rerankEnabled` | `false` | 是否启用 Rerank 精排（显式开启才加载本地 onnxruntime 模型） |
| `rerankProvider` | `none` | Rerank 后端：`local` / `none`（默认 `none`） |
| `rerankModel` | `Xenova/bge-reranker-base` | Rerank 交叉编码模型 |
| `rerankBatchSize` | `8` | Rerank 批大小 |
| `rerankMaxCandidates` | `30` | Rerank 最大候选数 |
| `rerankScoreThreshold` | `0.1` | Rerank 分数阈值（低于丢弃） |
| `reflectionUpdateEnabled` | `true` | update 决策总开关 |
| `reflectionFailureTracking` | `true` | 失败追踪总开关 |
| `reflectionUpdateMaxPerRun` | `2` | 每次整理最多 update 数 |
| `reflectionUpdateMinAgeHours` | `24` | 新建记忆保护期（小时） |
| `entityExtractionEnabled` | `false` | 实体抽取总开关（v0.3.0；存储层恒可用） |
| `entityExtractionModel` | 空 | 抽取专用模型（空 = 用 agent 默认模型） |
| `entityExtractionMaxEntities` | `10` | 每次抽取实体数上限 |
| `entityExtractionMaxAttrs` | `20` | 每实体属性数上限 |
| `entitySearchEnabled` | `true` | `entity:` / `attr:` 前缀搜索开关 |
| `trustEpistemicWeighting` | `false` | 记忆可信度加权（v0.4.5，opt-in 默认关）：记忆按来源分级 `observation`> `inferred` > `subjective`，开启后检索排序优先高可信记忆、注入对 observation 标注 `[verified]`、dream merge/conflict 偏向高可信一方；关闭时 `epistemic_status` 仅随保存落库、不参与行为 |
| `evalPersistTestResults` | `false` | 检索评估落库（v0.4.5，opt-in 默认关）：开启后 `evaluateRetrieval` 把 precision/recall/mrr 快照写入 `recall_evals`；默认关时仅返回调用方不落库。生产 `searchMemories` 审计始终走 `recall_runs`，无条件不触碰 `recall_evals` |
| `autoReindexOnBoot` | `true` | 存量记忆缺 embedding 时，向量已配置则启动后延迟后台按批次限速自动回填重建（设为 `false` 仅手动重建） |
| `hybridInject` | `true` | 注入语义召回优先（v0.4.6，Bug4）：`injectCandidates` 带非空 query 时先走向量索引语义召回候选，规则筛选补足/去重；空 query / 无向量回退旧逻辑 |
| `bm25SearchEnabled` | `true` | BM25 稀疏第三路召回（v0.5.0）：ASCII 词元 + CJK bigram，IDF 加权，散词/ID/代码片段查询不再依赖子串命中 |
| `adaptiveThresholdEnabled` | `true` | 自适应相似度阈值（v0.5.0）：按查询形态动态截断（前缀 0.5 / 短查询 0.7 / 长查询 0.6 / 头部分差大放宽 0.5），显式传 `threshold` 走旧行为 |
| `hotMemoryEnabled` | `true` | 会话级短期热记忆总开关（v0.5.0）：关闭后热记忆块不再注入（长期召回不受影响） |
| `hotMemoryRounds` | `5` | 会话级短期热记忆轮次（v0.5.0）：最近 N 轮对话滚动注入，从会话事件日志无状态重建、不落库 |
| `hotMemoryMaxTokens` | `2000` | 热记忆 token 预算（v0.5.0，200-32000），超出滚动截断 |
| `selectiveInjectEnabled` | `true` | 选择性注入（v0.5.0）：query 向量可用时注入候选按主题相似度重排，替代固定规则序 |
| `searchSemanticDedup` | `false` | 搜索时语义去重（v0.5.0，激进选项默认关）：embedding 余弦 ≥0.95 近重复行在 Rerank 前丢弃 |
| `searchSemanticDedupThreshold` | `0.95` | 语义去重相似度阈值（v0.5.0，默认 0.95，范围 0.5-1.0）：`searchSemanticDedup=true` 时生效，调整可防小模型误折叠 |
| `memoryQualityFilter` | `{enabled:true, archiveThreshold:30, degradeThreshold:60, minContentLength:10}` | 记忆质量过滤（v0.4.6，默认开）：写库前启发式打分 0-100，元记忆词汇/自指/过短/重复/近似重复扣分；≥60 正常存储，30-60 降权（注入排序按 importance×quality/100），<30 归档标记 `low_quality`（显式搜索仍可召回，永不自动注入） |
| `llmAudit` | `{enabled:true, retentionDays:90}` | LLM 消耗审计（v0.4.6，默认开）：每次后台 LLM 调用（autoDream/autoSummarize）写 `llm_audit_logs`（tokens/duration/status/source）；失败记 error 不阻塞；只读 API `/api/dsh-mneme/semantic/llm-audit` + `/llm-audit/stats` |
| `sessionLifecycleEnabled` | `false` | 会话生命周期（v0.6.0，默认关）：开启后会话被删除/销毁时自动把该会话出生的记忆软隐藏（`session_disposed_at`，与 `archived` 正交、可恢复）；存量无 `session_id` 的记忆永不参与清理 |

> 🔐 **API 安全**：DSH 无内置鉴权且默认仅监听 `127.0.0.1`。插件 API 默认开放（便于 Web 面板即装即用）。如需防护（如局域网暴露），在配置中设置 `apiToken`：写操作（画像/规则/命令）与密钥端点（`vector-config`、`vector-reindex`）需携带 `Authorization: Bearer <token>`（前端设置面板可填入同一 token），只读的 `list` / `search` / `semantic` 保持开放。`/api/dsh-mneme/vector-config` 返回的 `apiKey` 已掩码（`sk-***…`），存储仍保留明文供调用；前端回传空或掩码值表示"不改 key"。

## 🏗️ 架构

```
┌─────────────────────────────────────────────────┐
│  存储层：SQLite (archived/forgotten 状态)         │
│         + Markdown 镜像（人工可编辑，双向同步）    │
├─────────────────────────────────────────────────┤
│  服务层：saveWithDedupe / injectCandidates        │
│         / mergeHumanEdits / onWrite 钩子          │
├─────────────────────────────────────────────────┤
│  模型接口：7 个工具 + 自动注入 + 会话摘要          │
├─────────────────────────────────────────────────┤
│  autoDream：阈值调度 → LLM 决策清单               │
│            → 校验（fail-safe）→ 应用 → 摘要       │
├─────────────────────────────────────────────────┤
│  Web 面板：设置面板内嵌 + 浏览/搜索（含向量）    │
└─────────────────────────────────────────────────┘
```

**源码结构**：

```
src/
├── store.js          # SQLite 存储（CRUD、搜索、归档/遗忘、schema 迁移）
├── mirror.js         # Markdown 镜像（渲染/解析，人工优先）
├── service.js        # 领域逻辑（去重合并、注入筛选、写入钩子）
├── config.js         # schemastery 配置 schema
├── tools.js          # 7 个模型工具（defineTool）
├── inject.js         # systemPrompt.context 动态注入
├── summarize.js      # 会话结束 LLM 摘要
├── dream.js          # autoDream 调度 + runDream（LLM 决策 + 摘要）
├── dream/decisions.js# 决策校验（fail-safe）+ 决策应用
├── entities/extractor.js # 实体抽取器（v0.3.0：LLM JSON 抽取 + 去重 + fail-safe）
├── search/bm25.js    # BM25 稀疏召回（v0.5.0：分词 + IDF 索引）
├── search/adaptive.js# 自适应相似度阈值（v0.5.0）
├── hot-memory.js     # 会话级短期热记忆（v0.5.0：滚动轮次 + token 预算）
├── embedding.js      # OpenAI 兼容 embeddings 客户端 + 向量检索
├── api.js            # HTTP 路由（Web 面板数据通道）
└── index.js          # 插件接线
lib/
├── client.js         # Web 面板（手写 ModuleLoader bundle）
└── *.js              # src 的同步分发产物
test/                 # 716 个 node:test 测试（含审计与三轴线压测不变量）
scripts/              # e2e-dsh.js 端到端演示 · stress-dsh.js 三轴线压测 · sync-lib.js 同步 · benchmark-recall.js 召回基准
```

## 🧪 开发

```bash
cd dsh-mneme
npm install        # 安装 peer 依赖（以 devDependencies 形式，用于本地测试）
npm test           # 运行 716 个测试
npm run stress     # 三轴线压测：长会话检索 / 冲突仲裁 / 多 Agent 并发（离线 mock LLM）
npm run sync       # 把 src/ 同步到 lib/（发布时由 prepack 钩子自动执行）
```

> 压测（`npm run stress`）三条轴线：**长会话检索**（Recall@k、陈旧残留率）、**冲突裁决**（可重放仲裁集：审计快照 hash + receipt + 幂等回放）、**多 Agent 并发**（丢更新、重复合并、事务/崩溃恢复）。每次 autoDream 运行都会写入审计表 `dream_runs`（输入快照 digest + 决策清单 + 逐 id 去向 + receipt），让高通过率下也能定位静默错误。

> `lib/` 是 `src/` 的同步分发产物（`npm run sync`），其中 `lib/client.js` 为手写 Web 面板源码，不受同步影响。

## 📄 设计文档

> 设计文档位于仓库根 `docs/`，链接以 `../docs/` 相对路径指向（GitHub 上从本目录打开可正常跳转）。

- [实体结构化记忆设计](docs/ENTITIES.md)
- [语义增强架构](docs/SEMANTIC.md)
- [本地模型部署指南](docs/LOCAL_MODEL.md)
- [从 v0.1 升级说明](docs/MIGRATION.md)

## 📜 License

MIT
