# dsh-mneme v0.3.x → v0.4.0（系统级睡眠 Sleep Mode）升级说明

- **日期**：2026-08-17
- **适用范围**：从 v0.3.9（审计加固）升级到 v0.4.0（Sleep Mode）
- **目标**：**零配置迁移、零数据损失**。升级后默认不启用 Sleep（opt-in），原行为完全不变。

## 1. 数据兼容（自动迁移，无需手工操作）

### 1.1 SQLite 记忆库

- **memories 表新增两列**（幂等迁移，`PRAGMA table_info` 检查 + `ALTER TABLE ... ADD COLUMN`）：
  - `last_accessed_at TEXT` — 最后召回时间戳（搜索/注入路径自动 touch）
  - `_full_content TEXT` — 冷记忆降级时的原文存档（压缩后内容可在原处恢复）
- **dream_runs 表新增一列**：`run_type TEXT NOT NULL DEFAULT 'auto'` — `auto`（autoDream）/ `sleep`（睡眠周期）审计区分
- 已有数据不受影响；降级/归档只在 `sleepModeEnabled: true` 后按阈值触发

### 1.2 镜像与审计

- Markdown 镜像格式不变；`demoteToSummary`/`restoreContent` 走正常写钩子（镜像重渲染），`touchLastAccess` 是读戳（不触发写钩子，避免脏镜像）
- 既有 `dream_runs` 审计记录保留；睡眠周期新增 `run_type='sleep'` 记录，与 autoDream 共用审计表

## 2. 配置变更（全部 opt-in）

### 2.1 新增配置项

| 键 | 默认值 | 说明 |
|----|--------|------|
| `sleepModeEnabled` | `false` | 总开关，开启后才激活睡眠调度器 |
| `sleepIdleMinutes` | `5` | 连续空闲多少分钟触发睡眠周期 |
| `sleepMinIntervalHours` | `8` | 两次睡眠周期的最小间隔（小时） |
| `sleepConflictStrictness` | `'normal'` | 冲突消解严格度：`gentle`(0.92) / `normal`(0.85) / `aggressive`(0.75) |
| `sleepArchiveDays` | `30` | 多少天未召回 → 压成摘要（`_full_content` 存档） |
| `sleepCompressDays` | `90` | 多少天未召回 → 完全归档 |
| `sleepPatternMinMemories` | `100` | 模式发现扫描的最近记忆条数 |
| `sleepPatternLookbackDays` | `30` | 模式发现回溯天数 |
| `sleepMaxPatternPerRun` | `3` | 单次睡眠周期最多产出的模式数 |
| `sleepProvider` / `sleepModel` | `''` | 睡眠专用 LLM 路由（留空复用默认） |

### 2.2 行为变更说明

- **零配置升级**：不设任何 sleep 配置 → 与 v0.3.9 行为完全一致，无新增后台任务
- **首次启用**：设 `sleepModeEnabled: true` 后，系统空闲 `sleepIdleMinutes` 分钟触发首次深度维护
- **推荐起步**：`sleepConflictStrictness: 'gentle'` 观察裁决质量后再收紧

---

# dsh-mneme v0.1 → v0.2（语义增强）升级说明

- **日期**：2026-08-15
- **适用范围**：从 npm `@modusensus/dsh-mneme` v0.1.x（LIKE 搜索 + 可选 OpenAI 兼容向量）升级到 v0.2（本地语义引擎）
- **目标**：**零配置迁移、零数据损失**。升级后不设置任何新配置项，行为与 v0.1 完全一致；想要本地语义能力只需新增几行配置。

## 1. 数据兼容（自动迁移，无需手工操作）

### 1.1 SQLite 记忆库

- **不重建、不导出**：沿用同一 `~/.dsh/memory/memory.db`，现有 `memories` 表直接复用
- **schema 迁移幂等**：v0.1 已通过 `PRAGMA table_info` 检查 + `ALTER TABLE ... ADD COLUMN` 幂等补齐 `embedding` / `archived` 等列；v0.2 沿用同一机制，重复启动/旧版本回退都不会重复加列或破坏数据
- **现有向量兼容**：`memories.embedding` 存 JSON 向量（TEXT 列），v0.2 直接读取，已嵌入的记忆**无需重新嵌入**
- **用户设置保留**：v0.1 在 `user_settings` 表配置的向量端点（baseUrl/apiKey/model）保留，作为降级路径继续可用

