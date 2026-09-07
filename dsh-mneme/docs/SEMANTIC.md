# dsh-mneme 语义增强架构 — 设计文档

- **日期**：2026-08-15
- **状态**：进行中（分支 `feat/local-semantic`）
- **范围**：为 dsh-mneme 增加"完全离线的语义记忆引擎"，覆盖本地 Embedding、Rerank 精排、autoDream 向量聚类三个阶段
- **相关文档**：[本地模型部署指南](LOCAL_MODEL.md) · [从 v0.1 升级说明](MIGRATION.md)

## 1. 背景与目标

dsh-mneme v0.1 已具备**可选的向量搜索**：通过 `/api/dsh-mneme/vector-config` 配置 OpenAI 兼容 `/embeddings` 端点，命中"字面不同但语义相近"的记忆；未配置或失败时降级为 LIKE 子串搜索。

v0.2 的目标是把这条**可选、依赖外部 API** 的向量链路升级为**默认可用、完全离线**的语义记忆引擎：

1. **本地 Embedding**：ONNX（`Xenova/bge-small-zh-v1.5`）或 Ollama，记忆向量不再依赖外网 API
2. **Rerank 精排**：向量初筛后交叉编码精排，把 Top-K 准确率再抬一档
3. **autoDream 语义增强**：对记忆向量做聚类，让自动巩固（去重/合并/冲突裁决）从"主题相近"升级为"语义相近"

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│                    语义引擎（v0.2，完全离线可选）                 │
├──────────────────────────────────────────────────────────────┤
│ ① Embedder 层（三选一，统一接口，可自动降级）                     │
│   LocalEmbedder(ONNX) │ OllamaEmbedder │ OpenAIEmbedder       │
│   init() / embed(texts) / embedSingle() / dimension / hash    │
├──────────────────────────────────────────────────────────────┤
│ ② VectorIndex 层                                               │
│   SQLite memories.embedding 列（JSON 向量）                     │
│   + 余弦相似度检索（score 0..1）+ 缺失向量增量补建 reindex       │
├──────────────────────────────────────────────────────────────┤
│ ③ Rerank 层（可选）                                            │
│   LocalReranker（Xenova/bge-reranker-base，交叉编码）            │
│   召回候选 → 精排 → Top-K                                       │
├──────────────────────────────────────────────────────────────┤
│ ④ autoDream 聚类（可选）                                       │
│   clusterMemories(向量 K-Means) / findPotentialConflicts       │
│   语义分组 + 疑似矛盾检测 → 巩固决策更精准                       │
└──────────────────────────────────────────────────────────────┘
```

- **① Embedder**：`src/local-embedder.js`，三后端统一接口，`createEmbedderByProvider(provider, opts)` 按名创建
- **② VectorIndex**：复用 v0.1 的 `memories.embedding` 列与 `store.js` 的余弦检索，无新存储层
- **③ Rerank**：`src/reranker.js`（Phase 2），可选开启
- **④ 聚类**：`src/dream/clustering.js`（Phase 3），autoDream 调度器集成

### 目录结构（新增/变化部分）

```
src/
├── local-embedder.js   # [新增] Local/Ollama/OpenAI 三 Embedder + createEmbedderByProvider
├── reranker.js         # [新增·Phase2] LocalReranker 交叉编码精排
├── dream/
│   └── clustering.js   # [新增·Phase3] clusterMemories / findPotentialConflicts / kMeans
└── embedding.js        # [保留] v0.1 OpenAI 兼容客户端（作为降级路径之一复用）
scripts/
├── benchmark-embed.js  # [新增] Embedding 吞吐量基准
└── benchmark-rerank.js # [新增] Rerank 延迟基准
docs/
├── SEMANTIC.md         # 本文档
├── LOCAL_MODEL.md      # 本地模型部署指南
└── MIGRATION.md        # 从 v0.1 升级说明
```

## 3. 搜索流水线

`memory_search` 在 v0.2 的完整链路（对应 `src/tools.js` 的 `mode: auto | keyword | vector`）：

```
                query
                  │
      ┌───────────┴───────────┐
      ▼                       ▼
 keyword 召回               vector 召回
 (LIKE 子串 title/        (Embedder.embed(query)
  content/tags)             → 余弦相似度 top-N
                            → 缺失向量自动补建)
      │                       │
      └───── 混合融合 ─────────┘
        (auto: 关键词命中优先 + 向量补足；分数归一化合并)
                  │
                  ▼
         [Rerank 开启？]
          ├─ 是 → LocalReranker.rerank(query, candidates, topK)
          │       交叉编码精排，取 topK
          └─ 否 → 按 importance/score 直接截取 topK
                  │
                  ▼
           memory_search 结果
