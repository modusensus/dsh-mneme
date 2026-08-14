<p align="center"><strong><a href="README.md">中文</a> | <a href="README_EN.md">English</a></strong></p>

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
  <a href="https://github.com/modusensus/dsh-mneme"><img src="https://img.shields.io/badge/tests-140%20passed-success" alt="tests"></a>
</p>

> **记忆主权，归还于你** —— 记忆不再是黑盒，而是你读得懂、改得动的 Markdown。

`dsh-mneme` 是一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件，为 Agent 提供持久的跨会话记忆能力。**Mneme**（Μνήμη）——希腊记忆女神 Mnemosyne 之名，掌管记忆与梦境，正如 autoDream 在后台巩固记忆。

不同于把记忆锁进数据库的插件，Mneme 把记忆**写成你读得懂的 Markdown**——你始终握着记忆的主权：看得见、改得动、删得掉，记忆这回事不该让 Agent 一个人说了算。

## ✨ 特性一览

- **🧠 记忆主权**：SQLite + **可人工编辑的 Markdown 镜像**，双向同步——记忆透明、可审查、归你所有
- **autoDream 梦境巩固**：后台自动去重 / 合并 / 归档 / 冲突裁决（fail-safe 校验），越用越精炼
- **6 个模型工具**：`memory_save` / `memory_search` / `memory_list` / `memory_update` / `memory_delete` / `memory_forget`
- **自动注入 + 会话摘要**：新会话自动带入相关记忆，会话结束自动提炼偏好 / 决策 / 教训
- **Web 记忆面板**：官方设置面板内嵌，按类型浏览、全文搜索 + 语义（向量）搜索
- **用户设置**：用户画像 + 行为规则，每轮注入系统提示
- **自定义指令**：注册斜杠命令（/名称），触发时交给 Agent
- **向量搜索**：接入 OpenAI 兼容 embeddings API，语义匹配字面不同但意思相近的记忆

## 📦 安装（DSH）

```bash
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
npm test          # 140 个测试
npm run sync      # src → lib 同步（发布时自动执行）
```

## 📄 文档

| 文档 | 路径 |
|------|------|
| 插件完整文档（功能 / 安装 / 配置 / 架构） | [dsh-mneme/README.md](dsh-mneme/README.md) |
| 插件设计 | [docs/superpowers/specs/2026-08-13-dsh-mneme-design.md](docs/superpowers/specs/2026-08-13-dsh-mneme-design.md) |
| autoDream 设计 | [docs/superpowers/specs/2026-08-13-dsh-mneme-autodream-design.md](docs/superpowers/specs/2026-08-13-dsh-mneme-autodream-design.md) |
| 实施计划（核心插件） | [docs/superpowers/plans/2026-08-13-dsh-memory.md](docs/superpowers/plans/2026-08-13-dsh-memory.md) |
| 实施计划（autoDream） | [docs/superpowers/plans/2026-08-13-dsh-memory-autodream.md](docs/superpowers/plans/2026-08-13-dsh-memory-autodream.md) |

## 📜 License

MIT
