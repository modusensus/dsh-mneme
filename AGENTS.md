# AGENTS.md — 给维护者、贡献者与 AI agent 的项目入口

dsh-mneme 是 DSH 宿主的记忆插件（蒸馏 / 注入 / 检索 / 巩固 / scope 隔离）。本文件是模块地图与闸门清单：接手任何 PR 之前先读这里，改完结构顺手更新这里。

## 仓库布局

- `dsh-mneme/` — 包本体
  - `src/` — 源码（唯一手写处）
  - `lib/` — **同步产物，禁止手改**：`npm run sync` 从 src 生成，`scripts/check-sync.js` 锁平价
  - `test/` — `node --test`（`npm test`）
  - `scripts/` — 同步、徽章、基准与压测脚本
- 仓库根 — README（双语）、CHANGELOG、CONTRIBUTING、docs/

## 模块地图（按功能面）

| 功能面 | 文件 | 一句话 |
|---|---|---|
| 宿主挂载入口 | `src/index.js` | ctx 接线、memoryDir 解析、各管线启动、实体抽取触发点 |
| 存储 | `src/store.js` | SQLite schema（memories / 实体三表 / dream_runs / recall_runs / 审计表）、幂等迁移 |
| 服务层 | `src/service.js` | saveWithDedupe（去重键 type+title+scope 三元组）、fuseRecall 检索融合（keyword/vector/bm25/entity）、注入候选、镜像同步、冲突队列 |
| 注入 | `src/inject.js` | 注入位构造、内容截断、跨轮轮换 |
| 蒸馏 | `src/summarize.js` + `src/quality-filter.js` | 会话 → 记忆；质量打分与处置（归档/降权） |
| 巩固与睡眠 | `src/dream.js` + `src/dream/{decisions,clustering,sleep}.js` | LLM 巩固决策、dream_runs 审计回执 |
| 实体 | `src/entities/extractor.js`（存储侧在 store 三表） | 写入时 LLM 抽取实体/属性/关系 |
| 检索辅助 | `src/search/{bm25,adaptive}.js`、`src/vector-index.js`、`src/embedding.js`、`src/local-embedder.js`、`src/reranker.js` | BM25 / 自适应阈值 / 向量索引 / 嵌入 / 重排 |
| 热度 | `src/heat.js` | 纯函数遗忘曲线（opt-in） |
| 冷启动 | `src/bootstrap.js` | 从仓库文件反向构建初始记忆（POST /bootstrap） |
| 配置 | `src/config.js`（schema + lightMode）、`src/settings.js`（feature flags 白名单） | 一切行为开关的家 |
| API 面 | `src/api.js`（宿主内 /api/dsh-mneme/*）、`src/api-standalone.js`（Bearer 数据面）、`bin/dsh-mneme-mcp.mjs`（MCP stdio） | 对外三张脸 |
| 面板 | `lib/client.js` | 面板侧产物，无 src 对应物 |
| 运行时 | `src/runtime/*` | 模型下载（断点续传）/ 校验 / adopt |
| 命令 | `src/commands.js` | 斜杠命令注册与派发 |
| 双语 | `src/lang.js` | 文案与语言解析 |

## 新改动自查清单

1. 行为开关一律 **opt-in 默认关** + `settings.js` 白名单注册 + 考虑 lightMode（`config.js` 的 `LIGHT_MODE_OFF`）；
2. 新配置键：`config.js` schema 与 `settings.js` 白名单**成对出现**，`test/api.test.js` 的旗标计数锁要同步 +1；
3. 改 `src/` 必跑 `npm run sync`（lib-smoke 测试会抓未同步）；
4. 新行为必须带回归测试；schema 变更配幂等迁移（PRAGMA 检查 + ALTER，存量库启动即建）；
5. **防御段改动要保守**：幂等迁移、单调时间戳、scope 归一化、审计 receipt——都是踩坑沉淀，动前先读注释；
6. 提交署名可归属与 AI 内容核验义务见 [CONTRIBUTING](CONTRIBUTING.md)（硬性要求）。

## 闸门清单

- `npm test`（CI 矩阵：ubuntu + windows × node 22/24）
- check-sync（src ↔ lib 平价）
- CodeRabbit 自动评审（每个 PR）
- codecov 补丁覆盖率
- CONTRIBUTING 署名要求

## 尺寸约定与拆分方向（2026-09 讨论 #221）

- 单文件参考线约 **2000 行**；超线文件被功能改动碰到时，顺手把一个内聚块拆出去（advisory，不拦合并）；
- 拆法：原文件保留为 barrel 出口、调用方零改动；纯搬移走独立 PR；防御段最后动或不动；
- **前置**：`scripts/sync-lib.js` 支持子目录映射之后，才可做 store/ 目录化这类拆分（否则平价锁误伤纯搬移）；
- 已知热点：`src/store.js`、`src/service.js`、`lib/client.js`。
