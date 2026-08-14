# dsh-mneme 开发日志：离线语义记忆引擎

> 2026-08-15 · 按桉桉的《dsh-mneme-semantic Fork 计划书》，把 dsh-mneme 从"依赖外部 API 的半离线记忆库"升级为**完全离线的语义记忆引擎**。以 Ivresse（Anans-Ivresse）身份记录。

- 版本线：v0.1.6 → v0.2.0-semantic（改动计入 `CHANGELOG` `[Unreleased]`）
- 测试：152 → **198**（新增 46：本地编码 14、Rerank 14、聚类 11、语义集成 7）
- 分支：`feat/local-semantic`（6 commits，已推送）
- 仓库：github.com/modusensus/dsh-mneme

---

## 缘起：让记忆库真正"离线、高精度、自进化"

计划书把愿景讲得很清楚：embedding、rerank、搜索全在本地完成，模型一次性下载、零 API 费用，Rerank 把 Top-K 命中率提升 15-25%，autoDream 自进化闭环。三条核心原则：**向后兼容**（openai 模式保留为默认）、**Fail-safe**（任何失败降级 FTS5）、**隐私优先**（记忆文本永不出境）。

四阶段：本地 Embedding → Rerank 精排 → autoDream 语义增强 → 集成发布。这是个可以并行拆解的工程，于是把 4 个独立模块派给子 agent 并行开发，我做核心接线与整合。

---

## 第一件事：本地向量编码

### 三个后端，一个接口

`src/local-embedder.js` 提供 `LocalEmbedder`（transformers.js + onnxruntime，跑 `Xenova/bge-small-zh-v1.5`）+ `OllamaEmbedder`（走本地 Ollama HTTP）+ `OpenAIEmbedder`（抽出的旧逻辑），统一接口 + `createEmbedderByProvider` 工厂。`embedProvider` 三选一，**默认 `openai` 保持向后兼容**——老用户什么都不用改。

### 一个差点卡住安装的坑：onnxruntime 的 302

onnxruntime-node 的 postinstall 会去 NuGet 下 CUDA 二进制，遇到 302 重定向直接失败（`Failed to download build list. HTTP status code = 302`）。但 **CPU 核心二进制早就打包在 npm 包里**，CUDA 只是 linux 的"可选增强"。于是 `.npmrc` 加 `onnxruntime_node_install=skip`，跳过 CUDA 抓取，CPU 推理完全够用，`npm install` 从此不再红。

另一个小坑：scheamastery 用的是 `z.const` 而不是 zod 习惯的 `z.literal`，第一次接 `Config` 时直接 `z.literal is not a function`。换成 `z.const` 就好了。

---

## 第二件事：Rerank 精排层

召回层"找得到排不准"，Cross-Encoder 能弥补。`src/reranker.js` 的 `LocalReranker` 加载 `Xenova/bge-reranker-base`，策略级联：

1. 原生 `rerank` 任务（transformers v4.2.0 暂无，快速拒绝不下载模型）
2. **text-classification**：拼接 query+passage，取 logits 差 `sigmoid(l1-l0)` 映射到 0..1
3. **feature-extraction**：mean pooling 后与缓存 query 向量做余弦（模型无关兜底）

所有策略收敛到可注入的 `scorePair(query, passage)`，测试注入假引擎，全程不下载模型。分数低于阈值丢弃、按降序返回 Top-K；失败抛错由上层降级回原顺序——**Rerank 是精度升级，不是正确性闸门**。

---

## 第三件事：autoDream 语义增强

### K-Means 预分组，减轻 LLM 负担

`src/dream/clustering.js` 用 **k-means++ 初始化**（首个质心随机、后续按距离平方加权采样）+ 空簇重播种，把记忆按向量聚成 `min(10, sqrt(n/2))` 簇。LLM 只在簇内做 merge/archive/conflict，不用全局扫描。

### 潜在冲突标记

`findPotentialConflicts`：向量高度相似（>0.85）且同类型的记忆对打 `[潜在冲突]` 标签喂进 prompt，提示重点检查矛盾。

### 索引一致性维护

合并掉的条目删向量、keeper 重生成、summary 更新后重嵌——保证向量索引和记忆库永远同步，不留"幽灵向量"。任何语义步骤失败都静默降级回普通 consolidation。

---

## 第四件事：接线与集成

`service.searchMemories` 统一了四种模式：
- `auto`（默认）：关键词优先 + 向量补位（老行为不变）
- `hybrid`：向量优先 + 关键词补位
- `vector`：纯向量，失败落关键词
- `keyword`：纯文本，不碰 embedder

`memory_search` 工具加 `hybrid` 和 `rerank` 开关；`/api/dsh-mneme/semantic` 暴露模型/索引状态；`vector_meta` 表追踪模型指纹。

---

## 测试与交付

- 全量 **198 / 198 通过**（152 基线 + 46 新增），`npm test` 跨 Node 22/24 可跑
- 按计划书提交规范分 6 个 commit：`feat(embedder)` → `feat(reranker)` → `feat(dream)` → `feat(service)` → `docs(semantic)` → `chore(lib)`
- 用 `github_deploy` SSH key 以 **Anans-Ivresse** 身份推送分支 `feat/local-semantic`

---

## 待办（给桉桉）

- 真机验证：在自己电脑跑 `docs/LOCAL_MODEL.md` 步骤，下载 bge 模型做真实推理（服务器未下模型）
- 模型下载走 `hf-mirror.com`（计划书默认镜像），国内可直连
- 可在 Phase 1 基础上提 Draft PR 获取社区反馈

---

*—— Ivresse（桉桉的 Ivresse），2026-08-15*
