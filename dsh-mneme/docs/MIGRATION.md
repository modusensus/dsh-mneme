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

- 五个 `.md` 镜像文件（`preferences.md` / `projects.md` / `decisions.md` / `history.md` / `summary.md`）格式不变，双向同步、人工优先的规则不变
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
