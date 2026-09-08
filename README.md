<p align="center">
  <img src="横幅.png" alt="dsh-mneme banner" width="100%" />
</p>

<h1 align="center">dsh-mneme</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@modusensus/dsh-mneme"><img src="https://img.shields.io/npm/v/@modusensus/dsh-mneme?style=flat-square&color=3E63DD&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@modusensus/dsh-mneme"><img src="https://img.shields.io/npm/dm/@modusensus/dsh-mneme?style=flat-square&color=3E63DD&label=downloads" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3E63DD?style=flat-square" alt="license"></a>
  <a href="https://github.com/modusensus/dsh-mneme/actions"><img src="https://img.shields.io/github/actions/workflow/status/modusensus/dsh-mneme/ci.yml?style=flat-square&label=CI" alt="CI"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-24%2B-3E63DD?style=flat-square&logo=nodedotjs&logoColor=white" alt="node"></a>
  <a href="https://github.com/modusensus/dsh-mneme"><img src="https://img.shields.io/badge/tests-662%20passed-3E63DD?style=flat-square" alt="tests"></a>
  <a href="https://codecov.io/gh/modusensus/dsh-mneme"><img src="https://img.shields.io/codecov/c/github/modusensus/dsh-mneme/main?style=flat-square" alt="coverage"></a>
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="Awesome"></a>
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

> 在 DSH 设置面板 → 记忆库设置 中修改。完整配置说明见 [配置章节](dsh-mneme/README.md)。

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
| 版本历史 | [dsh-mneme/CHANGELOG.md](dsh-mneme/CHANGELOG.md) |
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
| **v0.7.3** | issue #38 左下角入口按钮可选开关 `showSidebarTrigger` | ✅ |
| **v0.7.4** | issue #40 记忆花括号转义 + issue #41 记忆窗口关闭按钮重叠修复 | ✅ |
| **v0.7.5** | 分层记忆类型 user/fact + Web 总览视图 + stats 端点 | ✅ |
| **v0.7.6** | issue #48 修复：截断/前缀 id 也能精确操作（统一 resolveMemoryId）+ client.js 改 src 正源 | ✅ |
| **v0.7.7** | issue #23 图谱回填：sleep 批量实体抽取 phase + node:sqlite 兼容修复 | ✅ |
| **v0.7.8** | issues #58 #59 修复：DSH 0.1.2-rc.1 兼容——Session.events 改为 snapshotEvents() 垫片，autoSummarize 与 hot-context 注入恢复 | ✅ |
| **v0.7.9** | issue #65 修复：v0.7.8 的 snapshotEvents 适配只改了 src/ 未同步 npm 实际加载的 lib/——补齐 lib 并加发布前 src/lib 一致性校验（check-sync.js 闸门）+ lib 冒烟测试 | ✅ |
| **v0.7.10** | Web 面板体验升级：记忆类型色点体系 + 图谱画布平移/缩放 + 设置页分区重排 + 侧边栏同标签冲突修复 + 只读端点 /entities | ✅ |
| **v0.7.11** | 记忆库面板改版：按月分页无限滚动 + 搜索全局化 + 30s 静默刷新 + 删除两步确认 + issue #72/#59 修复 | ✅ |
| **v0.7.12** | 近重写：内置面板改纯 HTTP API（Bearer 鉴权）+ 独立 CLI dsh-mneme + 轻量模式 lightMode；记忆类型收窄（删 user/fact） | ✅ |
| **v0.7.13** | 编码记忆蒸馏 codingRetrospect（新增 rejected_solution/pitfall/constraint 三类型）+ 蒸馏 429 调速器（指数退避重试） | ✅ |
| **v0.7.14** | 安全修复（CWE-200）：蒸馏不再采集私有 reasoning 块，只采公开 text | ✅ |
| **v0.7.15** | 桌面端适配：记忆库面板重设计 + 功能开关 30 键 UI + 状态页工作台 + 导入导出 | ✅ |
| **v0.7.16** | 修复 autoDream 在 thinking 模型上空体 failed：恢复 config-first 路由 + reasoningEffort 被拒自动回退 + 解析失败如实记账；补测 API 路由空白与 lib 运行时冒烟 | ✅ |
| **v0.8.0** | 图谱增强：兴趣漂移可视化 + scope 隔离（issue #17）+ 跨 workspace 共享 | 🚧 计划中（9 月末） |

## 🧪 本地开发

```bash
cd dsh-mneme
npm install
npm test          # 662 个测试
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

> Change in DSH Settings Panel → Memory Settings. Full config docs in the [Configuration section](dsh-mneme/README.md).

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
| Changelog | [dsh-mneme/CHANGELOG.md](dsh-mneme/CHANGELOG.md) |
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
| **v0.7.3** | Issue #38 optional sidebar trigger `showSidebarTrigger` | ✅ |
| **v0.7.4** | Issue #40 prompt-brace escaping + Issue #41 overlay close-button overlap fix | ✅ |
| **v0.7.5** | Layered memory types (user/fact) + Overview view + stats endpoint | ✅ |
| **v0.7.6** | Issue #48 fix: truncated/prefix ids resolve for exact ops (unified resolveMemoryId) + client.js now src-authored | ✅ |
| **v0.7.7** | Issue #23 graph backfill: sleep batch entity extraction phase + node:sqlite compat fix | ✅ |
| **v0.7.8** | Issues #58 #59 fix: DSH 0.1.2-rc.1 compat — Session.events moved to snapshotEvents() shim; autoSummarize & hot-context injection restored | ✅ |
| **v0.7.9** | Issue #65 fix: v0.7.8's snapshotEvents shim only landed in src/, never in the npm-loaded lib/ — synced lib + added a pre-publish src↔lib consistency gate (check-sync.js) + lib smoke tests | ✅ |
| **v0.7.10** | Web panel UX: memory-type color dots + graph canvas pan/zoom + settings re-grouping + sidebar tab-conflict fix + read-only /entities endpoint | ✅ |
| **v0.7.11** | Library panel redesign: monthly pagination + infinite scroll + global search + 30s silent refresh + two-step delete + issues #72/#59 fixes | ✅ |
| **v0.7.12** | Near-rewrite: inlined panel replaced by a pure HTTP API (Bearer auth) + standalone CLI + lightMode; memory types narrowed (user/fact dropped) | ✅ |
| **v0.7.13** | Coding-memory distillation `codingRetrospect` (+ rejected_solution/pitfall/constraint types) + 429 governor (exponential backoff) | ✅ |
| **v0.7.14** | Security fix (CWE-200): distillation no longer collects private `reasoning` blocks, only public `text` | ✅ |
| **v0.7.15** | Desktop adaptation: library panel redesign + 30-key feature-flag UI + status dashboard + import/export | ✅ |
| **v0.7.16** | Fix autoDream empty-body failures on thinking models: restore config-first routing + reasoningEffort auto-fallback + honest audit on parse failure; backfill API-route & lib smoke tests | ✅ |
| **v0.8.0** | Graph enhancement: interest-drift visualization + scope isolation (issue #17) + cross-workspace sharing | 🚧 Planned (late Sep) |

## 🧪 Local Development

```bash
cd dsh-mneme
npm install
npm test          # 662 tests
npm run stress    # three-axis stress test
npm run sync      # src → lib sync
```

## 📜 License

MIT
