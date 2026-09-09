<p align="center"><strong>中文 | <a href="docs/SEMANTIC.md">English（语义增强）</a></strong></p>

# dsh-mneme

[![npm version](https://img.shields.io/npm/v/@modusensus/dsh-mneme?color=blue&label=npm)](https://www.npmjs.com/package/@modusensus/dsh-mneme)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Awesome](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![tests](https://img.shields.io/badge/tests-744%20passed-success)](https://github.com/modusensus/dsh-mneme)
[![CI](https://img.shields.io/github/actions/workflow/status/modusensus/dsh-mneme/ci.yml)](https://github.com/modusensus/dsh-mneme/actions)
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
- 删对话 ≠ 删记忆——记忆是跨会话的全局知识（v0.7.11 起不再与会话绑定），删除会话不影响已存入的记忆

## ✨ 功能

### 记忆存储（SQLite + Markdown 镜像）

- **SQLite 主存储**：`~/.dsh/memory/memory.db`，`node:sqlite` 内置，零原生依赖
- **Markdown 镜像**：`preferences.md` / `projects.md` / `decisions.md` / `history.md` / `summary.md`，人类可读、可手工编辑（**人工修改优先**合并回库）
- **9 种记忆类型**：`preference` 偏好 / `project` 项目 / `decision` 决策 / `history` 历史 / `summary` 会话总览 / `pattern` 模式 + 编码记忆三型 `rejected_solution` 被否方案 / `pitfall` 踩坑 / `constraint` 约束（v0.7.13 起，`codingRetrospect` 默认关；v0.7.11 近重写已收窄删除 user/fact 两型）
- **镜像同步状态机（v0.3.6+）**：mirror 与主库强一致，用 `generation`（期望轮次）/ `applied_generation`（已应用轮次）建模同步债务
  - 业务写操作在**自身事务内原子递增** desired generation——崩溃在 COMMIT 后、渲染前，重启也能凭 durable 债务恢复，绝不静默跳过（v0.3.8）
  - `generation` 用 SQLite 原子语句递增，多进程并发零丢失；带 `CHECK` 上界，负数/溢出拒绝
  - 逐 type 记录 `committed / failed / pending` 回执，健康端点区分 `ok / degraded / unknown`
  - 状态写失败不静默：同步失败落日志并留债务，重启自动收敛

### 模型工具（8 个）

| 工具 | 功能 |
|------|------|
| `memory_save` | 记录一条记忆（自动按标题去重合并） |
| `memory_search` | 全文搜索（中文子串友好，可启用向量语义搜索） |
| `memory_list` | 按类型分页列出（`include_archived=true` 可查看已归档） |
| `memory_get` | 读取单条记忆完整正文（v0.7.25，按 id；memory_search / memory_list 命中后读全文） |
| `memory_update` | 修改已有记忆 |
| `memory_delete` | 删除记忆（按记忆 ID 精确删除） |
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
- **Fail-safe**：非法 LLM 输出（未知 id / 非法 action / 越界 importance / 跨类型合并等"单条非法"决策，Issue #26）默认跳过该条并应用合法子集（run 记为 `degraded`），绝不破坏记忆库
- **裁决审计**：每次运行写入 `dream_runs` 审计表（输入快照 sha256 digest + 完整输入快照 + 决策清单 + 逐 id 去向 + receipt），可离线回放；merge / conflict / update 幂等应用，重放/并发重复执行无累积副作用；update 记录 `_before` 快照

#### dreamMaxTokens 调优指南

默认 `32768` 已为思考型模型预留推理+正文的双重预算（部分思考型模型仅推理就可能消耗 8k+ token）。当**记忆量大**（数万字符以上）时按规模继续调大：

| 记忆库规模 | 建议 `dreamMaxTokens` |
|-----------|----------------------|
| 常规（<1 万字） | `32768`（默认） |
| 中等（1 万-5 万字） | `65536` |
| 大型（5 万字以上） | `131072`（上限） |

> 若使用**思考型模型**（如 deepseek-v4-flash / DeepSeek-R1 类），模型可能把全部预算花在 reasoning 上导致正文为空（日志出现 `no json array in llm output`）。处理顺序：① 把 `dreamReasoningEffort` 设为 `low` 显式压低思考（v0.7.26+ 若模型不支持该档位，`resolveDreamEffort` 会自动换用模型支持的默认/首个档位或省略字段，拒绝原因会记入 llm_audit）；② 重试走模型默认思考行为后正文仍为空的，调大 `dreamMaxTokens`（reasoning 与正文共享该预算）或配置 `dreamProvider`/`dreamModel` 指向非思考模型。sleep 侧对应 `sleepReasoningEffort`。

**巩固模型分类声明**（settings panel「巩固模型」= `dreamProvider`/`dreamModel`，睡眠侧对应 `sleepProvider`/`sleepModel`）：

| 模型类别 | 例子 | 说明 |
|---------|------|------|
| **非思考模型（推荐）** | glm-5-2 类等 | 无 reasoning 声明；即使配了 effort 被 harness 拒绝，fallback 去掉字段重试即成功。空体风险最低 |
| **思考模型（需实测）** | deepseek-v4-flash-ga 等 v4-flash-ga 系 | 默认开推理，可能烧光 token 预算返回空体；部分型号（如 v4-flash-ga）在 harness 侧被声明为**不接受任何 reasoning effort**（去掉 effort 时 harness 的 `defaultEffort` 会顶上来再次拒绝）。v0.7.26+ 已根治：`resolveDreamEffort` 发流前探测模型支持的档位，不支持的配置档位自动换用模型默认/首个支持档位，声明无 reasoning 能力的型号则省略字段。选用时建议配 `dreamReasoningEffort` 实测，不行就换非思考模型 |

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

> ⚠️ **历史存档提示**：下方及路线图表中 v0.7.12 之前的早期条目记录的实验功能（Wiki-Link、tag 系统/目录/tag 加权、user/fact 分层类型、前缀 id 解析、/stats 与 /directory 端点等）已在 **v0.7.11** 近重写时移除（v0.7.11 与 v0.7.12 同日发布，历史文档多标 v0.7.12，此处勘误归一到 v0.7.11），仅作版本历史存档，**不代表当前能力**。同期未记载的移除另有：会话生命周期（`session_disposed_at` 软隐藏）、provenance 出生会话溯源（`session_id`）、决策字段归一化（normalizeDecisions，已由提示词硬规范取代）。（heat 热度模型已于 v0.7.20 从 v0.7.10 完整找回回归，见下方 [v0.7.20](#recent-version-highlights)。）当前特性以本 README 正文与 [配置表](#-配置) 为准。

| 版本 | 亮点 |
|------|------|
| **v0.7.29** | 实体抽取路由契约修复 + 面板控件 + 帮助与反馈：`streamEntityText` 抽取为可测试导出的 `createEntityStreamAdapter`——显式 `provider`/`model` 优先、缺省兜底读默认路由选择；实体抽取思考强度 `entityExtractionReasoning` 被模型拒绝时自动去 effort 重试（与 autoDream/sleep 同一降级策略）；设置面板新增实体抽取 `provider`/`model`/思考强度三控件；面板底部新增「帮助与反馈」卡片（GitHub issue 预填 + mailto `work@modusensus.space` + 浏览已知问题）+ 配套 `GET /api/dsh-mneme/info`；744 测试全绿 |
| **v0.7.28** | 连通性测试三连修：`POST /api/dsh-mneme/test-model` 最小调用 `maxTokens` 16→1024——思考模型的推理过程足以耗尽 16 token 预算致 `reply` 恒为空（「真的答了 ok 而非只报通」对思考模型不成立；按实际用量计费，手动按钮无放大成本）；连通性测试状态按巩固/睡眠路由各持一份——此前共享单份，点任一「测试连通性」按钮两组同显「测试中/结果」且互相禁用；面板挂载草稿补 `sleepProvider`/`sleepModel`——后端一直保存正常，但重挂载（切页签/退出重进）后下拉恒显「跟随默认路由」，看起来像设置被重置，补键后正常回填（历史已存值无需重填）；733 测试全绿 |
| **v0.7.27** | v0.7.26 端点遗漏补齐：v0.7.26 发版树未含 `fix/dream-effort-trap` 分支，CHANGELOG/Release 宣告的 `GET /api/dsh-mneme/llm-providers` + `POST /api/dsh-mneme/test-model` 两个端点实际不在包内（面板「级联下拉 + 测试连通性」会 404）；本版将分支 rebase 后合入（PR #100），端点落地，面板连通性测试可用；733 测试全绿 |
| **v0.7.26** | 记忆巩固 `UNSUPPORTED_REASONING_EFFORT` 根治 + 巩固/睡眠模型连通性测试：根治 **defaultEffort 陷阱**——harness 在 effort 省略时注入 `reasoning.defaultEffort`，若该默认档位本身不被模型支持，则去 effort 重试也无济于事（换什么 effort 都会被拒绝）；修复：新增 `resolveDreamEffort` 经 `ctx.llm.resolveModelInfo()` 主动探测模型支持的档位再发送——配置档位不被支持时自动换用模型支持的默认/首个档位、模型声明无 reasoning 能力则省略字段；设置面板巩固/睡眠 6 字段补选型提示（引导非思考模型，避免再踩思考模型烧光 token 预算）；新增 `GET /api/dsh-mneme/llm-providers`（宿主侧 provider/model 发现，密钥不经插件侧）+ `POST /api/dsh-mneme/test-model`（模型连通性测试，空 body 按巩固路由解析返回 modelId）；732 测试全绿 |
| **v0.7.25** | 工具兼容性加固 + `memory_get`/render 内容预览 + 巩固模型引导：新增 `memory_get` 工具（第 8 个模型工具，按 id 读单条记忆全文）+ `memory_search`/`memory_list` render 嵌入标题/元数据/正文预览（宿主只透传 render 文本时模型也能直接读到记忆内容）+ 巩固模型选型引导（config 注释/README 分类声明，非思考 vs 思考模型差异）；修复 `memory_get` execute 嵌套进 output 的崩溃（`userExecute is not a function`，此前测试只数工具名从未执行该工具而掩盖）+ 工具重复注册去重（live patch reload）+ Standalone API 端口冲突重试（EADDRINUSE）+ client inject 声明对齐 + better-sidebar 集成加固；718 测试全绿 |
| **v0.7.24** | 修复 DSH Desktop 插件树加载崩溃（v0.7.23 回归）：cordis 4 的 ctx 是 Proxy，访问未在 inject 声明的 `webServer` 会抛 `cannot get property without inject`（而非返回 undefined），且去掉 inject 后 cordis 不再等待宿主服务 → 桌面端重启即崩；修复：恢复 webServer 到 inject（cordis 等宿主就绪再 apply）+ apply/register 守卫改 `ctx.reflect.get`（免 inject 读取、未提供返回 undefined 不抛错）；真实 cordis + dsh-host-webserver 插件实测；714 测试全绿 |
| **v0.7.23** | 记忆沉淀「反复失败」根治：consolidation 合法空数组 `[]` 不再误判 failed（CONSOLIDATION_PROMPT 允许「无问题无需输出」，模型无冗余时合法返回 `[]`——此前 `validateDecisions` 硬判 non-empty → 整单 failed、审计反复失败，且与模型无关，ChatGPT/Claude 同样踩中；修复：空数组显式短路 `ok:true` no-op）+ 空体修复第二段（`dreamMaxTokens` 默认 8192→32768，思考模型推理烧光预算的根治余量，设置面板可调）+ skipInvalid splice 残留 bug（长度相等≠内容一致，被跳决策残留）；712 测试全绿 |
| **v0.7.22** | 恢复 v0.6.9 的 skipInvalid 宽容校验路径（issue #89 回归，v0.7.11 重写丢失）：`dreamSkipInvalid`（默认 true）单条非法决策跳过 + 合法子集应用 + run 记 degraded，`allowCrossTypeMerge`（默认 false）显式放宽跨类型合并——弱模型（如 qwen3.8-flash）决策合规抖动不再整单拒绝白烧 LLM 调用；严格模式/sleep 路径行为不变，全局上限/覆盖率下限仍整单拒绝（刷爆上限=模型坏了，非轻微 schema 漂移）；新增 `dreamMinIntervalMinutes`（0-10080，默认 0=不限）autoDream 最小触发间隔，失败/degraded run 也占用间隔（节流防失败调用连发）；feature_flags 白名单 34 键；696 测试全绿 |
| **v0.7.21** | 修复 autoDream/sleep 的 effort 回退在流式路径失效（v0.7.16 的 catch 式回退是死代码）：dsh-llm rc.1 把 adapter 阶段异常（含 `UNSUPPORTED_REASONING_EFFORT`）转成终态 error finish chunk 不再抛出；`streamText` 现捕获 finish-chunk 失败原因（新增 `describeStreamFailure` 归一化 `{code,message}`）+ `withEffortFallback` 增加 `getStreamError` 访问器（effort 被拒时去掉重试一次）+ `runAuditedLlm` 支持 `spec.streamError`（audit 行 `error_message` 携带真实原因，`run.error` 稳定 `"llm failed"` 不变）；688 测试全绿 |
| **v0.7.20** | heat 热度模型回归（issue #87）：找回 v0.7.0 自进化记忆（`src/heat.js` 幂律衰减 `H=1/(1+λΔt)^α` + per-type 差异化半衰期）、sleep 降级热联合双保护（时间窗冷 + heat<0.05 + importance<5）、touchRecalled 门控改回 `heatEnabled`、实体热投影（ego 节点 heat → 前端大小/明暗）、recall_runs 默认记录；**默认关**（默认=与 v0.7.12 行为一致）+ feature_flags 白名单回滚开关 + lightMode 联动 + sleep 降级审计计数暴露（工作动态可展示"降级 N 条"）+ 阶段二前端（/list heat 投影、HeatBadge 三档徽章、状态页热度分布卡、order=heat 页内排序，全部自门控）；better-sidebar 修复（issue #88：软集成改内层动态子插件，无 bs 环境不再启动失败）；685 测试全绿 |
| **v0.7.18** | 生态第一步 + 查询收敛：better-sidebar 软集成（inject 声明 + optional peer `dsh-better-sidebar` + registerTab 复用四视图，未装安全跳过；窄容器 `@container` 适配）+ `/list?deposited=only` 沉淀视图（receipt_chain ∪ source=dream）+ 记忆库沉淀/已归档筛选 chip + 状态页仪表盘化（统计 + 查看全部跳转预置筛选）+ 抽屉归档记忆「恢复」；667 测试全绿 |
| **v0.7.17** | 面板体验细化：侧边栏入口持续对齐宿主（MutationObserver 同步「新会话」类名 + `width:100%` + 交还原生居中，皮肤异步改写不再失配）+ 重要性星级换 Lucide 星形（`ImportanceStars` 实心/空心组件，替换文本 ★）+ 工具栏下拉层级修复（z-index 提到容器，导出/导入菜单不再被吸顶月份头遮挡）；664 测试全绿 |
| **v0.7.16** | 修复 autoDream 在 thinking 模型上空体 failed（`no json array in llm output`）：恢复 config-first 路由（设置面板「巩固模型」生效，Issue #25）+ reasoningEffort 被拒自动去掉重试一次 + 解析失败如实记 llm_audit error 并带原始输出头日志；补测 API 路由空白（/delete、/entities、/external-api）+ lib 运行时冒烟（src↔lib 一致性）；662 测试全绿 |
| **v0.7.15** | 桌面端适配：记忆库面板重设计（撤对话 tab → 居中非全屏 sheet、卡片网格/时间线双视图、右侧详情抽屉、编辑/归档/关联实体）+ 侧边栏入口上移工作区上方（借用宿主原生类名对齐、收起态零位移）+ 功能开关 30 键上 UI（features API，巩固模型与 embedding 提供方可配）+ 状态页工作台（巩固卡/工作动态流/沉淀记忆/归档恢复）+ 导入导出（镜像同构 md 黄金闭环）+ Token 面板默认遮蔽；645 测试全绿 |
| **v0.7.14** | 安全修复（CWE-200）：蒸馏不再把助手 `reasoning` 私有推理块送进蒸馏上下文（只采公开 `text`，防止记忆沉淀私有思考链）；617 测试全绿 |
| **v0.7.13** | 编码记忆蒸馏（`codingRetrospect` 默认关）：完整转录（用户+助手回答+工具调用/结果+代码执行）提炼原子记忆，新增 `rejected_solution`/`pitfall`/`constraint` 三类型，编码任务 `codingBoostFactor` 加权（cap 5）+ 智能调速器（蒸馏全局串行队列 + 429 指数退避自动重试）+ 原子记忆语义保留（宁可拆多条不合并丢细节，`distillMaxChars` 默认 24000）+ 修复 v0.7.12 CI 回归（恢复 c8 覆盖率）；616 测试全绿 |
| **v0.7.12** | 独立外部 API（插件自带 HTTP 服务 `127.0.0.1:8790` Bearer 鉴权，生态集成）+ 零依赖 CLI `dsh-mneme`（status/list/search/get/add/delete/config）+ 轻量模式 lightMode（简化预设、面板一键切换）+ 设置面板新卡片（运行模式/外部访问 API）；612 测试全绿 |
| **v0.7.11** | 记忆库面板改版：按月分页+无限滚动（`limit=500` 静默丢失→100 条/页分页，total 常显）、搜索全局化（关键词/语义走服务端命中全库）、30s 静默刷新 + 状态子页（记忆/实体/向量索引/LLM 消耗四卡）+ 删除两步确认 + 重要性过滤芯片 + 内联 Lucide 图标；bundle 默认开启实体抽取；Issue #72 最大化窗口图谱节点裁剪修复（力导向全程 viewBox 用户单位）+ Issue #59 autoSummarize 从不执行修复（snapshotEvents 垫片）；双语 README；595 测试全绿 |
| **v0.7.10** | Web 面板体验升级：记忆类型色点体系（筛选/时间树/详情三处贯穿）+ 图谱画布平移/滚轮缩放/重置视图（补齐 `cursor: grab` 暗示却缺失的交互）+ 设置页 Claude 风格分区重排（编号规则行、悬停删除、口语化文案）+ 侧边栏入口同标签冲突修复（可见性过滤 + 渲染验证 + 多候选重试）+ 详情 meta 精排（来源截断、相对时间）+ 新增只读 `GET /api/dsh-mneme/entities` 实体清单端点（19→20 条路由）；815 测试全绿 |
| **v0.7.9** | issue #65 修复：v0.7.8 的 snapshotEvents 适配只改了 `src/`，npm 实际加载的 `lib/` 从未同步——静默失效；补齐 lib 三处垫片 + 新增 `scripts/check-sync.js` 发布前 src↔lib 一致性闸门（root prepack 调用，漂移直接 fail）+ `test/lib-smoke.test.js` 从 lib 导入复跑 + 一致性断言（CI 双保险）；815 测试全绿 |
| **v0.7.8** | DSH 0.1.2-rc.1 兼容（issues #58 #59）：官方移除 `Session.events` 属性改为 `snapshotEvents()` 方法，autoSummarize 与 hot-context（短期上下文）注入取不到事件而失效；改用兼容垫片 `session.snapshotEvents?.() ?? session.events`，新旧 DSH 通吃，老版本行为不受影响；新增 2 个回归用例；812 测试全绿 |
| **v0.7.7** | issue #23 实体图谱回填：sleep 批量实体抽取 phase（`sleepEntityExtractionEnabled` 默认关；最老优先、SQL LIMIT/OFFSET 分页下沉为有界查询不整表扫描；`pending_extracted_at` 幂等防重、成功/失败清除；metadata 合并不覆盖其他路径写入）；node:sqlite 兼容修复（pluck→all+map、`forgotten=0` 查询条件）；810 测试全绿 |
| **v0.7.6** | issue #48 修复：`memory_update`/`memory_delete`/`memory_forget`/`memory_archive` 支持截断/前缀短 id（新增 `service.resolveMemoryId`：精确命中优先 + 唯一前缀解析 + 多命中拒绝列出候选 + `memory_delete` 未命中幂等补 `logger.warn`；纯通配符/空白兜底）；Web bundle `client.js` 改 src 正源；801 测试全绿 |
| **v0.7.5** | 分层记忆类型：新增 `user`（用户画像）/`fact`（原子事实）轻量记忆类型（单表 `type` 扩展，不动 schema）+ Web 面板「总览」视图（记忆分层卡片 + 用户画像卡 + 类型分布 + 近 7 天趋势）+ `/api/dsh-mneme/stats` 统计端点；kimi-k2.7-code 复验（days 整数化等）；790 测试全绿 |
| **v0.7.4** | issue #40 修复：记忆内容含 `{{...}}` 模板语法时整轮崩溃（注入边界 run-based 花括号转义 `{{a}}`→`{\{a\}\}`，奇数连续如 `{{{a}}}` 也不残留字面 `{{`；新增 `escapePromptVariables` 配置默认开）；issue #41 修复：记忆窗口关闭按钮与宿主窗口控制按钮重叠无法点击（顶栏左对齐，关闭按钮离开右上角宿主控制区）；782 测试全绿 |
| **v0.7.3** | issue #38 新功能：左下角入口按钮可选开关 `showSidebarTrigger`（默认开）——与 dsh-cost-meter 等抢占 footer slot 的插件冲突时可在 Web 面板「设置」一键关闭，仅隐藏按钮、记忆库标签不受影响；776 测试全绿 |
| **v0.7.2** | issue #35 修复：目录页删除按钮改面板内联两步确认（不再依赖宿主 `window.confirm`）+ 删除失败可见报错；issue #34 新功能：opt-in `injectTimePrefix` 对话开始自动注入当前时间一次（默认关）；770 测试全绿 |
| **v0.7.1** | issue #31 修复：memory_save/memory_update 的 tags 桥接进 entity_attrs 标签存储（目录/`tag:` 检索/tagBoost 立即可见，`tags: []` 清空移回 untagged）+ `store.setMemoryTags` 反向同步 `memories.tags` 列 + autoTag 面板开关成为运行时消费方（settings 覆盖 config）；764 测试全绿 |
| **v0.7.0** | 自进化记忆（heat 热度模型 + per-type 差异化半衰期 + sleep 热联合双保护）+ updated_at 语义修正（不算访问）+ recall_runs injected 两档标记 + 90 天滚动清理 + 实体热投影（ego-graph node heat → 前端节点大小/明暗）；757 测试全绿 |
| **v0.6.11** | 社区修复（PR #27，Jstn-1g）：memory 渲染器暴露记忆 ID + 防御性加固（条数/块预算/Unicode 截断/JSONL 注入防护）；issue #14 已关闭；735 测试全绿 |
| **v0.6.10** | 记忆面板卡片布局品质优化：清理死 CSS + 合并 `.mneme-xmain` 双定义 + 补无障碍（分类按钮 `aria-pressed`、三卡 `role=region`+`aria-label`、搜索框 `aria-label`）；723 测试全绿 |
| **v0.6.9** | autoDream 恒失败修复（Issue #26 P0）：`dreamSkipInvalid` 跳过非法决策 + `allowCrossTypeMerge` 开关；723 测试全绿 |
| **v0.6.8** | dream/sleep LLM 路由修复（Issue #25）：config 指定模型优先于 agent 默认路由；716 测试全绿 |
| **v0.6.7** | 记忆面板前端增强：记忆删除端点 + autoTag 手动开关 + 目录 VS Code 式文件树 + 面板卡片式布局（分类栏 + search/tree/detail 三卡）；723 测试全绿 |
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
| **v0.7.0** | ✅ 完成 | 自进化记忆 | heat 幂律衰减 + per-type 差异化半衰期（TYPE_DECAY）+ sleep 热联合双保护 + updated_at 语义修正 + recall_runs injected 两档标记 + 90 天清理 + 实体热投影（前端节点大小/明暗）；757 测试全绿 |
| **v0.7.1** | ✅ 完成 | issue #31 修复 | memory_save/update tags 桥接 entity_attrs 标签存储 + 列反向同步 + autoTag 面板开关生效（settings 覆盖 config）；764 测试全绿 |
| **v0.7.2** | ✅ 完成 | issue #34 + #35 修复 | 目录页删除按钮改内联两步确认 + 删除失败可见报错；opt-in `injectTimePrefix` 对话开始注入当前时间一次（默认关）；770 测试全绿 |
| **v0.7.3** | ✅ 完成 | issue #38 新功能 | 左下角入口按钮可选开关 `showSidebarTrigger`（默认开，settings-over-config）；Web 面板设置一键关闭，与 dsh-cost-meter 等 footer 插件冲突可隐藏按钮、记忆库标签不受影响；776 测试全绿 |
| **v0.7.4** | ✅ 完成 | issue #40 + #41 修复 | 注入边界 run-based 花括号转义（`{{a}}`→`{\{a\}\}`、奇数连续如 `{{{a}}}` 不残留字面，`escapePromptVariables` 默认开）+ 记忆窗口顶栏左对齐、关闭按钮避开宿主窗口控制按钮区；782 测试全绿 |
| **v0.7.5** | ✅ 完成 | 分层记忆类型 + 总览视图 | 借鉴 meow-memory 分层概念、贴合单表架构：新增 `user`（用户画像）/`fact`（原子事实）类型，注入/镜像/梦境/质量过滤全链路打通；Web 面板「总览」视图（分层卡片 + 用户画像卡 + 类型分布 + 近 7 天趋势）；`/api/dsh-mneme/stats` 端点；kimi-k2.7-code 复验；790 测试全绿 |
| **v0.7.6** | ✅ 完成 | issue #48 修复 | 四工具统一 `service.resolveMemoryId`：截断/前缀短 id 也能精确操作（精确命中优先、唯一前缀解析、多命中拒绝并列出候选、`memory_delete` 未命中幂等返回 + `logger.warn` 留痕）；Web bundle `client.js` 改 src 正源；801 测试全绿 |
| **v0.7.7** | ✅ 完成 | issue #23 图谱回填 | sleep 批量实体抽取 phase：默认关 `sleepEntityExtractionEnabled`，按最老优先、SQL LIMIT/OFFSET 分页（下沉为有界查询，不再整表扫描）批量抽取未打标记忆的实体（修复 issue #23 实体图谱空白）；`pending_extracted_at` 幂等防重、成功/失败清除，metadata 合并不覆盖；node:sqlite 兼容修复（pluck→all+map、`forgotten=0` 查询条件）；810 测试全绿 |
| **v0.7.8** | ✅ 完成 | DSH 0.1.2-rc.1 兼容（issues #58 #59） | 官方移除 `Session.events` 属性、改用 `snapshotEvents()` 方法后 autoSummarize 与 hot-context 注入失效；改为兼容垫片 `session.snapshotEvents?.() ?? session.events`，新旧 DSH 通吃，老版本不受影响；新增 2 个回归用例；812 测试全绿 |
| **v0.7.9** | ✅ 完成 | issue #65 修复 | v0.7.8 的 snapshotEvents 适配未同步 lib/（npm 实际加载 lib/）导致发布产物静默失效；补齐 lib 三处垫片 + 发布前 src↔lib 一致性校验（`scripts/check-sync.js`，root prepack 调用，漂移 exit 1）+ `test/lib-smoke.test.js` 从 lib 导入复跑 + 一致性断言；815 测试全绿 |
| **v0.7.10** | ✅ 完成 | Web 面板体验升级 | 记忆类型色点体系 + 图谱画布平移/缩放（0.5x–3x 光标锚定）+ 设置页分区重排 + 侧边栏同标签冲突修复 + 详情 meta 精排 + 只读端点 `GET /api/dsh-mneme/entities`；815 测试全绿 |
| **v0.7.11** | ✅ 完成 | 记忆库面板改版 | 按月分页 + 无限滚动 + 搜索全局化 + 30s 静默刷新 + 状态子页四卡 + 删除两步确认 + 重要性过滤芯片 + 内联 Lucide 图标；bundle 默认开实体抽取；修复 issue#72 图谱节点裁剪 + issue#59 autoSummarize 垫片；595 测试全绿 |
| **v0.7.12** | ✅ 完成 | 近重写：纯 HTTP API + CLI | 内置面板 client.js 删除改纯 HTTP API（`127.0.0.1:8790` Bearer 鉴权，api.js/api-standalone.js）+ 独立 CLI `dsh-mneme`（bin/cli.mjs 零依赖）+ 轻量模式 lightMode + 设置面板新卡片；store TYPES 收窄 8→6（删 user/fact）、distill VALID →4、saveWithDedupe 改单参 |
| **v0.7.13** | ✅ 完成 | 编码记忆蒸馏 + 调速器 | `codingRetrospect`（默认关：完整转录提炼原子记忆，新增 rejected_solution/pitfall/constraint 三类型）+ 智能调速器（蒸馏全局串行队列 + 429 指数退避重试）+ 语义保留（distillMaxChars 默认 24000）；616 测试全绿 |
| **v0.7.14** | ✅ 完成 | 安全修复（CWE-200） | 蒸馏不再采集私有推理块：`collectMessages` 只采公开 text，防止记忆库沉淀模型私有思考链；617 测试全绿 |
| **v0.7.15** | ✅ 完成 | 桌面端适配 | 记忆库面板重设计 + 功能开关 30 键 UI（features API）+ 状态页工作台 + 导入导出（镜像同构 md 黄金闭环）+ Token 面板默认遮蔽；645 测试全绿 |
| **v0.7.16** | ✅ 完成 | autoDream thinking 模型空体修复 + 补测 | 恢复 config-first 路由（设置面板「巩固模型」生效，Issue #25）+ reasoningEffort 被拒自动去掉重试 + 解析失败如实记 llm_audit error；补测 API 路由空白（/delete、/entities、/external-api）+ lib 运行时冒烟；662 测试全绿 |
| **v0.7.17** | ✅ 完成 | 面板体验细化 | 侧边栏入口持续对齐宿主（MutationObserver 同步「新会话」类名 + `width:100%` + 交还原生居中，皮肤异步改写不再失配）+ 重要性星级换 Lucide 星形（`ImportanceStars` 实心/空心组件，替换文本 ★）+ 工具栏下拉层级修复（z-index 提到容器，导出/导入菜单不再被吸顶月份头遮挡）；664 测试全绿 |
| **v0.7.18** | ✅ 完成 | 生态第一步 + 查询收敛 | better-sidebar 软集成（inject 声明 + optional peer `dsh-better-sidebar` + registerTab 复用四视图，未装安全跳过；窄容器 `@container` 适配）+ `/list?deposited=only` 沉淀视图（receipt_chain ∪ source=dream）+ 记忆库沉淀/已归档筛选 chip + 状态页仪表盘化（统计 + 查看全部跳转预置筛选）+ 抽屉归档记忆「恢复」；667 测试全绿 |
| **v0.7.20** | ✅ 完成 | heat 回归 + 阶段二前端 + better-sidebar 修复 | heat 热度模型完整找回（issue #87，v0.7.10 移植：幂律衰减 + TYPE_DECAY + sleep 热联合双保护 + 实体热投影）+ 验收清单落地（heatEnabled 默认关 / feature_flags 31 键 / lightMode 联动 / sleep 降级审计暴露 / updated_at⊥last_accessed_at 契约）+ 阶段二前端（/list heat 投影、HeatBadge 三档、order=heat 页内排序）+ better-sidebar 修复（issue #88：内层动态子插件）；685 测试全绿 |
| **v0.7.21** | ✅ 完成 | effort 回退流式修复 | autoDream/sleep 的 catch 式 effort 回退在流式路径是死代码（dsh-llm rc.1 把 adapter 异常转成终态 error finish chunk 不再抛出）→ `streamText` 捕获 finish-chunk 失败原因（`describeStreamFailure` 归一化）+ `withEffortFallback` 增加 `getStreamError` 访问器（effort 被拒去重试）+ `runAuditedLlm` 支持 `spec.streamError`（audit 记真实原因）；688 测试全绿 |
| **v0.7.22** | ✅ 完成 | skipInvalid 宽容校验回归（issue #89）+ autoDream 节流 | 恢复 v0.6.9 的 skipInvalid 双轨结构（v0.7.11 重写丢失）：`dreamSkipInvalid` 单条非法决策跳过 + 合法子集应用 + run 记 degraded，`allowCrossTypeMerge` 显式放宽跨类型合并；弱模型（qwen3.8-flash）决策合规抖动不再整单拒绝；新增 `dreamMinIntervalMinutes`（0-10080，默认 0=不限）最小触发间隔，失败/degraded run 也占用间隔；严格模式/sleep 路径行为不变；feature_flags 白名单 34 键；696 测试全绿 |
| **v0.7.23** | ✅ 完成 | 记忆沉淀「反复失败」根治 + 空体第二段 + skipInvalid splice 修复 | consolidation 合法空数组 `[]` no-op（CONSOLIDATION_PROMPT 允许无问题无需输出；此前 validateDecisions 硬判 non-empty → 整单 failed，模型无关、ChatGPT/Claude 同样踩中；修复：空数组显式短路 ok，不再触发隐式 keep 覆盖率误判）；`dreamMaxTokens` 默认 8192→32768（思考模型推理烧光预算根治余量）；skipInvalid splice 残留 bug（长度相等≠内容一致，被跳决策残留进 apply）；712 测试全绿 |
| **v0.7.24** | ✅ 完成 | 桌面端崩溃紧急修复 | v0.7.23 把 webServer 移出 inject 致 cordis Proxy 抛 `cannot get property "webServer" without inject`（未注入属性直接访问抛错而非 undefined），桌面端重启插件树加载失败；修复：恢复 webServer 到 inject（cordis 等宿主就绪再 apply）+ apply/register 守卫改 `ctx.reflect.get`（免 inject 读取、未提供返回 undefined 不抛错，未来 headless 移出 inject 也安全）；真实 cordis + dsh-host-webserver 实测 API 路由 200 / 未知路径 404 / headless 静默不激活；714 测试全绿 |
| **v0.7.25** | ✅ 完成 | 工具兼容性加固 + 内容预览 + 巩固模型引导 | 新增 `memory_get` 工具（第 8 个模型工具，按 id 读单条记忆全文）+ `memory_search`/`memory_list` render 嵌入标题/元数据/正文预览（宿主只透传 render 文本时模型也能读到内容）+ 巩固模型选型引导（config 注释/README 分类声明）；修复 memory_get execute 嵌套 output 的崩溃（userExecute is not a function）+ 工具重复注册去重（live patch reload）+ Standalone API 端口冲突重试 + client inject 声明对齐 + better-sidebar 集成加固；718 测试全绿 |
| **v0.7.26** | ✅ 完成 | 巩固 effort 陷阱根治 + LLM 连通性测试 | 记忆巩固 `UNSUPPORTED_REASONING_EFFORT` 根治（defaultEffort 陷阱：harness 省略 effort 时注入 `reasoning.defaultEffort`，默认档位不被模型支持则任何重试无效）→ 新增 `resolveDreamEffort` 经 `ctx.llm.resolveModelInfo()` 探测模型支持的档位（不支持的配置档位自动换用模型支持的默认/首个档位，无 reasoning 能力则省略字段）；设置面板巩固/睡眠 6 字段补选型提示（引导非思考模型）；新增 `GET /api/dsh-mneme/llm-providers`（宿主侧 provider/model 发现）+ `POST /api/dsh-mneme/test-model`（模型连通性测试，空 body 按巩固路由解析，密钥不经插件侧）；732 测试全绿 |
| **v0.7.27** | ✅ 完成 | v0.7.26 端点遗漏补齐 | v0.7.26 发版树未含 `fix/dream-effort-trap` 分支：CHANGELOG/Release 宣告的 `GET /api/dsh-mneme/llm-providers` + `POST /api/dsh-mneme/test-model` 两个端点实际不在包内（面板「级联下拉 + 测试连通性」会 404）；本版将分支 rebase 合入（PR #100），端点落地、面板连通性测试可用；733 测试全绿 |
| **v0.7.28** | ✅ 完成 | 连通性测试三连修 | `POST /api/dsh-mneme/test-model` 最小调用 `maxTokens` 16→1024（思考模型推理过程即可耗尽 16 token 预算，`reply` 恒空）；连通性测试状态按巩固/睡眠路由各持一份（按钮不再串扰）；面板挂载草稿补 `sleepProvider`/`sleepModel`（重挂载后睡眠路由不再显示回「跟随默认路由」，值一直有存）；733 测试全绿 |
| **v0.7.29** | ✅ 完成 | 实体抽取路由契约修复 + 面板控件 + 反馈入口 | 实体抽取 LLM 路由契约修复（#108/#109）：`createEntityStreamAdapter` 显式 provider/model 优先 + 兜底默认路由 + effort 拒绝自动去重试；设置面板新增实体抽取 provider/model/思考强度三控件；「帮助与反馈」卡片（GitHub issue 预填 + mailto + 浏览已知问题）+ `GET /api/dsh-mneme/info`；744 测试全绿 |
| **v0.8.0** | 🚧 计划中（9 月末） | 图谱增强 | 兴趣漂移可视化 + scope 隔离（issue #17）+ 跨 workspace 记忆共享 |

> 新能力一律做成**可开关的功能**（配置启用/关闭），默认保守开启、不破坏现有行为。`failure_memories` 表与 autoDream 决策引擎已为后续反思性成长铺好路。

## 📦 安装

### 前置条件

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）— 兼容 DSH 0.1.x，已验证 0.1.2-rc.1（`Session.events` → `snapshotEvents()` 变更已由插件垫片兼容，新旧版本通吃；v0.7.9 确保该垫片真正进入发布产物 lib/）
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
| `dreamMaxTokens` | `32768` | dream LLM 调用最大 token 数（上限 131072；思考型模型的 reasoning 与正文共享该预算，正文为空时优先调大，见下方调优指南） |
| `dreamReasoningEffort` | `none` | dream LLM 推理强度透传：`low` / `medium` / `high` / `none`（`none`=不传该字段，沿用模型默认；思考型模型（如 deepseek-v4-flash）想压低思考可设 `low`；v0.7.26+ 模型不支持配置档位时自动换用其支持的默认/首个档位，无 reasoning 能力的型号省略字段） |
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
| `heatEnabled` | `false` | 热度模型总开关（v0.7.0 / v0.7.20 回归，**默认关**——v0.7.12 起用户已习惯无 heat 行为）：开启后提供热度字段 / sleep 热联合降级保护 / 前端热度投影，不改变召回排序；关闭则跳过 heat 计算与热度触达，sleep 降级退回纯时间分层。也走 feature_flags 白名单（面板可启停=回滚开关），lightMode 预设强制关 |
| `heatGlobalAlpha` | `1.2` | 幂律形状参数 α（`H=1/(1+λΔt)^α`），越大衰减越快 |
| `heatTypeDecay` | 内置 TYPE_DECAY | per-type 衰减因子 λ；λ=0 的类型免疫（preference/pattern/summary 热度恒 1.0，sleep 永不降级） |
| `sleepHeatThreshold` | `0.05` | sleep 降级联合判定热度下限：heat<该值 **且** importance<5 才允许降级 |
| `recallRecordDefault` | `true` | recall_runs 记录默认开（显式传 `recordRecall:false` 的调用方不受影响） |
| `recallRetentionDays` | `90` | recall_runs 滚动清理保留天数 |
| `hotMemoryRounds` | `5` | 会话级短期热记忆轮次（v0.5.0）：最近 N 轮对话滚动注入，从会话事件日志无状态重建、不落库 |
| `hotMemoryMaxTokens` | `2000` | 热记忆 token 预算（v0.5.0，200-32000），超出滚动截断 |
| `selectiveInjectEnabled` | `true` | 选择性注入（v0.5.0）：query 向量可用时注入候选按主题相似度重排，替代固定规则序 |
| `searchSemanticDedup` | `false` | 搜索时语义去重（v0.5.0，激进选项默认关）：embedding 余弦 ≥0.95 近重复行在 Rerank 前丢弃 |
| `searchSemanticDedupThreshold` | `0.95` | 语义去重相似度阈值（v0.5.0，默认 0.95，范围 0.5-1.0）：`searchSemanticDedup=true` 时生效，调整可防小模型误折叠 |
| `memoryQualityFilter` | `{enabled:true, archiveThreshold:30, degradeThreshold:60, minContentLength:10}` | 记忆质量过滤（v0.4.6，默认开）：写库前启发式打分 0-100，元记忆词汇/自指/过短/重复/近似重复扣分；≥60 正常存储，30-60 降权（注入排序按 importance×quality/100），<30 归档标记 `low_quality`（显式搜索仍可召回，永不自动注入） |
| `llmAudit` | `{enabled:true, retentionDays:90}` | LLM 消耗审计（v0.4.6，默认开）：每次后台 LLM 调用（autoDream/autoSummarize）写 `llm_audit_logs`（tokens/duration/status/source）；失败记 error 不阻塞；只读 API `/api/dsh-mneme/semantic/llm-audit` + `/llm-audit/stats` |

> 🔐 **API 安全**：DSH 无内置鉴权且默认仅监听 `127.0.0.1`。插件 API 默认开放（便于 Web 面板即装即用）。如需防护（如局域网暴露），在配置中设置 `apiToken`：写操作（画像/规则/命令）与密钥端点（`vector-config`、`vector-reindex`）需携带 `Authorization: Bearer <token>`（前端设置面板可填入同一 token），只读的 `list` / `search` / `semantic` 保持开放。`/api/dsh-mneme/vector-config` 返回的 `apiKey` 已掩码（`sk-***…`），存储仍保留明文供调用；前端回传空或掩码值表示"不改 key"。


## 外部 API 与 CLI

除 DSH 内部端口外，插件还可以开启一个**独立的 HTTP 外部 API**（默认 `http://127.0.0.1:8790`，Bearer token 鉴权），供其他插件、CLI 脚本或桌面工具读写记忆，不依赖 DSH 内部端口。

### 启用与鉴权

- 在插件设置中开启外部 API（默认监听 `127.0.0.1:8790`，仅本机可访问）；
- 访问 token 在插件设置 / 面板「设置 → 外部访问」中查看；
- 除 `GET /health`（免鉴权）外，所有路由需携带 `Authorization: Bearer <token>`，无效 token 返回 `401 {"error":"unauthorized"}`。

主要路由：

| 方法 | 路由 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查（免鉴权），返回 `{ok:true}` |
| `GET` | `/status` | 版本、记忆统计、实体数、运行时长 |
| `GET` | `/memories?limit&offset&type&minImportance&source&order=chrono` | 分页列出记忆 |
| `GET` | `/memories/:id` | 单条记忆 |
| `POST` | `/memories` | 新增记忆 `{type,title,content,importance?,tags?,source?}` |
| `DELETE` | `/memories/:id` | 删除记忆 |
| `GET` | `/search?q&mode=keyword\|vector\|auto&topK` | 搜索（关键词 / 向量 / 自动） |

### curl 示例

```bash
# 服务状态
curl -s -H "Authorization: Bearer $DSH_MNEME_TOKEN" http://127.0.0.1:8790/status

# 列出最近 5 条记忆
curl -s -H "Authorization: Bearer $DSH_MNEME_TOKEN" \
  "http://127.0.0.1:8790/memories?limit=5"

# 新增一条决策记忆
curl -s -X POST http://127.0.0.1:8790/memories \
  -H "Authorization: Bearer $DSH_MNEME_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"decision","title":"采用 SQLite","content":"存储层使用 node:sqlite","importance":4,"tags":["存储"]}'
```

### CLI 安装

插件自带零依赖 CLI（随 npm 包一起发布）：

```bash
npm i -g @modusensus/dsh-mneme
dsh-mneme --help
```

首次使用先配置服务地址与 token（也可用环境变量 `DSH_MNEME_URL` / `DSH_MNEME_TOKEN`，或 `--url` / `--token` 参数临时覆盖）：

```bash
dsh-mneme config set http://127.0.0.1:8790 <你的token>
```

### CLI 常用命令

```bash
dsh-mneme status                                     # 服务状态
dsh-mneme list --type project --limit 10             # 列出记忆
dsh-mneme search "部署流程" --mode vector --topk 5    # 语义搜索
dsh-mneme add --type decision --title "采用 SQLite" \
  --content "存储层使用 node:sqlite" --importance 4 --tags 存储,决策
dsh-mneme get 42                                     # 查看单条
dsh-mneme delete 42                                  # 删除
dsh-mneme config show                                # 查看当前配置（token 打码）
```

> 所有读取/写入命令支持 `--json` 输出原始 JSON；`config path` 打印配置文件路径（`~/.dsh-mneme/cli.json`）。

## 🏗️ 架构

```
┌─────────────────────────────────────────────────┐
│  存储层：SQLite (archived/forgotten 状态)         │
│         + Markdown 镜像（人工可编辑，双向同步）    │
├─────────────────────────────────────────────────┤
│  服务层：saveWithDedupe / injectCandidates        │
│         / mergeHumanEdits / onWrite 钩子          │
├─────────────────────────────────────────────────┤
│  模型接口：8 个工具 + 自动注入 + 会话摘要          │
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
├── tools.js          # 8 个模型工具（defineTool）
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
lib/                  # src 的同步分发产物（npm run sync；发布前由 root prepack 的 check-sync.js 校验一致性；唯一手写例外 lib/client.js——Web 面板 bundle，sync 不覆盖）
test/                 # 714 个 node:test 测试（审计与三轴线压测不变量；src↔lib 一致性由 scripts/check-sync.js 发布闸门校验）
scripts/              # e2e-dsh.js 端到端演示 · stress-dsh.js 三轴线压测 · sync-lib.js 同步 · check-sync.js 发布闸门 · benchmark-recall.js 召回基准
```

## 🧪 开发

```bash
cd dsh-mneme
npm install        # 安装 peer 依赖（以 devDependencies 形式，用于本地测试）
npm test           # 运行 714 个测试
npm run stress     # 三轴线压测：长会话检索 / 冲突仲裁 / 多 Agent 并发（离线 mock LLM）
npm run sync       # 把 src/ 同步到 lib/（发布时由 prepack 钩子自动执行）
```

> 压测（`npm run stress`）三条轴线：**长会话检索**（Recall@k、陈旧残留率）、**冲突裁决**（可重放仲裁集：审计快照 hash + receipt + 幂等回放）、**多 Agent 并发**（丢更新、重复合并、事务/崩溃恢复）。每次 autoDream 运行都会写入审计表 `dream_runs`（输入快照 digest + 决策清单 + 逐 id 去向 + receipt），让高通过率下也能定位静默错误。

> `lib/` 是 `src/` 的同步分发产物（`npm run sync`）：除 **`lib/client.js`**（Web 面板 bundle）为 lib 独有的手写文件、sync 与 check-sync 均不触碰外，其余全部由 src 复制而来。改 src 必 `npm run sync` 并提交 lib，否则发布产物静默失效（issue #65 教训）。

## 📄 设计文档

> 设计文档位于仓库根 `docs/`，链接以 `../docs/` 相对路径指向（GitHub 上从本目录打开可正常跳转）。

- [实体结构化记忆设计](docs/ENTITIES.md)
- [语义增强架构](docs/SEMANTIC.md)
- [本地模型部署指南](docs/LOCAL_MODEL.md)
- [从 v0.1 升级说明](docs/MIGRATION.md)

## 📜 License

MIT
