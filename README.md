<p align="center">
  <img src="logo.png" alt="dsh-mneme" width="140" />
</p>

<h1 align="center">dsh-mneme</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@modusensus/dsh-mneme"><img src="https://img.shields.io/npm/v/@modusensus/dsh-mneme?color=blue&label=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="license"></a>
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="Awesome"></a>
  <a href="https://github.com/modusensus/dsh-mneme/actions"><img src="https://img.shields.io/github/actions/workflow/status/modusensus/dsh-mneme/test.yml" alt="CI"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-24%2B-blue" alt="node"></a>
  <a href="https://github.com/modusensus/dsh-mneme"><img src="https://img.shields.io/badge/tests-326%20passed-success" alt="tests"></a>
</p>

<p align="center"><strong><a href="#中文">中文</a> | <a href="#english">English</a></strong></p>

---

<a name="中文"></a>

# 🇨🇳 dsh-mneme（中文）

> **记忆主权，归还于你** —— 记忆不再是黑盒，而是你读得懂、改得动的 Markdown。

`dsh-mneme` 是一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件，为 Agent 提供持久的跨会话记忆能力。**Mneme**（Μνήμη）——希腊记忆女神 Mnemosyne 之名，掌管记忆与梦境，正如 autoDream 在后台巩固记忆。

不同于把记忆锁进数据库的插件，Mneme 把记忆**写成你读得懂的 Markdown**——你始终握着记忆的主权：看得见、改得动、删得掉，记忆这回事不该让 Agent 一个人说了算。

## ✨ 特性一览

- **🧠 记忆主权**：SQLite + 可人工编辑的 Markdown 镜像，双向同步——记忆透明、可审查、归你所有
- **autoDream 梦境巩固**：后台自动去重 / 合并 / 归档 / 冲突裁决 / 自我修正（fail-safe 校验），越用越精炼
- **反思更新（v0.2.1）**：autoDream 可直接修正单条过时/错误记忆；失败追踪表记录纠正历史，为自进化积累数据
- **7 个模型工具**：`memory_save` / `memory_search` / `memory_list` / `memory_update` / `memory_delete` / `memory_forget` / `memory_archive`
- **自动注入 + 会话摘要**：新会话自动带入相关记忆，会话结束自动提炼偏好 / 决策 / 教训
- **Web 记忆面板**：官方设置面板内嵌，按类型浏览、全文搜索 + 语义（向量）搜索
- **用户设置 + 自定义指令**：用户画像、行为规则每轮注入；注册斜杠命令
- **向量搜索**：OpenAI 兼容 embeddings API，语义匹配字面不同但意思相近的记忆

## 🔮 语义增强（完全离线，v0.2+）

**完全离线的语义记忆引擎**——embedding、rerank、搜索全在本地，零 API 成本：

- **本地 Embedding**：三后端可选——ONNX（`Xenova/bge-small-zh-v1.5`，离线）/ Ollama / OpenAI 兼容，失败自动逐级降级，最差回退关键词搜索
- **Rerank 精排**：`Xenova/bge-reranker-base` 对召回候选交叉编码精排，提升 Top-K 准确率
- **autoDream 语义增强**：对记忆向量聚类（`clusterMemories`），自动发现主题相近 / 疑似矛盾的记忆，巩固更精准
- **搜索流水线**：混合召回（关键词 + 向量）→ Rerank → Top-K

在 `cordis.patch.yml` 配置 `embedProvider`（默认 `openai` 保持 v0.1 行为，切到 `local` 即完全离线）。无需数据迁移。

> 📖 详见 [语义架构](dsh-mneme/docs/SEMANTIC.md) · [本地模型部署](dsh-mneme/docs/LOCAL_MODEL.md) · [v0.1 迁移](dsh-mneme/docs/MIGRATION.md)

## 📦 安装（DSH）

```bash
# 安装插件（自动注册 bundle 层）
dsh plugin --profile web add @modusensus/dsh-mneme
dsh web
```

> 需要 Node 24+（`node:sqlite`）。安装 / 配置 / 架构详见 [插件完整文档](dsh-mneme/README.md)。

## 📁 仓库结构

```
dsh-mneme/   插件本体（npm 包 @modusensus/dsh-mneme）
docs/        设计文档与实施计划
```

## 🧪 本地开发

```bash
cd dsh-mneme
npm install
npm test          # 326 个测试
npm run stress    # 三轴线压测（长会话检索 / 冲突仲裁 / 多 Agent 并发）
npm run sync      # src → lib 同步（发布时自动执行）
```

## 📄 文档

