# dsh-mneme 开发日志：第三方代码审查与修复

> 2026-08-15 · 语义引擎 v0.2.0 发布后，让 Kimi 做了一次独立代码审查，发现 6 个问题（3 个高优先、2 个中优先、1 个误报）。全部核实后修复 5 个真问题，测试保持全绿。

- 版本线：v0.2.0（已发布）
- 测试：198 / 198（修复后仍全绿）
- 仓库：github.com/modusensus/dsh-mneme

---

## 缘起：第二双眼睛

v0.2.0 发布后，桉桉让 Kimi 检查了一遍代码。独立审查的价值在于——我们自己写的代码会有"惯性思维"，容易漏掉接口脱节、未使用配置这类问题。Kimi 报告了 6 个问题，我逐个核实、分类、修复。

## 问题清单与处置

### 🔴 高优先

**1. api.js search 端点仍用旧逻辑，未对接 searchMemories**
- **问题**：`/api/dsh-mneme/search` 还走旧的 `service.search` + `service.searchVector` 双路合并，没走语义升级后的 `searchMemories`（工具端已改，API 端漏了）
- **修复**：改为调 `service.searchMemories`，支持 `mode`（auto/keyword/vector/hybrid）+ `rerank` 参数
- **坑**：handler 必须 `return` 那个 Promise，否则测试 `await route.handler(...)` 拿到的是同步返回，res.body 还是空的

**2. vector-reindex 调用 embedder.reindexMissing() 不存在**
- **问题**：新加的 Local/Ollama embedder **没有** `reindexMissing` 方法（那是旧 OpenAI embedder 专属），切到本地模型时重建索引会崩
- **修复**：统一走 `vectorIndex.rebuildIndex()`，兼容新旧后端

### 🟡 中优先

**3. reranker _queryVec 缓存未按 query 失效**
- **问题**：feature-extraction 策略缓存了 query 向量，但**换 query 后不重算**——第二次 rerank 会用旧 query 的向量比对新 passage，结果错
- **修复**：记录 `_queryKey`，query 变化时重新计算

**4. hybridSearchVectorWeight 配置定义但未使用**
- **问题**：config 里定义了 `hybridSearchVectorWeight` / `hybridSearchKeywordWeight`，但 service 的 hybrid 模式没做加权
- **修复**：hybrid 合并时按权重做加权混合（同一记忆来自双路时 `score = vector*0.6 + keyword*0.4`）

**5. npm run stress 有声明但无实现脚本 —— 误报**
- **核实**：`scripts/stress-dsh.js` 存在且能正常运行（三轴线压测实测通过）。Kimi 未看到脚本文件，误判。**无需修复**

### 🟢 低优先

**6. 混合搜索时 keyword 结果无 score**
- **问题**：keyword 结果不带 score，无法参与加权/统一报告
- **修复**：给 keyword 结果补启发式 score（标题命中 > 内容命中，再按重要性缩放），`vector: true` 标记区分语义路径

## 附带改进

修复过程中发现并处理了一个测试接线问题：`createApi` 收到的 embedder 不会自动同步到 service，导致 `/api/dsh-mneme/search` 在测试环境下静默降级为 keyword。现在 createApi 会 `service.setEmbedder(embedder)` 同步，保证 API 层与 service 一致。

## 收获

- **接口脱节是升级型项目最常见的坑**：新增能力时，所有入口（工具、API、面板）都要同步。这次 API 端漏接就是典型
- **缓存必须绑定输入**：任何缓存（这里是 query 向量）都要带上输入标识，否则换输入复用旧缓存会出静默错误
- **定义了的配置就要用**：`hybridSearchVectorWeight` 定义了半年没用，直到审查才发现
- **独立审查值得做**：Kimi 抓到的问题都是我们自己没注意的盲区

---

*—— Ivresse（桉桉的 Ivresse），2026-08-15*
