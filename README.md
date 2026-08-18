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
  <a href="https://github.com/modusensus/dsh-mneme"><img src="https://img.shields.io/badge/tests-471%20passed-success" alt="tests"></a>
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
- **471 个测试 + 三轴压测**全绿

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
npm test          # 471 个测试
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
🧬 基因（v0.3.0）→ 🛡️ 审计加固（v0.3.6–0.3.9）→ 💤 睡眠维护（v0.4.0）→ ✨ 自进化（v0.5.0）
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
| **v0.5.0+** | 自进化记忆 | 兴趣漂移 + 跨 workspace | 远期 |

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
- **471 tests + three-axis stress** all green

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
npm test          # 471 tests
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
🧬 Gene (v0.3.0) → 🛡️ Audit hardening (v0.3.6–0.3.9) → 💤 Sleep maintenance (v0.4.0) → ✨ Self-evolve (v0.5.0)
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
| **v0.5.0+** | Self-evolving memory | Interest drift + cross-workspace | long-term |

Completed versions see [Release Notes](https://github.com/modusensus/dsh-mneme/releases).

## 📜 License

MIT
