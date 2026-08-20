<p align="center">
  <img src="横幅.png" alt="dsh-mneme banner" width="100%" />
</p>

<h1 align="center">dsh-mneme</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@modusensus/dsh-mneme"><img src="https://img.shields.io/npm/v/@modusensus/dsh-mneme?color=blue&label=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="license"></a>
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="Awesome"></a>
  <a href="https://github.com/modusensus/dsh-mneme/actions"><img src="https://img.shields.io/github/actions/workflow/status/modusensus/dsh-mneme/test.yml" alt="CI"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-24%2B-blue" alt="node"></a>
  <a href="https://github.com/modusensus/dsh-mneme"><img src="https://img.shields.io/badge/tests-628%20passed-success" alt="tests"></a>
</p>

<p align="center"><strong><a href="#中文">中文</a> | <a href="#english">English</a></strong></p>

---

<a name="中文"></a>

# 🇨🇳 dsh-mneme（中文）

> **记忆基因 · 让记忆自我进化** —— 从文本仓库到结构化知识库，记忆不再只是存储，而是会生长。

`dsh-mneme` 是一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件，为 Agent 提供持久的跨会话记忆能力。**Mneme**（Μνήμη）——希腊记忆女神 Mnemosyne 之名，掌管记忆与梦境，正如 autoDream 在后台巩固记忆。

记忆不该是「存了就算」的黑盒。Mneme 让记忆**可读、可结构、可演化**：

- **可读**：SQLite + 人类可编辑的 Markdown 镜像，双向同步，记忆主权始终在你手里
- **可结构**：实体 / 属性 / 时间轴三表，把文本片段提炼为结构化知识（v0.3.0 记忆基因）
- **可演化**：autoDream 后台巩固 + 反思更新 + 冲突冻结，记忆越用越精炼，朝自进化演进

## ⏱️ 30 秒理解

**一句话**：dsh-mneme 给 Agent 装上跨会话记忆——记住你、记住项目，并在后台自动整理，越用越懂你。

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

---

## 🧬 记忆基因（Structured Memory，v0.3.0）

**从文本片段，到结构化知识库。**

v0.2.x 时代，记忆是文本片段：「用户喜欢 Python」和「用户喜欢 Rust」是两条独立记忆，系统不知道它们是同一实体（用户）同一属性（编程语言）的不同版本。v0.3.0 用三张表把记忆结构化——像 DNA 由基因 + 碱基对 + 序列组成：

```
memories（现有，不变）
    │  （写入后触发抽取）
    ▼
entities ──→ entity_attrs ──→ entity_relations
（基因）      （碱基对）         （序列关系）
```

| 表 | 角色 | 关键设计 |
|----|------|---------|
| `entities` | 基因 | 人 / 项目 / 技术 / 概念 / 组织，`mention_count` 跟踪活跃度 |
| `entity_attrs` | 碱基对 | `valid_until` 快照时间轴，属性变更**不覆盖历史**，全程可追溯 |
| `entity_relations` | 序列关系 | `supersedes` / `part_of` / `depends_on` / `uses` / `related_to` |

### 时间轴：记忆的进化历史

`valid_until` 机制是记忆基因的心脏——每个属性值都是一个**带时间戳的版本**：

- 新属性写入 → 旧行标 `valid_until`（不删除，保留历史）
- 查询当前有效值 → `valid_until IS NULL`
- 查询变更历史 → 按 `valid_from` 排序全部行

「用户喜欢 Python」→「用户喜欢 Rust」，不再覆盖，而是**自动建立 supersedes 链**，保留完整进化轨迹。

### LLM 实体抽取（opt-in）

新记忆写入后，异步、非阻塞地调用 LLM 抽取实体/属性/关系：

- **JSON 契约**：`{ entities: [{name, type, attrs}], relations: [{from, to, type}] }`
- **resolveEntity 去重**：同名实体复用，`mention_count` +1
- **Fail-safe**：抽取失败降级为纯文本存储，绝不阻塞记忆写入
- **开关隔离**：`entityExtractionEnabled` 默认 `false`，关闭时 v0.2.x 行为完全一致

### 结构化搜索

| 前缀 | 含义 | 示例 |
|------|------|------|
| `entity:React` | 按实体精确召回 | 所有关联 React 的记忆 |
| `attr:programming_language=Rust` | 按属性过滤 | 编程语言为 Rust 的记忆 |
| `attr:deadline` | 按属性名过滤 | 所有有 deadline 属性的记忆 |

`entity:` 搜索按**精确关联优先**排序：entity_attrs 精确命中（score=1.0）> 关键词提及（score=0.7）。

---

## 🧠 autoDream 自我巩固

后台自动整理的「梦境引擎」，让记忆库越用越精炼：

- **决策清单式整理**：LLM 输出 `keep` / `merge` / `archive` / `conflict` / `update` 决策，服务端校验后逐条应用（fail-safe）
- **反思更新（v0.2.1）**：直接修正过时/错误记忆，`failure_memories` 记录纠正历史
- **冲突冻结（v0.2.9）**：冲突可配置为「冻结待人工确认」，不自动裁决
- **实体感知（v0.3.0）**：update 自动写 `supersedes` 关系；merge 迁移 loser 的实体属性到 keeper
- **CAS 防护 + 事务化**：并发安全，多步原子