```

- **召回阶段（候选）**：混合召回，宁多勿漏，候选集通常取向量 top-N（默认远超 Top-K，供精排筛选）
- **精排阶段（Rerank）**：对候选逐条打分（query 与候选的交互编码），取 Top-K
- **结果阶段**：返回条目 + `score`（召回分/精排分）+ `source` 时间戳，与 v0.1 返回结构保持一致

## 4. 模块接口

### 4.1 Embedder 统一接口（`src/local-embedder.js`）

三个后端共享同一接口，方法失败**抛错**，由上层编排降级链（与 v0.1 `embedding.js` 的"失败返回 null"不同）。

| 成员 | 说明 |
|------|------|
| `init()` | 加载模型 / 探测服务，失败抛错 |
| `embed(texts: string[])` | 批量嵌入，返回 `number[][]`（本地模型 mean pooling + L2 归一化） |
| `embedSingle(text)` | 单条嵌入 → `number[]` |
| `dimension` | 向量维度（getter） |
| `modelHash` | 模型指纹（`<model>#<hash>`），用于向量索引一致性校验，模型换名/换维度时提示重建索引 |
| `dispose()` | 释放模型资源 |

**LocalEmbedder（ONNX）**

```js
new LocalEmbedder({
  model: "Xenova/bge-small-zh-v1.5", // 默认；中文优化，全离线
  dimension: 512,                    // 默认与模型匹配
  device: "cpu",                     // cpu | wasm | gpu（onnxruntime 后端）
  batchSize: 8,                      // 分批嵌入，控制峰值内存
  cacheDir: "",                      // 自定义模型缓存目录，空则用 HF 默认缓存
  useDtype: "q8",                    // 量化精度 q8/fp32/fp16
  logger: null
})
```

**OllamaEmbedder**

```js
new OllamaEmbedder({
  baseUrl: "http://localhost:11434", // 默认
  model: "nomic-embed-text",         // 默认；维度从首次响应自动推断
  logger: null
})
```

**OpenAIEmbedder（兼容 v0.1 行为）**

```js
new OpenAIEmbedder({
  baseUrl: "",      // 例如 https://api.openai.com/v1，也支持 SiliconFlow/智谱/Ollama 代理
  apiKey: "",
  model: "",
  timeoutMs: 15000
})
```

**工厂**

```js
import { createEmbedderByProvider } from "../src/local-embedder.js";
const embedder = createEmbedderByProvider("local", { device: "cpu" }); // local | ollama | openai
await embedder.init();
const vecs = await embedder.embed(["你好", "记忆库"]);
```

### 4.2 Reranker（`src/reranker.js`，Phase 2）

| 成员 | 说明 |
|------|------|
| `constructor({ model, device, batchSize, cacheDir, logger })` | `model` 默认 `Xenova/bge-reranker-base` |
| `init()` | 加载交叉编码模型 |
| `rerank(query, candidates, topK?)` | 对候选逐条打分，返回按相关性降序的候选（附 `score`），`topK` 缺省返回全量排序 |

示例：

```js
import { LocalReranker } from "../src/reranker.js";
const reranker = new LocalReranker({ model: "Xenova/bge-reranker-base" });
await reranker.init();
const top = await reranker.rerank("怎么部署本地模型", candidates, 5);
```

### 4.3 autoDream 聚类（`src/dream/clustering.js`，Phase 3，已实现）

| 成员 | 说明 |
|------|------|
| `cosineSimilarity(a, b)` | 余弦相似度，零向量/长度不齐返回 0，数值稳定 |
| `kMeans(vectors, k, opts)` | K-Means（k-means++ 播种 + 空簇修复），返回每簇索引数组 |
| `clusterMemories(memories, vectors, k)` | 按向量把记忆分组，返回簇（保留原对象引用） |
| `findPotentialConflicts(memories, vectors, threshold = 0.85)` | 同类型、高相似（可能矛盾）的记忆对 |

autoDream 调度器在触发巩固时：对候选记忆做 `clusterMemories` 分组 → 每组送 LLM 决策（merge/archive/conflict），并用 `findPotentialConflicts` 预先标出疑似矛盾对，减少漏判。

## 5. 降级策略

```
       首选                   回退 1                  回退 2                 兜底
LocalEmbedder(ONNX) ──失败──► OllamaEmbedder ──失败──► OpenAIEmbedder ──失败/未配置──► 关键词 LIKE
```

