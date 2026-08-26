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
  <a href="https://github.com/modusensus/dsh-mneme"><img src="https://img.shields.io/badge/tests-770%20passed-success" alt="tests"></a>
  <a href="https://www.npmjs.com/package/@modusensus/dsh-mneme"><img src="https://img.shields.io/npm/dm/@modusensus/dsh-mneme?color=blue&label=downloads" alt="npm downloads"></a>
  <a href="https://codecov.io/gh/modusensus/dsh-mneme"><img src="https://img.shields.io/codecov/c/github/modusensus/dsh-mneme/main" alt="coverage"></a>
</p>

<p align="center"><strong><a href="#中文">中文</a> | <a href="#english">English</a></strong></p>

---

<a name="中文"></a>

# 🇨🇳 dsh-mneme（中文）

> **记忆基因 · 让记忆自我进化** —— 从文本仓库到结构化知识库，记忆不再只是存储，而是会生长。

`dsh-mneme` 是一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件，为 Agent 提供持久的跨会话记忆能力。**Mneme**（Μνήμη）——希腊记忆女神 Mnemosyne 之名，掌管记忆与梦境，正如 autoDream 在后台巩固记忆。

## 它能解决什么问题

每次新开对话，AI 都像第一次认识你？

**dsh-mneme 给 DeepSeek Harness 装上跨会话记忆。** 你聊过的项目、提过的偏好、做过的决定，AI 都记得——即使关掉了窗口，下次打开还在。

### 三个典型场景

| 场景 | 没装插件 | 装了插件 |
|------|---------|---------|
| 周一聊完项目需求，周三继续 | "能再描述一下你的项目吗？" | "你指的是上周提到的博客重构吗？当时你说想用 Astro。" |
| 告诉 AI 你的编码习惯 | 每轮都要重复交代 | 一次设定，长期生效 |
| 整理大量资料后关窗口 | 资料丢了 | 自动归档，随时检索找回 |

## 核心特性

- **跨会话记忆** — 对话中 AI 自动记录关键信息，新会话自动注入相关记忆
- **自动整理** — 后台自动去重、合并、归档，记忆库越用越精炼
- **删对话 ≠ 删记忆** — 删除聊天窗口不会丢掉已保存的记忆（可配置）
- **你的数据你做主** — 所有记忆以 Markdown 格式存于本地，随时打开查看和编辑
- **完全离线** — 默认无需 API Key，所有处理在本地完成

## 安装

```bash
# 安装插件（自动注册 bundle 层）
dsh plugin --profile web add @modusensus/dsh-mneme
dsh web
```

> 需要 Node 24+（`node:sqlite`）。完整安装 / 配置 / 架构见 [插件文档](dsh-mneme/README.md)。

## 快速配置（可选）

装完即用，以下按需开启：

| 需求 | 配置项 | 默认值 | 改法 |
|------|--------|--------|------|
| 完全离线运行 | `embedProvider` | `openai` | 改为 `local` |
| 删除对话时保留记忆 | `sessionLifecycleEnabled` | `false` | 改为 `true` |
| 让 AI 自动提取结构化信息 | `entityExtractionEnabled` | `false` | 改为 `true` |

> 在 DSH 设置面板 → 记忆库设置 中修改。完整配置说明见 [配置文档](dsh-mneme/docs/CONFIG.md)。

## 隐私承诺

- 数据只存在你的电脑本地，不上传任何服务器
- 记忆是 Markdown 文件，人类可读、可手工编辑
- 默认零网络依赖，不需要 API Key
- 无遥测、无分析、无远程日志

## 文档

| 文档 | 路径 |
|------|------|
| 插件完整文档（功能 / 安装 / 配置 / 架构） | [dsh-mneme/README.md](dsh-mneme/README.md) |
| 实体结构化设计 | [dsh-mneme/docs/ENTITIES.md](dsh-mneme/docs/ENTITIES.md) |
| 语义架构 | [dsh-mneme/docs/SEMANTIC.md](dsh-mneme/docs/SEMANTIC.md) |
| 本地模型部署指南 | [dsh-mneme/docs/LOCAL_MODEL.md](dsh-mneme/docs/LOCAL_MODEL.md) |
| v0.1 迁移说明 | [dsh-mneme/docs/MIGRATION.md](dsh-mneme/docs/MIGRATION.md) |
| 版本历史 | [CHANGELOG.md](CHANGELOG.md) |
| 安全策略 | [SECURITY.md](SECURITY.md) |

## 🗺️ 路线图

```
🧬 基因（v0.3.0）→ 🛡️ 审计加固（v0.3.6–0.3.9）→ 💤 睡眠维护（v0.4.0）→ 🕸️ 召回融合与图谱（v0.5.0）→ ✨ 面板增强（v0.6.x）→ 🌡️ 自进化记忆（v0.7.0）→ 🕸️ 图谱增强（v0.8.0）
```

| 版本 | 主题 | 状态 |
|------|------|------|
| **v0.3.0** | 记忆基因：entities/attrs/relations 三表 + 时间轴 | ✅ |
| **v0.4.0** | Sleep Mode：空闲四阶段深度维护 | ✅ |
| **v0.5.0** | 召回融合与记忆可视化：BM25 + 图谱 + 热记忆 | ✅ |
| **v0.6.0** | 会话生命周期：删会话 ≠ 删记忆 | ✅ |
| **v0.7.0** | 自进化记忆：heat 幂律衰减 + sleep 双保护 + 实体热投影 | ✅ |
| **v0.7.1** | issue #31 修复：tags 桥接 entity_attrs + autoTag 面板开关生效 | ✅ |
| **v0.7.2** | issue #35 删除按钮内联确认修复 + issue #34 对话开始注入当前时间（opt-in） | ✅ |
| **v0.8.0** | 图谱增强：兴趣漂移 + 跨 workspace 共享 | 🚧 计划中（9 月末） |

