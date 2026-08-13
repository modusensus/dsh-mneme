# dsh-mneme

[![npm version](https://img.shields.io/npm/v/@modusensus/dsh-mneme?color=blue&label=npm)](https://www.npmjs.com/package/@modusensus/dsh-mneme)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-awesome-orange)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![tests](https://img.shields.io/badge/tests-104%20passed-success)](https://github.com/modusensus/dsh-mneme)

> 给 DeepSeek Harness 的跨会话记忆插件：让 Agent 记住你、记住项目、自动整理记忆。**Mneme**（Μνήμη）——希腊记忆女神 Mnemosyne 之名，掌管记忆与梦境，正如 autoDream 在后台巩固记忆。

`dsh-mneme` 是一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件，为 Agent 提供持久的跨会话记忆能力。它借鉴了 Claude 的 **Dream 机制** 与 cc-haha / Claude Code 的 **autoDream** 实现思路——不仅**存储**记忆，还会**自动巩固**（去重、合并、冲突裁决、摘要生成），让记忆库越用越精炼。

## ✨ 功能

### 记忆存储（SQLite + Markdown 镜像）

- **SQLite 主存储**：`~/.dsh/memory/memory.db`，`node:sqlite` 内置，零原生依赖
- **Markdown 镜像**：`preferences.md` / `projects.md` / `decisions.md` / `history.md` / `summary.md`，人类可读、可手工编辑（**人工修改优先**合并回库）
- **4+1 种记忆类型**：`preference`（偏好）/ `project`（项目）/ `decision`（决策）/ `history`（历史）/ `summary`（总览）

### 模型工具（6 个）

| 工具 | 功能 |
|------|------|
| `memory_save` | 记录一条记忆（自动按标题去重合并） |
| `memory_search` | 全文搜索（中文子串友好） |
| `memory_list` | 按类型分页列出 |
| `memory_update` | 修改已有记忆 |
| `memory_delete` | 删除记忆 |
| `memory_forget` | 抑制注入（降权不删除，可恢复） |

### 自动注入 + 会话摘要

- **自动注入**：新会话开局注入记忆摘要（`summary` 优先 + 少量高重要性条目）
- **会话摘要**：`turn/end` 时用 LLM 提炼本次会话的偏好/决策/教训，自动入库（过滤 plugin 注入上下文，避免污染）

### autoDream 自动记忆整理 🧠

- **触发**：记忆数 > 10 或总字符 > 5000 时，异步自动触发（不阻塞写入）
- **决策清单式整理**：LLM 输出 `keep` / `merge` / `archive` / `conflict` 决策清单，服务端校验后逐条应用
  - `merge`：合并主题相近的条目，保留信息最完整者
  - `archive`：归档过时/冗余条目（可恢复，不物理删除）
  - `conflict`：裁决矛盾信息，胜者保留、败者归档并追加溯源注释
- **摘要生成**：整理后生成"记忆库总览"（单一实例），作为下次会话的优先注入
- **Fail-safe**：非法 LLM 输出（未知 id / 非法 action / 跨类型合并 / 越界 importance）拒绝整单，绝不破坏记忆库

### Web 记忆面板

侧边栏"记忆"按钮 → 模态面板：按类型浏览、全文搜索、查看详情。

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
| `maxInjectedItems` | `5` | 最多注入几条记忆 |
| `importanceThreshold` | `3` | 注入的最低重要性（1-5） |
| `autoDream` | `true` | 自动记忆整理开关 |
| `dreamThresholdCount` | `10` | 触发整理的记忆条数阈值 |
| `dreamThresholdChars` | `5000` | 触发整理的总字符阈值 |
| `dreamDelayMs` | `2000` | 整理异步延迟（去抖） |
| `dreamProvider` / `dreamModel` | 空 | dream 的 LLM 路由回退（默认用 agent 默认模型） |

## 🏗️ 架构

```
┌─────────────────────────────────────────────────┐
│  存储层：SQLite (archived/forgotten 状态)         │
│         + Markdown 镜像（人工可编辑，双向同步）    │
├─────────────────────────────────────────────────┤
│  服务层：saveWithDedupe / injectCandidates        │
│         / mergeHumanEdits / onWrite 钩子          │
├─────────────────────────────────────────────────┤
│  模型接口：6 个工具 + 自动注入 + 会话摘要          │
├─────────────────────────────────────────────────┤
│  autoDream：阈值调度 → LLM 决策清单               │
│            → 校验（fail-safe）→ 应用 → 摘要       │
├─────────────────────────────────────────────────┤
│  Web 面板：侧边栏入口 + 浏览/搜索/详情            │
└─────────────────────────────────────────────────┘
```

**源码结构**：

```
src/
├── store.js          # SQLite 存储（CRUD、搜索、归档/遗忘、schema 迁移）
├── mirror.js         # Markdown 镜像（渲染/解析，人工优先）
├── service.js        # 领域逻辑（去重合并、注入筛选、写入钩子）
├── config.js         # schemastery 配置 schema
├── tools.js          # 6 个模型工具（defineTool）
├── inject.js         # systemPrompt.context 动态注入
├── summarize.js      # 会话结束 LLM 摘要
├── dream.js          # autoDream 调度 + runDream（LLM 决策 + 摘要）
├── dream/decisions.js# 决策校验（fail-safe）+ 决策应用
├── api.js            # HTTP 路由（Web 面板数据通道）
└── index.js          # 插件接线
lib/
├── client.js         # Web 面板（手写 ModuleLoader bundle）
└── *.js              # src 的同步分发产物
test/                 # 104 个 node:test 测试
```

## 🧪 开发

```bash
cd dsh-mneme
node --test --test-isolation=none test/*.test.js
```

> 注：`--test-isolation=none` 用于受限沙箱（禁止子进程 spawn）；普通环境可直接 `node --test`。

## 📄 设计文档

- [记忆库设计](docs/superpowers/specs/2026-08-13-dsh-memory-design.md)
- [autoDream 设计](docs/superpowers/specs/2026-08-13-dsh-memory-autodream-design.md)
- [实施计划](docs/superpowers/plans/2026-08-13-dsh-memory-autodream.md)

## 📜 License

MIT
