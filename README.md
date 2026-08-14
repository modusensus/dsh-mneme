# dsh-mneme

[![npm version](https://img.shields.io/npm/v/@modusensus/dsh-mneme?color=blue&label=npm)](https://www.npmjs.com/package/@modusensus/dsh-mneme)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Awesome](https://awesome.re/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![tests](https://img.shields.io/badge/tests-136%20passed-success)](https://github.com/modusensus/dsh-mneme)

> 给 DeepSeek Harness 的跨会话记忆插件：让 Agent 记住你、记住项目、自动整理记忆。**Mneme**（Μνήμη）——希腊记忆女神 Mnemosyne 之名，掌管记忆与梦境，正如 autoDream 在后台巩固记忆。

`dsh-mneme` 是一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件，为 Agent 提供持久的跨会话记忆能力。借鉴 Claude 的 **Dream 机制** 与 **autoDream** 思路——不仅存储记忆，还会自动巩固（去重、合并、冲突裁决、摘要生成），让记忆库越用越精炼。

## ✨ 特性一览

- **SQLite + Markdown 镜像**：`node:sqlite` 零原生依赖存储；记忆库可人工编辑、双向同步
- **6 个模型工具**：`memory_save` / `memory_search` / `memory_list` / `memory_update` / `memory_delete` / `memory_forget`
- **自动注入 + 会话摘要**：新会话自动带入相关记忆，会话结束自动提炼偏好 / 决策 / 教训
- **autoDream 🧠**：后台自动去重 / 合并 / 归档 / 冲突裁决（fail-safe 校验），越用越精炼
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
npm test          # 136 个测试
npm run sync      # src → lib 同步（发布时自动执行）
```

## 📄 文档

| 文档 | 路径 |
|------|------|
| 插件完整文档（功能 / 安装 / 配置 / 架构） | [dsh-mneme/README.md](dsh-mneme/README.md) |
| 记忆库设计 | [docs/superpowers/specs/2026-08-13-dsh-memory-design.md](docs/superpowers/specs/2026-08-13-dsh-memory-design.md) |
| autoDream 设计 | [docs/superpowers/specs/2026-08-13-dsh-memory-autodream-design.md](docs/superpowers/specs/2026-08-13-dsh-memory-autodream-design.md) |
| 实施计划 | [docs/superpowers/plans/2026-08-13-dsh-memory-autodream.md](docs/superpowers/plans/2026-08-13-dsh-memory-autodream.md) |

## 📜 License

MIT