## 🧪 本地开发

```bash
cd dsh-mneme
npm install
npm test          # 770 个测试
npm run stress    # 三轴线压测
npm run sync      # src → lib 同步
```

## 📜 License

MIT

---

<a name="english"></a>

# 🇬🇧 dsh-mneme (English)

> **Memory Genome · Let memory evolve** — from text warehouse to structured knowledge base. Memory is no longer just stored; it grows.

`dsh-mneme` is a [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin providing persistent cross-session memory. **Mneme** (Μνήμη) — named after Mnemosyne, the Greek goddess of memory and dreams, mirroring how autoDream consolidates memories in the background.

## What it does

Every time you start a new chat, the AI acts like it's never met you?

**dsh-mneme gives DeepSeek Harness cross-session memory.** Projects you've discussed, preferences you've mentioned, decisions you've made — the AI remembers them even after you close the window.

### Three typical scenarios

| Scenario | Without plugin | With plugin |
|----------|---------------|-------------|
| Continue a project discussion from Monday on Wednesday | "Can you describe your project again?" | "You mean the blog refactor from last week? You mentioned wanting to use Astro." |
| Tell the AI your coding habits | Repeat every session | Set once, remember forever |
| Close window after organizing research | Notes are lost | Auto-archived, retrievable anytime |

## Core Features

- **Cross-session memory** — AI automatically records key info during chats; new sessions inject relevant memories
- **Auto-consolidation** — Background deduplication, merging, and archival; the memory store refines itself over time
- **Delete session ≠ delete memories** — Closing a chat window doesn't lose saved memories (configurable)
- **Your data, your control** — All memories stored as local Markdown files, human-readable and editable
- **Fully offline** — Zero API Key needed by default; all processing happens locally

## Install

```bash
dsh plugin --profile web add @modusensus/dsh-mneme
dsh web
```

> Requires Node 24+ (`node:sqlite`). Full install / config / architecture docs in the [plugin README](dsh-mneme/README.md).

## Quick Config (Optional)

Works out of the box. Enable these as needed:

| Need | Config key | Default | Change |
|------|-----------|---------|--------|
| Fully offline | `embedProvider` | `openai` | Change to `local` |
| Keep memories when deleting sessions | `sessionLifecycleEnabled` | `false` | Change to `true` |
| Structured entity extraction | `entityExtractionEnabled` | `false` | Change to `true` |

> Change in DSH Settings Panel → Memory Settings. Full config docs [here](dsh-mneme/docs/CONFIG.md).

## Privacy

- Data stays on your machine only, never uploaded
- Memories are Markdown files, human-readable and editable
- Zero network dependency by default, no API Key required
- No telemetry, no analytics, no remote logging

## Docs

| Doc | Path |
|-----|------|
| Full plugin docs | [dsh-mneme/README.md](dsh-mneme/README.md) |
| Entity structure design | [dsh-mneme/docs/ENTITIES.md](dsh-mneme/docs/ENTITIES.md) |
| Semantic architecture | [dsh-mneme/docs/SEMANTIC.md](dsh-mneme/docs/SEMANTIC.md) |
| Local model guide | [dsh-mneme/docs/LOCAL_MODEL.md](dsh-mneme/docs/LOCAL_MODEL.md) |
| v0.1 migration | [dsh-mneme/docs/MIGRATION.md](dsh-mneme/docs/MIGRATION.md) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) |
| Security | [SECURITY.md](SECURITY.md) |

## 🗺️ Roadmap

```
🧬 Gene (v0.3.0) → 🛡️ Audit hardening (v0.3.6–0.3.9) → 💤 Sleep maintenance (v0.4.0) → 🕸️ Recall fusion & graph (v0.5.0) → ✨ Panel enhancements (v0.6.x) → 🌡️ Self-evolving memory (v0.7.0) → 🕸️ Graph enhancement (v0.8.0)
```

| Version | Theme | Status |
|---------|-------|--------|
| **v0.3.0** | Memory genome: entities/attrs/relations + timeline | ✅ |
| **v0.4.0** | Sleep Mode: idle 4-phase deep maintenance | ✅ |
| **v0.5.0** | Recall fusion & visualization: BM25 + graph + hot memory | ✅ |
| **v0.6.0** | Session lifecycle: delete session ≠ delete memories | ✅ |
| **v0.7.0** | Self-evolving memory: heat decay + sleep dual-protection + entity heat projection | ✅ |
| **v0.7.1** | Issue #31 fix: tags bridged to entity_attrs + autoTag panel toggle takes effect | ✅ |
| **v0.7.2** | Issue #35 delete button inline-confirm fix + Issue #34 inject current time at conversation start (opt-in) | ✅ |
| **v0.8.0** | Graph enhancement: interest drift + cross-workspace sharing | 🚧 Planned (late Sep) |

## 🧪 Local Development

```bash
cd dsh-mneme
npm install
npm test          # 770 tests
npm run stress    # three-axis stress test
npm run sync      # src → lib sync
```

## 📜 License

MIT