## 💤 Sleep Mode 系统级睡眠（v0.4.0，opt-in）

autoDream 是"被动阈值触发"，Sleep Mode 升级为"主动定时维护 + 分层压缩"。系统空闲 `sleepIdleMinutes` 分钟自动执行**四阶段深度维护**（默认关闭）：

1. **冲突消解**：全库矛盾检测，strictness 三级可配（gentle 0.92 / normal 0.85 / aggressive 0.75）
2. **归档降级**：按 `last_accessed_at` 分层——30 天未召回压成摘要（原文进 `_full_content` 可无损恢复）、90 天完全归档
3. **模式发现**：LLM 扫描近期记忆提炼规律，产出 `type=pattern` 记忆，evidence 强校验防伪造
4. **关系补全**：检测孤立实体并补全隐含关系（共现 `related_to` / 项目 `part_of` / 技术 `depends_on`）

可中断（用户活动即中止）、串行安全（与 autoDream 共享 enqueue 队列不重叠）、fail-safe（单阶段失败不阻塞其余）、审计延续（`dream_runs` 以 `run_type='sleep'` 区分）。

## 🕸️ 记忆图谱与三路召回（v0.5.0）

**让记忆看得见、找得回。**

- **主区「记忆库」视图**：记忆功能收进主内容区全宽 tab（与「对话 / Trajectory」并列），取代侧边栏抽屉——「记忆」三栏浏览（分类树 / 时间树 / 全文详情）、「图谱」、「设置」三个子视图，观感与宿主原生视图一致。
- **记忆图谱可视化**：输入实体名，加载以其为中心的关联网络——服务端 ego-graph API（BFS 1-2 跳，只读），前端零依赖手写 SVG 力导向布局（插件运行时无法 require 第三方图库），节点可拖拽、点边可跳回来源记忆，图谱 ↔ 记忆双向互跳。
- **三路召回融合**：在向量召回 + FTS5/LIKE 关键词之外新增 **BM25 稀疏召回**（ASCII 词元 + CJK bigram，IDF 加权）——专有名词、ID、代码片段等散词查询不再依赖子串命中；配合**自适应阈值**（按查询形态动态调整截断），召回率可用内置基准（Recall@5 / MRR，legacy vs fused 双跑）重复验证。
- **会话级短期热记忆**：最近 N 轮对话（默认 5 轮 / 2000 token 预算）滚动截断，注入顺序为「短期上下文 → 长期记忆召回 → 摘要」，不落库、无状态重建。

## 💾 会话生命周期（v0.6.0，opt-in）

**把对话当存档点——删会话 ≠ 删记忆。**

- **默认关闭**（`sessionLifecycleEnabled: false`，保持旧行为）。开启后，会话被删除/销毁（DSH `session/disposed` 事件）时，自动把该会话内出生（`session_id` 溯源）的记忆**软隐藏**——不再出现在检索/注入/列表/整理，但**不删除**，随时可恢复
- **与 `archived` 正交**：`archived` 是用户/AI 主动"长期保留但安静"，`session_disposed_at` 是会话删除被动隔离，两者互不覆盖。恢复会话绝不复活手动归档的记忆
- **全局记忆免疫**：存量无 `session_id` 的记忆视为全局，永不参与会话清理
- **幂等 + 熔断**：dispose/restore 状态守卫幂等（重复调用 no-op）；事件回调内部异常 catch 住，不抛进 DSH 会话清理流程
- **恢复**：`service.restoreBySession(sessionId)` 一键还原；`listBySession(sessionId, { includeDisposed: true })` 查看当前隐藏了什么（DTO 带 `disposed` 标记）

## 🏛️ 记忆主权

记忆透明、可审查、归你所有：

- **Markdown 镜像**：`preferences.md` / `projects.md` / `decisions.md` / `history.md` / `summary.md`，人类可读、可手工编辑
- **人工编辑优先**：`last-rendered digest` 基线 + 三方合并，并发人工编辑不丢失
- **双向同步**：人工修改合并回库，机器写入重渲染镜像

## 🔮 离线语义搜索（v0.2）

完全离线的语义记忆引擎，零 API 成本：

- **本地 Embedding**：ONNX（`bge-small-zh`，离线）/ Ollama / OpenAI 兼容三后端，自动降级
- **Rerank 精排**：`bge-reranker-base` 交叉编码精排，Top-K 更准
- **混合搜索**：向量 + 关键词加权融合
- **autoDream 语义增强**：向量聚类发现主题相近 / 疑似矛盾记忆

## 🔐 审计与信任

每个决策都可离线回放，每个声明都有证据：