| 文档 | 路径 |
|------|------|
| 插件完整文档（功能 / 安装 / 配置 / 架构） | [dsh-mneme/README.md](dsh-mneme/README.md) |
| 语义架构 | [dsh-mneme/docs/SEMANTIC.md](dsh-mneme/docs/SEMANTIC.md) |
| 本地模型部署指南 | [dsh-mneme/docs/LOCAL_MODEL.md](dsh-mneme/docs/LOCAL_MODEL.md) |
| v0.1 迁移说明 | [dsh-mneme/docs/MIGRATION.md](dsh-mneme/docs/MIGRATION.md) |
| 插件设计 | [docs/superpowers/specs/2026-08-13-dsh-mneme-design.md](docs/superpowers/specs/2026-08-13-dsh-mneme-design.md) |
| autoDream 设计 | [docs/superpowers/specs/2026-08-13-dsh-mneme-autodream-design.md](docs/superpowers/specs/2026-08-13-dsh-mneme-autodream-design.md) |
| 实施计划（核心插件） | [docs/superpowers/plans/2026-08-13-dsh-memory.md](docs/superpowers/plans/2026-08-13-dsh-memory.md) |
| 实施计划（autoDream） | [docs/superpowers/plans/2026-08-13-dsh-memory-autodream.md](docs/superpowers/plans/2026-08-13-dsh-memory-autodream.md) |
| 演进计划书（v0.2.1+） | [docs/superpowers/plans/2026-08-15-dsh-mneme-reflection-update.md](docs/superpowers/plans/2026-08-15-dsh-mneme-reflection-update.md) |

## 🗺️ 未来版本展望 · Roadmap

> 计划基于社区反馈持续演进，实施周期为估算值。

| 版本 | 核心主题 | 一句话 | 实施周期 |
|------|---------|--------|---------|
| **v0.2.1** | 反思更新 | ✅ 已完成（update 决策 + failure_memories 表，258 测试） | — |
| **v0.2.2** | 流水线补全 | ✅ 已完成（专项测试 + 审查修复，258 测试） | — |
| **v0.2.4** | 安全加固 | ✅ 已完成（API 鉴权 apiToken + apiKey 掩码 + timing-safe，258 测试） | — |
| **v0.2.5** | 安全审计修复 | ✅ 已完成（CAS + 事务化应用 + reconcile 审计 + reranker opt-in + 归档恢复，258 测试） | — |
| **v0.2.6** | 社区贡献 | ✅ 已完成（PR #2 嵌入式面板 UI 改进，263 测试） | — |
| **v0.2.7** | 诚实审计 | ✅ 已完成（F-03：noop/degraded 状态，空跑不误报 ok，263 测试） | — |
| **v0.2.8** | 社区建议三连 | ✅ 已完成（召回层 receipt + policy_epoch + per-record 收据链，326 测试） | — |
| **v0.2.9** | 轻量结构化 | 实体注释标记（零 schema 变更，验证可行性） | 2-3 天 |
| **v0.3.0** | 记忆基因 | 正式 entities/attrs/relations 三表 + 时间轴 | 1 周 |
| **v0.3.1** | 系统级睡眠 | Sleep 调度器 + 分层压缩 + 模式发现 | 3-5 天 |
| **v0.4.0** | 反思性成长 | 纠错双向回流 + 规则演进 + 自适应参数 | 1-2 周 |
| **v0.5.0+** | 自进化记忆 | 兴趣漂移 + 跨 workspace（等 DSH 支持） | 远期 |

## 📜 License

MIT

---

<a name="english"></a>

# 🇬🇧 dsh-mneme (English)

> **Memory sovereignty, returned to you** — memory is no longer a black box, but Markdown you can read and edit.

