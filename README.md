<h1 align="center">dsh-mneme</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@modusensus/dsh-mneme"><img src="https://img.shields.io/npm/v/@modusensus/dsh-mneme?color=blue&label=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="license"></a>
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="Awesome"></a>
  <a href="https://github.com/modusensus/dsh-mneme/actions"><img src="https://img.shields.io/github/actions/workflow/status/modusensus/dsh-mneme/test.yml" alt="CI"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-24%2B-blue" alt="node"></a>
  <a href="https://github.com/modusensus/dsh-mneme"><img src="https://img.shields.io/badge/tests-198%20passed-success" alt="tests"></a>
</p>

> **记忆主权，归还于你** · **Memory sovereignty, returned to you** — 记忆不再是黑盒，而是你读得懂、改得动的 Markdown。

`dsh-mneme` 是一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件，为 Agent 提供持久的跨会话记忆能力。**Mneme**（Μνήμη）——希腊记忆女神 Mnemosyne 之名，掌管记忆与梦境，正如 autoDream 在后台巩固记忆。

A cross-session memory plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness). **Mneme** (Μνήμη) — named after Mnemosyne, the Greek goddess of memory and dreams, mirroring how autoDream consolidates memory in the background.

不同于把记忆锁进数据库的插件，Mneme 把记忆**写成你读得懂的 Markdown**——你始终握着记忆的主权：看得见、改得动、删得掉。Unlike plugins that lock memory inside a database, Mneme writes memory as **human-readable Markdown** — memory sovereignty stays with you: see it, edit it, delete it.

---

## ✨ 特性一览 · Features

- **🧠 记忆主权 / Memory sovereignty**：SQLite + 可人工编辑的 Markdown 镜像，双向同步。SQLite + human-editable Markdown mirror, two-way sync.
- **autoDream 梦境巩固 / Consolidation**：后台自动去重 / 合并 / 归档 / 冲突裁决（fail-safe 校验），越用越精炼。
- **6 个模型工具 / Model tools**：`memory_save` / `memory_search` / `memory_list` / `memory_update` / `memory_delete` / `memory_forget`
- **自动注入 + 会话摘要 / Injection + summary**：新会话自动带入相关记忆，会话结束自动提炼偏好 / 决策 / 教训。
- **Web 记忆面板 / Web panel**：官方设置面板内嵌，按类型浏览、全文 + 语义搜索。
- **用户设置 + 自定义指令 / Settings + commands**：用户画像、行为规则每轮注入；注册斜杠命令。
- **向量搜索 / Vector search**：OpenAI 兼容 embeddings API，语义匹配字面不同但意思相近的记忆。

## 🔮 语义增强（完全离线，v0.2+）· Semantic Enhancement

**完全离线的语义记忆引擎**——embedding、rerank、搜索全在本地，零 API 成本。A fully-offline semantic memory engine — embedding, rerank and search all run locally, zero API cost.

- **本地 Embedding / Local embedding**：三后端可选——ONNX（`Xenova/bge-small-zh-v1.5`，离线）/ Ollama / OpenAI 兼容，失败自动逐级降级，最差回退关键词搜索。Three interchangeable backends (ONNX / Ollama / OpenAI-compatible), degrading automatically, falling back to keyword search at worst.
- **Rerank 精排 / Rerank**：`Xenova/bge-reranker-base` 对召回候选交叉编码精排，提升 Top-K 准确率。Cross-encoder re-ranking of recall candidates for sharper Top-K.
- **autoDream 语义增强 / Semantic boost**：对记忆向量聚类（`clusterMemories`），自动发现主题相近 / 疑似矛盾的记忆，巩固更精准。Vector clustering surfaces topically-close or potentially conflicting memories.
- **搜索流水线 / Search pipeline**：混合召回（关键词 + 向量）→ Rerank → Top-K。Hybrid recall → rerank → Top-K.

在 `cordis.patch.yml` 配置 `embedProvider`（默认 `openai` 保持 v0.1 行为，切到 `local` 即完全离线）。无需数据迁移。Configure `embedProvider` in `cordis.patch.yml` (default `openai` keeps v0.1 behavior; switch to `local` for fully offline). No data migration needed.

> 📖 详见 / See: [语义架构 SEMANTIC.md](dsh-mneme/docs/SEMANTIC.md) · [本地模型部署 LOCAL_MODEL.md](dsh-mneme/docs/LOCAL_MODEL.md) · [v0.1 迁移 MIGRATION.md](dsh-mneme/docs/MIGRATION.md)

---

## 📦 安装（DSH）· Install

```bash
# 安装插件（自动注册 bundle 层）
dsh plugin --profile web add @modusensus/dsh-mneme
dsh web
```

> 需要 Node 24+（`node:sqlite`）。安装 / 配置 / 架构详见 [插件完整文档](dsh-mneme/README.md)。Requires Node 24+ (`node:sqlite`). Full install / config / architecture docs in the [plugin README](dsh-mneme/README.md).

---

## 📁 仓库结构 · Repository Structure

```
dsh-mneme/   插件本体（npm 包 @modusensus/dsh-mneme）plugin package
docs/        设计文档与实施计划 design docs & plans
```

---

## 🧪 本地开发 · Local Development

```bash
cd dsh-mneme
npm install
npm test          # 198 个测试 / tests
npm run stress    # 三轴线压测（长会话检索 / 冲突仲裁 / 多 Agent 并发）
npm run sync      # src → lib 同步（发布时自动执行）
```

---

## 📄 文档 · Docs

| 文档 Doc | 路径 Path |
|------|------|
| 插件完整文档 Full plugin docs | [dsh-mneme/README.md](dsh-mneme/README.md) |
| 语义架构 Semantic architecture | [dsh-mneme/docs/SEMANTIC.md](dsh-mneme/docs/SEMANTIC.md) |
| 本地模型部署 Local model guide | [dsh-mneme/docs/LOCAL_MODEL.md](dsh-mneme/docs/LOCAL_MODEL.md) |
| v0.1 迁移 Migration | [dsh-mneme/docs/MIGRATION.md](dsh-mneme/docs/MIGRATION.md) |
| 插件设计 Plugin design | [docs/superpowers/specs/2026-08-13-dsh-mneme-design.md](docs/superpowers/specs/2026-08-13-dsh-mneme-design.md) |
| autoDream 设计 | [docs/superpowers/specs/2026-08-13-dsh-mneme-autodream-design.md](docs/superpowers/specs/2026-08-13-dsh-mneme-autodream-design.md) |
| 实施计划（核心）Implementation plan | [docs/superpowers/plans/2026-08-13-dsh-memory.md](docs/superpowers/plans/2026-08-13-dsh-memory.md) |
| 实施计划（autoDream） | [docs/superpowers/plans/2026-08-13-dsh-memory-autodream.md](docs/superpowers/plans/2026-08-13-dsh-memory-autodream.md) |

---

## 📜 License

MIT