- **dream_runs 审计**：输入快照 digest + 决策清单 + outcome + receipt，可重放
- **receipt_chain 收据链**：逐记录收据，重放必须复现同一结果
- **recall_runs 召回层**：检索场景可审计
- **policy_epoch 规则版本**：规则升级后旧裁决降级为历史证据
- **安全审计 peer 复验**：真实 npm 包隔离独立回归，7 项发布门槛 + F-03 诚实审计
- **LLM 消耗审计（v0.4.6）**：autoDream / autoSummarize 每次后台 LLM 调用写入 `llm_audit_logs`（tokens / duration / status / source），只读 API 汇总近 N 天预算
- **记忆质量过滤（v0.4.6）**：`memoryQualityFilter` 写库前启发式打分，低质记忆降权或归档（`low_quality` 仍可显式搜索，永不自动注入）
- **628 个测试 + 三轴压测**全绿

## ⚙️ 配置（节选）

| 分组 | 键 | 默认 | 说明 |
|------|-----|------|------|
| 实体 | `entityExtractionEnabled` | `false` | 记忆基因总开关 |
| 实体 | `entityExtractionModel` | `""` | 抽取模型（空则复用 dream 路由）|
| 实体 | `entityExtractionMaxEntities` | `10` | 单次抽取最大实体数 |
| 实体 | `entitySearchEnabled` | `true` | entity:/attr: 前缀搜索 |
| 反思 | `reflectionUpdateEnabled` | `true` | update 决策开关 |
| 反思 | `conflictFreezeEnabled` | `false` | 冲突冻结开关 |
| 向量 | `embedProvider` | `openai` | 语义后端（local=离线）|
| 向量 | `rerankEnabled` | `false` | Rerank 精排开关 |
| 可信度 | `trustEpistemicWeighting` | `false` | 记忆可信度加权（observation>inferred>subjective，影响检索/注入/dream 合并冲突；opt-in 默认关）|
| 评估 | `evalPersistTestResults` | `false` | 检索评估 `evaluateRetrieval` 结果落库 `recall_evals`（opt-in 默认关，生产检索不受影响）|
| 向量 | `autoReindexOnBoot` | `true` | 存量记忆缺 embedding 时启动后台自动回填重建 |
| 注入 | `hybridInject` | `true` | 注入语义召回优先（非空 query 先走向量，规则补充去重）|
| 召回 | `bm25SearchEnabled` | `true` | BM25 稀疏第三路召回（散词/ID/代码片段查询增强，v0.5.0）|
| 召回 | `adaptiveThresholdEnabled` | `true` | 自适应相似度阈值（按查询形态动态截断，v0.5.0）|
| 热记忆 | `hotMemoryEnabled` | `true` | 会话级短期热记忆总开关（v0.5.0）|
| 热记忆 | `hotMemoryRounds` / `hotMemoryMaxTokens` | `5` / `2000` | 会话级短期热记忆轮次与 token 预算（v0.5.0）|
| 注入 | `selectiveInjectEnabled` | `true` | 选择性注入：候选按与当前 query 的主题相似度重排（v0.5.0）|
| 召回 | `searchSemanticDedup` | `false` | 搜索时语义去重（激进选项，近重复行在 Rerank 前丢弃，v0.5.0）|
| 召回 | `searchSemanticDedupThreshold` | `0.95` | 搜索时语义去重相似度阈值（v0.5.0，默认 0.95，`searchSemanticDedup=true` 时生效）|
| 质量 | `memoryQualityFilter` | 开 | 记忆质量过滤（0-100 打分，低质降权/归档，`low_quality` 仍可显式搜索）|
| 审计 | `llmAudit` | 开 | LLM 消耗审计（`llm_audit_logs` 表 + 埋点 + 只读 API）|
| 会话 | `sessionLifecycleEnabled` | `false` | 会话生命周期（v0.6.0，默认关）：会话被删/销毁时软隐藏其出生记忆（与 `archived` 正交、可恢复）|

## 📦 安装

```bash
# 安装插件（自动注册 bundle 层）
dsh plugin --profile web add @modusensus/dsh-mneme
dsh web
```

> 需要 Node 24+（`node:sqlite`）。完整安装 / 配置 / 架构见 [插件文档](dsh-mneme/README.md)。

## 🧪 本地开发

```bash
cd dsh-mneme
npm install
npm test          # 628 个测试
npm run stress    # 三轴线压测
npm run sync      # src → lib 同步
```

## 📄 文档

| 文档 | 路径 |
|------|------|
| 插件完整文档（功能 / 安装 / 配置 / 架构） | [dsh-mneme/README.md](dsh-mneme/README.md) |
| 实体结构化设计 | [dsh-mneme/docs/ENTITIES.md](dsh-mneme/docs/ENTITIES.md) |
| 语义架构 | [dsh-mneme/docs/SEMANTIC.md](dsh-mneme/docs/SEMANTIC.md) |
| 本地模型部署指南 | [dsh-mneme/docs/LOCAL_MODEL.md](dsh-mneme/docs/LOCAL_MODEL.md) |
| v0.1 迁移说明 | [dsh-mneme/docs/MIGRATION.md](dsh-mneme/docs/MIGRATION.md) |