- Embedder 方法**抛错**，由上层 `createEmbedderByProvider` 编排的降级链逐级捕获切换；全链路失败则回退到 v0.1 的 LIKE 子串关键词搜索（本库无 FTS5，关键词召回即 LIKE 子串扫描）
- **原则**：语义链路任何一环失败都**静默降级、不阻断记忆读写**——写入照常落库，只是当次不补向量
- **降级是每请求动态的**：同一会话内 ONNX 偶发失败，下一次请求自动重试首选路径，不固化到降级档
- **索引一致性**：Embedder 的 `modelHash` 变化（换模型/换维度）时，旧向量与新向量不可混算余弦，需触发「重建索引」（复用 v0.1 的 `reindexMissing` 补建缺失向量）

## 6. 模型清单

| 用途 | 模型 | 后端 | 维度 | 说明 |
|------|------|------|------|------|
| Embedding | `Xenova/bge-small-zh-v1.5` | ONNX（默认） | 512 | 中文优化，全离线，体积小 |
| Embedding | `bge-m3` | Ollama | 1024 | 多语言（中/英/日等），质量高 |
| Embedding | `nomic-embed-text` | Ollama | 768 | 英文为主，通用 |
| Embedding | `text-embedding-3-small` | OpenAI 兼容 | 1536 | v0.1 云端默认，升级后仍可用 |
| Rerank | `Xenova/bge-reranker-base` | ONNX（Phase 2） | — | 交叉编码，首候选精排 |
| Rerank | `bge-reranker-v2-m3` | 云/本地 | — | 更强精排，多语言 |

> 维度随模型而定：换用不同维度的模型后，已存向量与模型指纹不匹配，需重建索引。

## 7. 配置新增项

见 [MIGRATION.md](MIGRATION.md) 完整表格。核心：`embedProvider`（`local` / `ollama` / `openai`，默认 `openai` 保持 v0.1 行为）、`embedModel`、`embedDimension`、`embedDevice`、`embedBatchSize`、`embedCacheDir`、`rerankEnabled`、`rerankModel`。

## 8. 测试与基准

- 单元：`src/local-embedder.js` 三后端接口一致性、`clustering.js` 聚类正确性（node:test）
- 降级链：mock 各后端抛错，断言逐级回退到 LIKE
- 基准：`scripts/benchmark-embed.js`（嵌入延迟/吞吐）、`scripts/benchmark-rerank.js`（Rerank 延迟 vs 候选规模）

## 9. 反思更新（v0.2.1 `update` 决策 + 失败追踪）

### 9.1 `update` 决策类型

autoDream 整理时，LLM 可输出第 5 种决策 `update`，直接修正单条记忆的过时/错误内容：

- **约束**：`ids` 只能含一个 id；必须产生实际字段变化；不能更新 `summary`；新建 < 24h 的记忆不可 update
- **频率限制**：每次 autoDream 最多 `reflectionUpdateMaxPerRun`（默认 2）个 update，超限整单拒绝
- **幂等**：字段已与目标一致时跳过（可重放无副作用）
- **审计**：`dream_runs` 记录 update 的 `_before` 快照，可回溯变更前内容
- **向量同步**：update 后删除旧向量、按新内容重嵌入，保持索引一致

### 9.2 失败追踪（failure_memories）

`failure_memories` 表记录记忆纠正/失败事件，为后续反思进化积累数据：

```sql
CREATE TABLE failure_memories (
  id TEXT PRIMARY KEY,
  query TEXT,           -- 用户原始查询/意图（可选）
  expected TEXT,        -- 期望结果
  actual TEXT,          -- 实际结果
  failure_type TEXT,    -- outdated / miss / wrong / user_correction
  memory_id TEXT,       -- 关联的记忆 id
  created_at TEXT NOT NULL
);
```

- **触发**：用户调用 `memory_update` 且内容变化时，若 `reflectionFailureTracking` 开启则记录 `user_correction` 行（actual=旧值、expected=新值）
- **查询**：`store.listFailures`（过滤/分页）、`store.getFailureStats`（按类型计数）

### 9.3 配置项

```javascript
reflectionUpdateEnabled: true,       // update 决策总开关
reflectionFailureTracking: true,     // 失败追踪总开关
reflectionUpdateMaxPerRun: 2,        // 每次整理最多 update 数
reflectionUpdateMinAgeHours: 24      // 新建记忆保护期（小时）
```