### 1.2 Markdown 镜像

- 七个 `.md` 镜像文件（`preferences.md` / `projects.md` / `decisions.md` / `history.md` / `summary.md` / `user.md` / `facts.md`）格式不变，双向同步、人工优先的规则不变（v0.7.5 起新增 user/fact 两个分层镜像）
- 升级后首次启动仍执行"读取人工编辑 → 合并回库"，无竞态（先全量读取再统一合并）

### 1.3 dream_runs 审计表

- 既有审计记录保留；新格式与 v0.1 兼容（snapshot digest + 决策清单 + receipt），无需迁移

## 2. 配置变更

### 2.1 新增配置项

| 键 | 默认值 | 说明 |
|----|--------|------|
| `embedProvider` | `openai` | 嵌入后端：`local`（ONNX）\| `ollama` \| `openai` |
| `embedModel` | 空 | 模型名：local=HF 模型 id（`Xenova/bge-small-zh-v1.5`），ollama=Ollama 模型，openai=API 模型 |
| `embedDimension` | 空 | 向量维度；不填则按后端推断（local 默认 512，ollama/openai 首次响应推断） |
| `embedDevice` | `cpu` | 仅 local 生效：`cpu` \| `wasm` \| `gpu` |
| `embedBatchSize` | `8` | 分批嵌入条数（local/openai 生效） |
| `embedCacheDir` | `""` | 仅 local 生效：模型缓存目录，空=HF 默认缓存 |
| `embedBaseUrl` | `""` | ollama 默认 `http://localhost:11434`；openai 必填 |
| `embedApiKey` | `""` | 仅 openai 生效 |
| `rerankEnabled` | `false` | 是否启用 Rerank 精排（Phase 2） |
| `rerankModel` | `Xenova/bge-reranker-base` | Rerank 模型 |

### 2.2 默认值 = 保持 v0.1 行为

- `embedProvider` 默认 `openai`，且 `embedBaseUrl` / `embedApiKey` / `embedModel` 为空时，**行为与 v0.1 完全一致**：使用 `user_settings` 表里通过 Web/API 配置的 `vector-config`（若配置过），否则 LIKE 关键词搜索
- 也就是说：**什么都不改，升级后一切照旧**；想让语义搜索离线化，把 `embedProvider` 改成 `local` 或 `ollama` 即可

### 2.3 行为变化

| 场景 | v0.1 | v0.2 |
|------|------|------|
| 未配置任何向量 | LIKE 子串搜索 | LIKE 子串搜索（不变） |
| 配置 OpenAI 兼容端点 | 调 `/embeddings`，失败返回 null 静默 | 同，但 `OpenAIEmbedder` 批量嵌入、抛错由降级链处理 |
| 本地模型 | 不支持 | `embedProvider: local` / `ollama` |
| 向量初筛结果 | 直接返回 | 可经 `rerankEnabled` 精排后返回 |
| 搜索模式 | `auto` / `keyword` / `vector` | 不变，`auto` 新增混合召回 |

## 3. 向后兼容保证

1. **数据兼容**：SQLite、Markdown 镜像、审计表全部沿用，升级与回退都不丢数据
2. **配置兼容**：v0.1 的全部配置键（`memoryDir`、`autoInject`、`autoDream` 等）不变；新增键全部带默认值
3. **API 兼容**：`memory_*` 工具、Web 面板路由、`vector-config` 端点不变；`memory_search` 返回结构不变（额外多出可选 `score`）
4. **降级兼容**：本地 Embedder 加载失败 / 下载失败 / 推理异常，自动降级到 Ollama → OpenAI → LIKE 关键词，**任何失败都不阻断记忆读写**
5. **索引一致**：`modelHash` 与向量维度不匹配时拒绝混算，提示重建索引（不静默产生错误结果）
6. **回滚安全**：卸载 v0.2 装回 v0.1.x，库文件仍可正常读写（v0.1 能识别 `embedding` 列）

## 4. 升级步骤

```bash
# 1. 升级插件
dsh plugin --profile web update @modusensus/dsh-mneme

# 2. （可选）启用本地语义：编辑 ~/.dsh/profiles/web/cordis.patch.yml
#    - id: dsh-mneme
#      config:
#        embedProvider: local
#        embedModel: Xenova/bge-small-zh-v1.5

# 3. 重启并验证
dsh web
# 首次本地使用自动下载模型；确认日志出现 "local embedder ready"
```