## 🗺️ 进化路线图

记忆会自我成长：

```
🧬 基因（v0.3.0）→ 🛡️ 审计加固（v0.3.6–0.3.9）→ 💤 睡眠维护（v0.4.0）→ 🕸️ 召回融合与图谱（v0.5.0）→ ✨ 自进化（v0.6.0）
```

| 版本 | 主题 | 一句话 | 状态 |
|------|------|--------|------|
| **v0.3.0** | 记忆基因 | entities/attrs/relations 三表 + 时间轴 + LLM 抽取 | ✅ 404 测试 |
| **v0.3.1** | Logger 统一 | ✅ 已完成（extractor/service 接入 DSH logger 体系，404 测试） | — |
| **v0.3.2** | Mirror 健康状态 | ✅ 已完成（F-NEW-03：持久 dirty 状态 + 启动重渲染 + /health 端点，443 测试） | — |
| **v0.3.3** | 社区 issue 修复 | ✅ 已完成（issue#3 mergeHumanEdits 补 re-embed + issue#4 缓存目录用户级默认 + 文档字段名修正，443 测试） | — |
| **v0.3.4** | 安全依赖升级 | ✅ 已完成（PR#5 adm-zip 0.5.18→0.6.0 修 CVE-2026-39244，443 测试） | — |
| **v0.3.5** | 向量修复 + 安全文档 | ✅ 已完成（issue#6 scheduleEmbed 兜底 + SECURITY.md v2.1，443 测试） | — |
| **v0.3.6** | 镜像债务建模 | ✅ 已完成（audit peer 4 阻断：generation/CAS/fence + 逐 type + health 鉴权脱敏，443 测试） | — |
| **v0.3.7** | 启动竞态修复 | ✅ 已完成（issue#6：回灌移入 init().then + scheduleEmbed 就绪门 + init 幂等，443 测试） | — |
| **v0.3.8** | 审计 6 项阻断修复 | audit peer 复验 6 项运行时阻断全修 + mirror 同步可靠性，447 测试 | ✅ 已完成 |
| **v0.3.9** | 审计 A/B/D/F 加固 | CAS 同事务 + degraded 回执 + 逐 type 物理终态 + 整数 fail-closed，450 测试 | ✅ 已完成 |
| **v0.4.0** | 系统级睡眠 Sleep Mode | 空闲触发的四阶段深度维护（冲突消解/归档降级/模式发现/关系补全）+ 分层压缩，471 测试 | ✅ 已完成 |
| **v0.4.2** | autoSummarize 自定义模型 | `summarizeProvider`/`summarizeModel` 配置项，独立轻量模型摘要 | ✅ 已完成 |
| **v0.4.3** | autoDream 大记忆量修复 | `dreamMaxTokens` 上限 32768→131072 + `dreamReasoningEffort`/`sleepReasoningEffort` 思考开关（issue#9 B+A，none 默认） | ✅ 478 测试 |
| **v0.4.4** | autoDream 决策覆盖修复 | 滑动窗口 `dreamMaxSnapshotSize`(默认200) + 隐式 keep `dreamImplicitKeep` + 覆盖率下限 `dreamMinExplicitCoverage`(默认50%) + 固定决策 schema（issue#9 方案C） | ✅ 487 测试 |
| **v0.4.5** | epistemic trust + recall eval | 记忆可信度分级 `trustEpistemicWeighting`（observation>inferred>subjective，检索/注入/dream 合并冲突加权）+ 检索评估 `evaluateRetrieval` 落库 `recall_evals`（`evalPersistTestResults`，opt-in 默认关，生产隔离） | ✅ 518 测试 |
| **v0.4.6** | 8 项修复 | 向量链路（embedSingle 适配 / `autoReindexOnBoot` 存量回填 / `vector_meta` 元数据）+ 注入语义召回 `hybridInject` + 同标题追加 `content_history` + 注入长度上限 + 质量过滤 `memoryQualityFilter` + LLM 审计 `llmAudit` | ✅ 553 测试 |
| **v0.4.7** | 迁移幂等化 | schema 迁移改用 `addColumn` helper 吞掉 duplicate column name 并发竞态（v0.4.6 CI peer 并发测试暴露，12 处统一收口） | ✅ 已完成 |
| **v0.5.0** | 召回融合与记忆可视化 | 主区「记忆库」视图（取代侧边栏抽屉）+ 记忆图谱（ego-graph API + 零依赖 SVG 力导向）+ BM25 三路召回融合 + 自适应阈值 + 会话热记忆 + 召回基准评测 | ✅ 593 测试 |
| **v0.5.2** | 记忆溯源 session_id | memories 表 `session_id` 列 + `memory_save`/摘要记录出生会话（birth provenance，为 v0.6.0 推理路径 / 兴趣漂移分析打底） | ✅ 已发布（部署环境） |
| **v0.5.3** | autoDream 思考关闭 + 字段归一化 | `dreamReasoningEffort`/`sleepReasoningEffort` 支持 `off` 显式关思考（deepseek-v4-flash 实测 8192 预算不再被推理吃光，12s/2075 token 完成）+ 决策字段名归一化兜底（`target_ids`→`ids`、wrapper 解包等） | ✅ 613 测试 |
| **v0.6.0** | 会话生命周期 | 把对话当存档点：`session_disposed_at` 独立字段软隐藏会话删除的记忆（与 `archived` 正交、可恢复）+ `memory_delete` 描述删除 + 事件熔断 | ✅ 628 测试 |
| **v0.7.0+** | 自进化记忆 | 兴趣漂移 + 跨 workspace | 远期 |