`dsh-mneme` is a [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin that gives agents persistent cross-session memory. **Mneme** (Μνήμη) — named after Mnemosyne, the Greek goddess of memory and dreams, mirroring how autoDream consolidates memories in the background.

Unlike plugins that lock memory inside a database, Mneme writes memory as **human-readable Markdown** — memory sovereignty stays with you: see it, edit it, delete it. Memory shouldn't be decided by the agent alone.

## ✨ Features

- **🧠 Memory sovereignty**: SQLite + human-editable Markdown mirror, two-way sync — memory is transparent, auditable, and yours
- **autoDream consolidation**: background dedup / merge / archive / conflict resolution / self-correction (fail-safe validation), refined with use
- **Reflection update (v0.2.1)**: autoDream can correct stale/wrong single memories; a failure-tracking table records correction history for future self-evolution
- **7 model tools**: `memory_save` / `memory_search` / `memory_list` / `memory_update` / `memory_delete` / `memory_forget` / `memory_archive`
- **Auto-injection + session summary**: relevant memories injected at session start, preferences / decisions / lessons distilled at session end
- **Web memory panel**: embedded in the official settings panel — browse by type, full-text + semantic (vector) search
- **User settings + custom commands**: user profile and behavior rules injected every turn; register slash commands
- **Vector search**: OpenAI-compatible embeddings API for semantic matching of differently-worded but related memories

## 🔮 Semantic Enhancement (fully offline, v0.2+)

A fully-offline semantic memory engine — embedding, rerank and search all run locally, zero API cost:

- **Local embedding**: three interchangeable backends — ONNX (`Xenova/bge-small-zh-v1.5`, offline) / Ollama / OpenAI-compatible — degrading automatically, falling back to keyword search at worst
- **Rerank**: `Xenova/bge-reranker-base` cross-encoder re-ranking of recall candidates for sharper Top-K
- **autoDream semantic boost**: vector clustering (`clusterMemories`) surfaces topically-close or potentially conflicting memories for more precise consolidation
- **Search pipeline**: hybrid recall (keyword + vector) → rerank → Top-K

Configure `embedProvider` in `cordis.patch.yml` (default `openai` keeps v0.1 behavior; switch to `local` for fully offline). No data migration needed.

> 📖 See [Semantic architecture](dsh-mneme/docs/SEMANTIC.md) · [Local model guide](dsh-mneme/docs/LOCAL_MODEL.md) · [v0.1 migration](dsh-mneme/docs/MIGRATION.md)

## 📦 Install (DSH)

```bash
# Install the plugin (auto-registers the bundle layer)
dsh plugin --profile web add @modusensus/dsh-mneme
dsh web
```

> Requires Node 24+ (`node:sqlite`). Full install / config / architecture docs in the [plugin README](dsh-mneme/README.md).

## 📁 Repository Structure

```
dsh-mneme/   plugin package (npm @modusensus/dsh-mneme)
docs/        design docs & implementation plans
```

## 🧪 Local Development

```bash
cd dsh-mneme
npm install
npm test          # 326 tests
npm run stress    # three-axis stress test (long-session retrieval / conflict arbitration / concurrent agents)
npm run sync      # src → lib sync (runs automatically on publish)
```

## 📄 Docs

| Doc | Path |
|-----|------|
| Full plugin docs (features / install / config / architecture) | [dsh-mneme/README.md](dsh-mneme/README.md) |
| Semantic architecture | [dsh-mneme/docs/SEMANTIC.md](dsh-mneme/docs/SEMANTIC.md) |
| Local model guide | [dsh-mneme/docs/LOCAL_MODEL.md](dsh-mneme/docs/LOCAL_MODEL.md) |
| v0.1 migration | [dsh-mneme/docs/MIGRATION.md](dsh-mneme/docs/MIGRATION.md) |
| Plugin design | [docs/superpowers/specs/2026-08-13-dsh-mneme-design.md](docs/superpowers/specs/2026-08-13-dsh-mneme-design.md) |
| autoDream design | [docs/superpowers/specs/2026-08-13-dsh-mneme-autodream-design.md](docs/superpowers/specs/2026-08-13-dsh-mneme-autodream-design.md) |
| Implementation plan (core) | [docs/superpowers/plans/2026-08-13-dsh-memory.md](docs/superpowers/plans/2026-08-13-dsh-memory.md) |
| Implementation plan (autoDream) | [docs/superpowers/plans/2026-08-13-dsh-memory-autodream.md](docs/superpowers/plans/2026-08-13-dsh-memory-autodream.md) |
| Evolution plan (v0.2.1+) | [docs/superpowers/plans/2026-08-15-dsh-mneme-reflection-update.md](docs/superpowers/plans/2026-08-15-dsh-mneme-reflection-update.md) |

## 🗺️ Roadmap

> Plans evolve with community feedback; timelines are estimates.

| Version | Core theme | One-liner | Timeline |
|---------|------------|-----------|----------|
| **v0.2.1** | Reflection update | ✅ Done (update decision + failure_memories, 326 tests) | — |
| **v0.2.2** | Pipeline completion | ✅ Done (specialized tests + review fixes, 326 tests) | — |
| **v0.2.4** | Security hardening | ✅ Done (API auth apiToken + apiKey masking + timing-safe, 326 tests) | — |
| **v0.2.5** | Security audit fixes | ✅ Done (CAS + transactional apply + reconcile audit + reranker opt-in + archive restore, 326 tests) | — |
| **v0.2.6** | Community contribution | ✅ Done (PR #2 embedded panel UI fix, 326 tests) | — |
| **v0.2.7** | Honest audit | ✅ Done (F-03: noop/degraded states, no false ok on empty runs, 326 tests) | — |
| **v0.2.8** | Community suggestions ×3 | ✅ Done (recall-layer receipt + policy_epoch + per-record receipt chain, 326 tests) | — |
| **v0.2.9** | Lightweight structure | Entity comment markers (zero schema change, feasibility check) | 2-3 days |
| **v0.3.0** | Memory genome | Formal entities/attrs/relations tables + timeline | 1 week |
| **v0.3.1** | System-level sleep | Sleep scheduler + tiered compression + pattern discovery | 3-5 days |
| **v0.4.0** | Reflective growth | Correction feedback loop + rule evolution + adaptive params | 1-2 weeks |
| **v0.5.0+** | Self-evolving memory | Interest drift + cross-workspace (when DSH supports it) | Long-term |

## 📜 License

MIT
