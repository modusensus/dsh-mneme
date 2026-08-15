# dsh-mneme 开发日志：语义管线评审修复

> 2026-08-15 · v0.2.0 发布后，请 Kimi 对语义管线做了一轮代码评审，发现 5 处可改进点，逐项修复。

- 版本线：v0.2.0（已发布 npm）
- 测试：198 → **198**（全绿，无回归）
- 提交：`fix: address review findings on semantic pipeline`
- 仓库：github.com/modusensus/dsh-mneme

---

## 缘起：发布后的一轮独立评审

v0.2.0 发布到 npm 后，用 Kimi 对 `src/` 做了一次代码评审。评审报告按优先级列出 6 个问题，其中 5 个属实、1 个是误报（`npm run stress` 声称无实现，实际 `scripts/stress-dsh.js` 存在且可运行）。

逐项核实后修复了 5 个真问题：

## 问题与修复

### 1. api `/search` 端点仍走旧逻辑（🔴 高）

`/api/dsh-mneme/search` 用的还是 `service.search` + `service.searchVector` 手动拼接，没走新的统一管线 `service.searchMemories`。工具层 `memory_search` 早已切换，API 层漏了。

**修复**：API handler 改为路由到 `searchMemories`，支持 `mode=vector/hybrid/keyword` 和 `rerank` 开关；mode 通过返回行是否带 `vector:true` 标记判断实际走的路径。

### 2. vector-reindex 调用不存在的 `reindexMissing`（🔴 高）

`reindexMissing` 只存在于旧的 OpenAI embedder（`embedding.js`）。切换到 `local`/`ollama` 后没有这个方法，重建索引会静默失败。

**修复**：统一改走 `vectorIndex.rebuildIndex(embedder, { limit })`——对新旧 embedder 都有效，旧路径（`embedder.reindexMissing`）保留作兜底。

### 3. reranker `_queryVec` 缓存未按 query 失效（🟡 中）

feature-extraction 策略把 query 向量缓存在 `_queryVec`，但只判断"是否已有"，**换一个 query 不会重算**——会拿上一个 query 的向量去比对新 passage，结果全错。

**修复**：新增 `_queryKey` 记录 query 字符串，query 变化时重算并更新缓存。

### 4. `hybridSearchVectorWeight` 配置定义了但未使用（🟡 中）

config 里配了 `hybridSearchVectorWeight`（0.6）/ `hybridSearchKeywordWeight`（0.4），但 hybrid 模式没用到。

**修复**：hybrid 模式下，同一记忆同时命中向量和关键词时用权重融合分数；只命中一侧则取该侧分数。按融合分数降序取 Top-K。

### 5. keyword 结果无 score，无法参与加权混合（🟢 低）

`store.search` 返回的行没有分数，导致 keyword 补位的结果在混合排序里"无分可比"。

**修复**：`scoreKeyword()` 给 keyword 行算启发式分数——标题命中 > 内容命中 > 标签命中，再按重要性（1-5）加权，归一化到 [0,1]。这样 keyword 结果有统一的 score，能参与 hybrid 加权融合。

### 6. `npm run stress` 无实现（🟢 低）→ 误报，未修

评审认为 stress 脚本不存在。实际 `scripts/stress-dsh.js` 存在，`node scripts/stress-dsh.js` 能正常跑三轴线压测。**未改动**。

## 测试

全量 **198 / 198 通过**，无回归。修复过程中 api 的两个 search 测试一度失败（handler 未返回 promise 导致响应未写入），已确认修复——search handler 现在返回 promise，异步响应可被 await。

## 待办（给桉桉）

- 建议补充评审报告中点名的测试：reranker 三策略降级、clustering 聚类质量、vector-index modelHash 漂移、searchMemories 端到端。当前已有 semantic.test.js 覆盖 searchMemories 各 mode + 降级，但 reranker/clustering/vector-index 的专项断言可再加。

---

*—— Ivresse（桉桉的 Ivresse），2026-08-15*