已完成版本详见 [Release Notes](https://github.com/modusensus/dsh-mneme/releases)。

## 📜 License

MIT

---

<a name="english"></a>

# 🇬🇧 dsh-mneme (English)

> **Memory Genome · Let memory evolve** — from text warehouse to structured knowledge base. Memory is no longer just stored; it grows.

`dsh-mneme` is a [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin providing persistent cross-session memory. **Mneme** (Μνήμη) — named after Mnemosyne, the Greek goddess of memory and dreams, mirroring how autoDream consolidates memories in the background.

Memory shouldn't be a black box. Mneme makes memory **readable, structured, and evolvable**:

- **Readable**: SQLite + human-editable Markdown mirrors, two-way sync — memory sovereignty stays with you
- **Structured**: entity / attribute / timeline tables distill text fragments into structured knowledge (v0.3.0 Memory Genome)
- **Evolvable**: autoDream background consolidation + reflection updates + conflict freeze — memory refines itself, evolving toward self-adaptation

## ⏱️ 30-Second TL;DR

**One-liner**: dsh-mneme gives your Agent cross-session memory — it remembers you and your projects, and consolidates in the background, so it knows you better over time.

| ① Write | ② Store | ③ Evolve |
|---------|---------|----------|
| The model records actively during chat (`memory_save`); sessions are distilled automatically on end (`autoSummarize`) | SQLite primary store + human-editable Markdown mirrors; entities / attributes / timeline in three structured layers | New sessions auto-inject relevant memories; autoDream dedupes / merges / archives in the background — the store refines itself |

```bash
# Get started in 30 seconds
dsh plugin --profile web add @modusensus/dsh-mneme
dsh web
```

**What it is not** (honest boundaries):

- Not a vector database — semantic search is an optional enhancement; zero extra deps by default
- Not a replacement for session logs — it stores distilled knowledge "worth remembering across sessions"
- Does not change the model itself — what evolves is the memory store and the context injected each turn
- Deleting a session ≠ deleting memories — with session lifecycle enabled, deleting a session only **soft-hides** its memories (recoverable), data is never lost

---

## 🧬 Memory Genome (Structured Memory, v0.3.0)

**From text fragments to a structured knowledge base.**

In v0.2.x, memory was text fragments: "user likes Python" and "user likes Rust" were two separate memories, with no knowledge that they are different versions of the same attribute (programming language) of the same entity (user). v0.3.0 structures memory with three tables — like DNA composed of genes, base pairs, and sequences:

```
memories (existing, unchanged)
    │  (extraction triggered after write)
    ▼
entities ──→ entity_attrs ──→ entity_relations
(gene)        (base pairs)      (sequence relations)
```

| Table | Role | Key design |
|-------|------|------------|
| `entities` | Gene | person / project / tech / concept / org, `mention_count` tracks activity |
| `entity_attrs` | Base pairs | `valid_until` snapshot timeline — attribute changes **never overwrite history** |
| `entity_relations` | Sequence | `supersedes` / `part_of` / `depends_on` / `uses` / `related_to` |

### Timeline: evolution history of memory

The `valid_until` mechanism is the heart of the memory genome — every attribute value is a **timestamped version**:

- New value written → old row stamped `valid_until` (kept, not deleted)
- Current values → `valid_until IS NULL`
- Change history → all rows ordered by `valid_from`

"user likes Python" → "user likes Rust" no longer overwrites — it **auto-builds a supersedes chain**, preserving the full evolution trace.

### LLM Entity Extraction (opt-in)

After a memory write, an async, non-blocking LLM call extracts entities/attributes/relations:

- **JSON contract**: `{ entities: [{name, type, attrs}], relations: [{from, to, type}] }`
- **resolveEntity dedup**: same-name entities reuse, `mention_count` +1
- **Fail-safe**: extraction failure degrades to plain-text storage, never blocks the write
- **Isolated by switch**: `entityExtractionEnabled` defaults `false`; off = v0.2.x behavior unchanged

### Structured Search

| Prefix | Meaning | Example |
|--------|---------|---------|
| `entity:React` | exact entity recall | all memories related to React |
| `attr:programming_language=Rust` | attribute filter | memories where programming language is Rust |
| `attr:deadline` | attribute-name filter | all memories with a deadline attribute |

`entity:` search prioritizes **precise association**: entity_attrs exact hit (score=1.0) > keyword mention (score=0.7).

---

## 🧠 autoDream Self-consolidation

The background "dream engine" keeps the memory store refined:

- **Decision-list consolidation**: LLM outputs `keep`/`merge`/`archive`/`conflict`/`update` decisions, server-validated and applied one by one (fail-safe)
- **Reflection update (v0.2.1)**: directly corrects stale/wrong memories; `failure_memories` records correction history
- **Conflict freeze (v0.2.9)**: conflicts configurable as "frozen for manual review" instead of auto-adjudication
- **Entity-aware (v0.3.0)**: update writes `supersedes` relations; merge migrates loser's entity attrs to keeper
- **CAS guard + transactions**: concurrency-safe, multi-step atomic

## 💤 Sleep Mode (v0.4.0, opt-in)

autoDream is "passively threshold-triggered"; Sleep Mode upgrades to "proactive scheduled maintenance + tiered compression". When the store is idle for `sleepIdleMinutes`, it runs a **4-phase deep maintenance pass** (off by default):

1. **Conflict resolution**: whole-store contradiction detection, strictness tiers (gentle 0.92 / normal 0.85 / aggressive 0.75)
2. **Archival demotion**: tiered by `last_accessed_at` — memories untouched for 30d shrink to a summary (full body kept in `_full_content`, losslessly restorable); 90d → fully archived
3. **Pattern discovery**: LLM scans recent memories for recurring patterns, mints `type=pattern` memories with evidence-id validation
4. **Relation completion**: detects orphan entities and completes implied relations (co-occurrence `related_to` / project `part_of` / tech `depends_on`)

Interruptible (user activity aborts the cycle), serial-safe (shares the `service.enqueue` queue with autoDream — never overlapping), fail-safe (one phase failing never blocks the rest), audit-continuous (`dream_runs` rows tagged `run_type='sleep'`).

## 🕸️ Memory Graph & Three-Way Recall (v0.5.0)

**Make memory visible — and findable.**

- **Main-area "Memory" view**: memory features move into a full-width main-content tab (alongside "Chat / Trajectory"), replacing the sidebar drawer — three sub-views ("Memory" three-column browse / "Graph" / "Settings"), visually aligned with the host's native views.
- **Memory graph visualization**: type an entity name to load its neighborhood network — a read-only server-side ego-graph API (1-2 hop BFS) plus a zero-dependency hand-written SVG force-directed layout (the plugin runtime cannot require third-party graph libs). Nodes are draggable, edges jump back to source memories, graph ↔ memory cross-navigation.
- **Three-way recall fusion**: a **BM25 sparse recall** path (ASCII tokens + CJK bigrams, IDF-weighted) joins vector recall and FTS5/LIKE keyword — proper nouns, IDs, and code snippets no longer depend on substring hits; combined with **adaptive thresholds** (dynamic cutoff by query shape), recall gains are reproducibly verifiable via the built-in benchmark (Recall@5 / MRR, legacy vs fused).
- **Session-level hot memory**: the last N conversation turns (default 5 rounds / 2000-token budget) roll-trimmed and injected as "short-term context → long-term recall → summary" — stateless rebuild, never persisted.

## 💾 Session Lifecycle (v0.6.0, opt-in)

**Treat conversations as save points — deleting a session ≠ deleting memories.**

- **Off by default** (`sessionLifecycleEnabled: false`, old behavior preserved). When enabled, deleting/destroying a session (DSH `session/disposed` event) **soft-hides** memories born in that session (`session_id` provenance) — excluded from retrieval/inject/list/consolidation, but **not deleted**, recoverable anytime
- **Orthogonal to `archived`**: `archived` is the user/AI actively choosing "keep long-term but quiet"; `session_disposed_at` is passive quarantine from session deletion — they never clobber each other. Restoring a session never resurrects memories you manually archived
- **Global memories immune**: pre-existing memories without `session_id` are treated as global and never participate in session cleanup
- **Idempotent + circuit-breaker**: dispose/restore guarded by state (no-op on repeat); the event callback catches internal exceptions, never thrown into DSH's session cleanup flow
- **Recovery**: `service.restoreBySession(sessionId)` restores in one call; `listBySession(sessionId, { includeDisposed: true })` shows what is currently hidden (DTO carries a `disposed` flag)

## 🏛️ Memory Sovereignty

Transparent, auditable, yours:

- **Markdown mirrors**: `preferences.md` / `projects.md` / `decisions.md` / `history.md` / `summary.md` — human-readable and editable
- **Human edits win**: `last-rendered digest` baseline + three-way merge, concurrent human edits never lost
- **Two-way sync**: manual edits merged back; machine writes re-render the mirror

## 🔮 Offline Semantic Search (v0.2)

A fully-offline semantic memory engine, zero API cost:

- **Local embedding**: ONNX (`bge-small-zh`, offline) / Ollama / OpenAI-compatible, auto-degrading
- **Rerank**: `bge-reranker-base` cross-encoder for sharper Top-K
- **Hybrid search**: weighted vector + keyword blend
- **autoDream semantic boost**: vector clustering surfaces related / potentially conflicting memories

## 🔐 Audit & Trust

Every decision is replayable; every claim has evidence:

- **dream_runs audit**: input snapshot digest + decision list + outcome + receipt, replayable
- **receipt_chain**: per-record receipts, replay must reproduce the same result
- **recall_runs**: retrieval scenes auditable
- **policy_epoch**: rule version — old rulings degrade to historical evidence after upgrades
- **Security audit peer re-verification**: isolated regression on real npm tarballs, 7 release gates + F-03 honest audit
- **LLM cost audit (v0.4.6)**: every background LLM call (autoDream / autoSummarize) writes to `llm_audit_logs` (tokens/duration/status/source); read-only API aggregates budget over recent days
- **Memory quality filter (v0.4.6)**: `memoryQualityFilter` scores before write; low-quality memories demoted or archived (`low_quality` stays searchable, never auto-injected)
- **628 tests + three-axis stress** all green

## ⚙️ Configuration (excerpt)

| Group | Key | Default | Description |
|-------|-----|---------|-------------|
| Entity | `entityExtractionEnabled` | `false` | Memory genome master switch |
| Entity | `entityExtractionModel` | `""` | Extraction model (empty = reuse dream route) |
| Entity | `entityExtractionMaxEntities` | `10` | Max entities per extraction |
| Entity | `entitySearchEnabled` | `true` | entity:/attr: prefix search |
| Reflection | `reflectionUpdateEnabled` | `true` | update decision switch |
| Reflection | `conflictFreezeEnabled` | `false` | Conflict freeze switch |
| Vector | `embedProvider` | `openai` | Semantic backend (`local` = offline) |
| Vector | `rerankEnabled` | `false` | Rerank switch |
| Trust | `trustEpistemicWeighting` | `false` | Memory credibility weighting (observation>inferred>subjective, affects retrieval/inject/dream merge-conflict; opt-in, off by default) |
| Eval | `evalPersistTestResults` | `false` | Persist `evaluateRetrieval` results to `recall_evals` (opt-in, off by default; production search unaffected) |
| Vector | `autoReindexOnBoot` | `true` | Auto-backfill missing embeddings in the background on boot |
| Inject | `hybridInject` | `true` | Semantic-first injection (non-empty query recalls via vector first, rule pick fills/dedupes) |
| Recall | `bm25SearchEnabled` | `true` | BM25 sparse third recall path (scattered-word/ID/code-snippet queries, v0.5.0) |
| Recall | `adaptiveThresholdEnabled` | `true` | Adaptive similarity threshold (dynamic cutoff by query shape, v0.5.0) |
| Hot memory | `hotMemoryEnabled` | `true` | Master switch for session-level hot memory (v0.5.0) |
| Hot memory | `hotMemoryRounds` / `hotMemoryMaxTokens` | `5` / `2000` | Session-level hot memory rounds and token budget (v0.5.0) |
| Inject | `selectiveInjectEnabled` | `true` | Selective injection: candidates re-ranked by topical similarity to current query (v0.5.0) |
| Recall | `searchSemanticDedup` | `false` | Search-time semantic dedup (aggressive option, near-duplicates dropped before Rerank, v0.5.0) |
| Recall | `searchSemanticDedupThreshold` | `0.95` | Semantic dedup similarity threshold (v0.5.0, default 0.95; effective when `searchSemanticDedup=true`) |
| Quality | `memoryQualityFilter` | on | Memory quality filter (0-100 scoring; low-quality demoted/archived, `low_quality` still searchable) |
| Audit | `llmAudit` | on | LLM cost audit (`llm_audit_logs` table + instrumentation + read-only API) |
| Session | `sessionLifecycleEnabled` | `false` | Session lifecycle (v0.6.0, off by default): deleting/destroying a session soft-hides its born memories (orthogonal to `archived`, recoverable) |

## 📦 Install

```bash
dsh plugin --profile web add @modusensus/dsh-mneme
dsh web
```

> Requires Node 24+ (`node:sqlite`). Full install / config / architecture docs in the [plugin README](dsh-mneme/README.md).

## 🧪 Local Development

```bash
cd dsh-mneme
npm install
npm test          # 628 tests
npm run stress    # three-axis stress test
npm run sync      # src → lib sync
```

## 📄 Docs

| Doc | Path |
|-----|------|
| Full plugin docs | [dsh-mneme/README.md](dsh-mneme/README.md) |
| Entity structure design | [dsh-mneme/docs/ENTITIES.md](dsh-mneme/docs/ENTITIES.md) |
| Semantic architecture | [dsh-mneme/docs/SEMANTIC.md](dsh-mneme/docs/SEMANTIC.md) |
| Local model guide | [dsh-mneme/docs/LOCAL_MODEL.md](dsh-mneme/docs/LOCAL_MODEL.md) |
| v0.1 migration | [dsh-mneme/docs/MIGRATION.md](dsh-mneme/docs/MIGRATION.md) |

## 🗺️ Evolution Roadmap

Memory grows:

```
🧬 Gene (v0.3.0) → 🛡️ Audit hardening (v0.3.6–0.3.9) → 💤 Sleep maintenance (v0.4.0) → 🕸️ Recall fusion & graph (v0.5.0) → ✨ Self-evolve (v0.6.0)
```

| Version | Theme | One-liner | Status |
|---------|-------|-----------|--------|
| **v0.3.0** | Memory genome | entities/attrs/relations + timeline + LLM extraction | ✅ 404 tests |
| **v0.3.1** | Logger unification | ✅ Done (extractor/service wired to DSH logger system, 404 tests) | — |
| **v0.3.2** | Mirror health state | ✅ Done (F-NEW-03: persistent dirty state + startup re-render + /health endpoint, 443 tests) | — |
| **v0.3.3** | Community issue fixes | ✅ Done (issue#3 mergeHumanEdits re-embed + issue#4 user-level cache dir + doc field name fixes, 443 tests) | — |
| **v0.3.4** | Security dependency upgrade | ✅ Done (PR#5 adm-zip 0.5.18→0.6.0 fixes CVE-2026-39244, 443 tests) | — |
| **v0.3.5** | Vector fix + security docs | ✅ Done (issue#6 scheduleEmbed fallback + SECURITY.md v2.1, 443 tests) | — |
| **v0.3.6** | Mirror debt modeling | ✅ Done (audit peer 4 blockers: generation/CAS/fence + per-type + health auth/sanitize, 443 tests) | — |
| **v0.3.7** | Startup race fix | ✅ Done (issue#6: backfill in init().then + scheduleEmbed readiness gate + init idempotent, 443 tests) | — |
| **v0.3.8** | Audit 6-blocker fixes | audit peer 6 runtime blockers + mirror sync reliability, 447 tests | ✅ Done |
| **v0.3.9** | Audit A/B/D/F hardening | CAS same-tx + degraded receipt + per-type terminal state + integer fail-closed, 450 tests | ✅ Done |
| **v0.4.0** | Sleep Mode | idle-triggered 4-phase deep maintenance (conflict/demote/pattern/relation) + tiered compression, 471 tests | ✅ Done |
| **v0.4.2** | autoSummarize custom model | `summarizeProvider`/`summarizeModel` config, independent lightweight model for summaries | ✅ Done |
| **v0.4.3** | autoDream large-memory fix | `dreamMaxTokens` cap 32768→131072 + `dreamReasoningEffort`/`sleepReasoningEffort` thinking switches (issue#9 B+A, none default) | ✅ 478 tests |
| **v0.4.4** | autoDream decision-coverage fix | sliding window `dreamMaxSnapshotSize`(default 200) + implicit keep `dreamImplicitKeep` + min explicit coverage `dreamMinExplicitCoverage`(default 50%) + fixed decision schema (issue#9 plan C) | ✅ 487 tests |
| **v0.4.5** | epistemic trust + recall eval | memory credibility tiers `trustEpistemicWeighting` (observation>inferred>subjective, weighted in retrieval/inject/dream merge-conflict) + retrieval eval `evaluateRetrieval` persisting to `recall_evals` (`evalPersistTestResults`, opt-in off by default, production isolated) | ✅ 518 tests |
| **v0.4.6** | 8 fixes | vector chain (embedSingle / `autoReindexOnBoot` backfill / `vector_meta`) + semantic-first injection `hybridInject` + same-title `content_history` + inject length caps + quality filter `memoryQualityFilter` + LLM audit `llmAudit` | ✅ 553 tests |
| **v0.4.7** | Migration idempotency | schema migration uses `addColumn` helper to swallow duplicate-column-name concurrency races (exposed by v0.4.6 CI peer concurrency tests; unified across 12 sites) | ✅ Done |
| **v0.5.0** | Recall fusion & memory visualization | main-area "Memory" view (replaces sidebar drawer) + memory graph (ego-graph API + zero-dependency SVG force layout) + BM25 three-way recall fusion + adaptive threshold + session hot memory + recall benchmark | ✅ 593 tests |
| **v0.5.2** | Memory provenance session_id | `session_id` column on memories + `memory_save`/summary record birth session (birth provenance, raw material for v0.6.0 reasoning-path / drift analysis) | ✅ Released (deployment env) |
| **v0.5.3** | autoDream thinking-off + field normalization | `dreamReasoningEffort`/`sleepReasoningEffort` now accept `off` to explicitly disable thinking (deepseek-v4-flash: 8192 budget no longer drained by reasoning, 12s/2075 tokens) + decision field-name normalization fallback (`target_ids`→`ids`, wrapper unwrap) | ✅ 613 tests |
| **v0.6.0** | Session lifecycle | Treat conversations as save points: `session_disposed_at` independent column soft-hides a deleted session's memories (orthogonal to `archived`, recoverable) + `memory_delete` query-based deletion + event circuit-breaker | ✅ 628 tests |
| **v0.7.0+** | Self-evolving memory | Interest drift + cross-workspace | long-term |

Completed versions see [Release Notes](https://github.com/modusensus/dsh-mneme/releases).

## 📜 License

MIT
