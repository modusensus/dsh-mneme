<p align="center"><strong>中文 | <a href="docs/SEMANTIC.md">English（语义增强）</a></strong></p>

# dsh-mneme

[![npm version](https://img.shields.io/npm/v/@modusensus/dsh-mneme?color=blue&label=npm)](https://www.npmjs.com/package/@modusensus/dsh-mneme)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Awesome](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![tests](https://img.shields.io/badge/tests-450%20passed-success)](https://github.com/modusensus/dsh-mneme)

> 给 DeepSeek Harness 的跨会话记忆插件：让 Agent 记住你、记住项目、自动整理记忆。**Mneme**（Μνήμη）——希腊记忆女神 Mnemosyne 之名，掌管记忆与梦境，正如 autoDream 在后台巩固记忆。

`dsh-mneme` 是一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件，为 Agent 提供持久的跨会话记忆能力。它借鉴了 Claude 的 **Dream 机制** 与 cc-haha / Claude Code 的 **autoDream** 实现思路——不仅**存储**记忆，还会**自动巩固**（去重、合并、冲突裁决、摘要生成），让记忆库越用越精炼。

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
| `memory_delete` | 删除记忆 |
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

### Web 记忆面板

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

## 🆕 最近版本亮点

| 版本 | 亮点 |
|------|------|
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
| **v0.5.0+** | 🚀 远期 | 自进化记忆 | 兴趣漂移跟踪 + 跨 workspace 记忆共享（等 DSH 支持） |

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
| `dreamProvider` / `dreamModel` | 空 | dream 的 LLM 路由回退（默认用 agent 默认模型） |
| `dreamMaxTokens` | `4096` | dream LLM 调用最大 token 数 |
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
├── embedding.js      # OpenAI 兼容 embeddings 客户端 + 向量检索
├── api.js            # HTTP 路由（Web 面板数据通道）
└── index.js          # 插件接线
lib/
├── client.js         # Web 面板（手写 ModuleLoader bundle）
└── *.js              # src 的同步分发产物
test/                 # 450 个 node:test 测试（含审计与三轴线压测不变量）
scripts/              # e2e-dsh.js 端到端演示 · stress-dsh.js 三轴线压测 · sync-lib.js 同步
```

## 🧪 开发

```bash
cd dsh-mneme
npm install        # 安装 peer 依赖（以 devDependencies 形式，用于本地测试）
npm test           # 运行 450 个测试
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
