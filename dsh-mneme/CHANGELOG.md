# Changelog

## [0.5.1] - 2026-08-20

### 修复

- **热记忆负参数防御**（复验发现）：`createHotMemory` 的 `maxRounds`/`maxTokens` 非正整数/非有限值时 fallback 到默认 5/2000，堵死负数 `maxRounds` 触发的同步死循环（此前插件配置钳制 ≥1 不可达，但导出的公开 API 不设防）
- **#13 修复补全（reranker 侧）**：`reranker.js` 的 `defaultPipelineLoader` 镜像 `env.cacheDir = options.cache_dir`（与 `local-embedder.js` 同款），`rerankProvider=local` + `embedProvider=openai`（默认）场景下断网也能本地加载 tokenizer
- **融合分数钳制 [0,1]**：hybrid 三路召回融合后分数 `clamp` 到 0..1（sort 后 map，不改变排序相对顺序），修复向量+BM25 叠加可突破 1.0 的归一化契约破坏

### 文档

- 根/子 README 配置表补 `hotMemoryEnabled`、`searchSemanticDedupThreshold` 两键（此前 v0.5.0 漏写）
- 测试 593 → **597**（新增负参数边界 / 融合 clamp / cache_dir 镜像用例）

## [0.5.0] - 2026-08-19

### 新增

- **主区「记忆库」视图（conversation.view 插槽），取代侧边栏抽屉**：记忆功能全部收进主内容区全宽 tab，与「对话 / Trajectory」并列。侧边栏底部「记忆」入口点击后直接激活该 tab，不再弹出抽屉（tab 激活通过会话头部的 tab 按钮触发——框架的 setView 是 conversation 包私有 API，DOM tab click 是插件可用的稳定路径）。
  - **三个子视图**：「记忆」（三栏浏览）/「图谱」（实体网络）/「设置」（画像、规则、指令、向量配置，限宽居中），由页面顶部的子 tab 行切换——active 态为宿主同款「文字变主题蓝 + 底部下划线」。
  - **三栏布局**：左栏分类树（类型 + 计数，客户端过滤）；中栏时间树（按月 → 日两级分组、倒序，月份可折叠，条目带时间点）；右栏详情（标题、类型 · 重要性、来源、创建/更新时间、标签、**全文不截断**展示、「复制全文」）。月份/日期格式走宿主 locale。
  - **语义搜索内嵌**：向量服务启用时工具栏出现「语义」开关，开启后搜索走服务端向量召回（防抖 250ms），关闭则客户端标题/内容过滤；`entity:` 前缀语法保留，出现「在图谱中查看」跳转。
  - **图谱 ↔ 记忆互跳**：图谱详情侧的关联记忆条目可点击、记忆边的「来源记忆」按钮按 memory_id 直跳，落回三栏视图时自动重置过滤并定位选中目标。
  - **设计系统对齐**：页面画布平铺宿主 `bg-layer-1`，栏间用细边框分隔（无大圆角外框、无胶囊 chip），active/交互态走 `--dsw-alias-*` token，观感与宿主原生视图一致。
  - **数据零新增**：复用 `GET /api/dsh-mneme/list?limit=500`，一次拉取全量在客户端分组过滤。
- **记忆图谱可视化（P1）**：图谱子视图输入实体名，加载以该实体为中心的关联网络。
  - **服务端 ego-graph API**：`GET /api/dsh-mneme/semantic/graph/ego?entity=<name>&depth=1|2`，从根实体 BFS 层级遍历实体关系网络，返回节点（含 `distance` 跳数）、边及根实体信息；`limit` 防大图失控，实体不存在返回 404。配套 `GET /semantic/graph/entity-attrs` 查实体属性。两个端点均为只读，不触碰写入路径。
  - **前端零依赖 SVG 力导向图**：因 DSH 插件运行时无法 require 第三方库（vis-network 等不可用），图布局为纯手写物理模拟——节点两两斥力 + 边弹簧拉力 + 向心引力，速度衰减 0.85，300 帧或能量 < 0.4 后自动停帧。节点按类型着色、按提及次数定半径，支持节点拖拽（拖拽与点击以位移阈值区分）、点节点看属性与相关记忆、点边看关系详情并可跳回来源记忆。深度 1/2 一键切换。
- **图谱入口图标为自绘节点连线 SVG**：primitives 图标库无网络/图谱类图标，其分享样式图标易被误解为分享功能，故自绘 16px 三节点连线图标（GraphNodesIcon，currentColor 跟随主题）。
- **召回率优化（三路召回融合）**：
  - **BM25 稀疏向量第三路召回（`src/search/bm25.js`）**：与向量召回、FTS5/LIKE 关键词并列的第三路——ASCII 词元 + CJK bigram 分词、IDF 加权打分（归一化 [0,1]），专有名词、ID、代码片段等散词查询不再依赖子串命中。融合规则：未召回的行按 `0.3×BM25分` 回填；仅向量召回的行获得词法加分；LIKE 关键词已命中的行不叠分（子串命中必然包含查询词元，叠分等于重复计算词法证据）。`bm25SearchEnabled` 可整体关闭。
  - **自适应阈值（`src/search/adaptive.js`）**：取代固定 `0.65` 截断——`entity:`/`attr:` 前缀放宽至 0.5，短查询（<5 字符）收紧至 0.7，长查询（>50）放宽至 0.6，候选头部 Top1/Top5 分差 > 0.3 时放宽至 0.5 让尾部进入 Rerank。抓取阶段以最宽松分支下限执行、终cut按实际分布计算；显式传入 `threshold` 或 `adaptiveThresholdEnabled=false` 时完全走旧行为。
  - **会话级短期热记忆（`src/hot-memory.js`）**：与长期记忆库分离的会话内热上下文——最近 N 轮对话（默认 5，`hotMemoryRounds`）按 token 预算（默认 2000，`hotMemoryMaxTokens`）滚动截断，每次渲染从会话事件日志无状态重建，不落库。`hotMemoryEnabled` 为总开关（默认开，关闭后热记忆块不再注入）。注入顺序为「短期上下文 → 长期记忆召回 → 摘要」，热记忆块置于 memory 上下文块头部（不新增独立 context，系统提示装配保持两块稳定）。
- **部署优化（注入侧）**：
  - **上下文压缩注入**：sleep 降权记忆带 `_full_content` 时注入其摘要原文，不再对已压缩内容二次截断；普通长内容维持 300 字硬截断。
  - **选择性注入（主题匹配）**：query 向量可用时（异步预取缓存），注入候选按与当前查询的主题相似度重排，替代固定规则序；`selectiveInjectEnabled` 可关。
  - **搜索时语义去重（激进选项）**：`searchSemanticDedup=true` 显式开启后，合并候选按 embedding 余弦相似度贪心去重（阈值由 `searchSemanticDedupThreshold` 控制，默认 0.95），近重复行在 Rerank 前被丢弃，不等待 autoDream 合并。默认关闭——小模型可能误折叠语义相近但内容不同的记忆；keyword 纯文本模式永不参与。
- **评测体系（`scripts/benchmark-recall.js`）**：标准查询集驱动的召回基准——每用例给出期望命中 id，计算 Recall@5 与 MRR，`legacy`（三特性全关）与 `fused`（默认配置）双跑对比，可重复验证三路融合的召回增益。

### 修复

- **Issue #13：本地嵌入模型离线加载仍发远程请求**：`local-embedder` 的 `defaultPipelineLoader` 此前未设置 `env.cacheDir`，导致 transformers.js 在 tokenizer 元数据预检阶段绕过本地缓存直接请求 HF 远端。现在当 `cache_dir` 配置存在时同步写入 `env.cacheDir`，模型与 tokenizer 元数据全部走本地缓存，断网环境可完整加载。

### 测试

- 593 全绿：新增 `test/graph-api.test.js` 7 例（路由注册 / BFS 深度边界 / 孤岛节点 / 实体不存在 404 / limit 截断 / 100+ 节点 2 跳 < 50ms 性能）；client 侧重构断言（conversation.view 注册与稳定 entry id / 图标语义约束 / 无抽屉回归 / 子视图与图谱互跳链路 / entity: 语法 / 三栏结构 / 宿主设计 token 对齐）；召回优化新增 `test/search-fusion.test.js`（分词 / BM25 索引与 IDF / 自适应阈值分支）、`test/hot-memory.test.js`（热记忆轮次与 token 预算 / 三路融合散词召回 / 语义去重开与关 / 选择性注入重排）、`test/benchmark.test.js`（基准双配置运行 / fused 不劣于 legacy / 用例集覆盖散词场景）。

## [0.4.7] - 2026-08-19

### 修复

- **schema 迁移幂等化，修复并发 createStore 竞态**：并发打开同一 db 时 `PRAGMA table_info` 检查与 ALTER 非原子，可能重复 `ADD COLUMN` 报 `duplicate column name`（v0.4.6 CI peer 并发测试暴露）。改用 `addColumn` helper——检查 + try/catch 吞掉 duplicate 竞态，12 处迁移统一收口。

## [0.4.6] - 2026-08-19

### 修复

- **向量链路三连修（Bug1/2/3）**：
  - **embedSingle 适配（Bug1）**：向量链路统一走 `embedSingle`，消除 embed / embedSingle 不一致导致的静默跳过。
  - **存量自动回填（Bug2）**：新增 `autoReindexOnBoot`（默认 `true`）——向量 API 已配置且存量记忆缺 embedding 时，启动后延迟后台按批次限速自动重建索引；设为 `false` 可保持仅手动重建。
  - **vector_meta 元数据（Bug3）**：向量索引写入时记录模型/维度等元数据，`getStats` 可报告已嵌入/总数与模型信息。
- **注入语义召回优先（Bug4，`hybridInject` 默认 `true`）**：`injectCandidates` 带非空 query 时先走向量索引语义召回候选，再回退规则筛选补足/去重；query 向量异步预取 + 有界缓存（cap 8），系统提示渲染保持同步。空 query / 无向量时行为与旧版一致。
- **同标题追加（Bug5）**：同一标题再次写入不再覆盖，追加到 `content_history`，保留演进轨迹。
- **注入长度上限（Bug6）**：注入记忆块设双层预算——单条 content 截断 300 字（尾部 `…`），整块上限 1500 字；超预算条目塌缩为仅标题，注入上下文不会被长记忆撑爆。
- **记忆质量过滤（Bug7，`memoryQualityFilter` 默认开）**：写库前按启发式打分 0-100——元记忆词汇 / 自指类型标签 / 内容过短 / 重复度高 / 与近期记忆近似重复扣分。≥60 正常存储；30-60 降权（注入排序按 `importance × quality/100`）；<30 归档并标记 `low_quality`（显式搜索仍可召回，只是永不自动注入）。纯函数实现，无 I/O 可独立单测。
- **LLM 消耗审计（Bug8，`llmAudit` 默认开）**：每次后台 LLM 调用（autoDream 整理 + 摘要、autoSummarize 压缩）写入 `llm_audit_logs` 表——tokens / duration / status / source；失败记 `status=error` 不阻塞功能；`retentionDays`（默认 90）启动时清理超期行。新增只读 API：`/api/dsh-mneme/semantic/llm-audit`（分页 + source 过滤）与 `/llm-audit/stats`（近 N 天按 source 汇总预算）。

### 测试

- 553 全绿（新增 `test/quality-filter.test.js`：打分信号 / 阈值分档 / 降权排序；`test/llm-audit.test.js`：埋点 / 统计 / 保留期清理 / API）。

## [0.4.5] - 2026-08-19

### 新增

- **epistemic trust 记忆可信度（`trustEpistemicWeighting`，默认关闭）**：记忆按来源可信度分级——`observation`（观察/实测，可信最高）> `inferred`（推断）> `subjective`（主观/猜测）。开启后影响四类行为：检索排序优先高可信记忆、注入时对 observation 记忆标注 `[verified]`、dream 合并（merge keepSource）与冲突消解（conflict winner）自动偏向高可信一方。关闭时 `epistemic_status` 仍会随保存推断并落库，但不参与任何行为决策，完全向后兼容。
- **recall eval 检索评估（`evalPersistTestResults`，默认关闭）**：`evaluateRetrieval` 支持将检索评估快照（precision / recall / mrr 等）持久化到独立的 `recall_evals` 表。默认关闭时评估结果仅返回给调用方、不落库；开启后评估快照写入 `recall_evals`。生产路径 `searchMemories` 的审计始终走 `recall_runs`，**无条件不触碰** `recall_evals`，评估与线上数据严格隔离。

### 测试

- 518 全绿（新增 `test/epistemic.test.js`：可信度优先级/合并/冲突/inject 标记；`test/recall-evals.test.js`：评估落库 opt-in 与生产隔离）。

## [0.4.4] - 2026-08-18

### 修复

- **autoDream 决策覆盖全量拒绝（issue #9 方案C）**：大记忆量下 `validateDecisions` 要求 snapshot 每条记忆都被决策 claim，LLM 漏报即整单拒绝（636 记忆 → 677 errors、applied=0）。本次三件套修复：
  - **滑动窗口**：新增 `dreamMaxSnapshotSize`（默认 `200`），autoDream 每次只对最近 N 条记忆做 consolidation（按 `updated_at` 倒序截断），窗口外旧记忆不进 snapshot，从源头控制 LLM 输入规模。
  - **隐式 keep**：新增 `dreamImplicitKeep`（默认 `true`），LLM 未提及的 snapshot 记忆自动补 `{action:"keep"}`，不再"未覆盖即全拒"；设为 `false` 可恢复严格全量校验。
  - **覆盖率下限**：新增 `dreamMinExplicitCoverage`（默认 `0.5`），显式决策覆盖比例低于阈值时整单拒绝，防止被截断的残缺输出被静默应用。
- **固定决策 JSON schema**：`CONSOLIDATION_PROMPT` 显式写死 `action`/`ids`/`winner`/`loser` 字段（winner/loser 为单字符串 id），并禁止同一 id 跨决策重复 claim——提升 kimi 等模型输出合规率（本地真实 LLM 复验：qwen3-coder-plus / kimi-k2.7-code 成功轮均 applied=142、input_count=200、零 677 errors）。
- **代码审查加固**（kimi-k3 审查 + 本地真实 LLM 复验）：`dreamImplicitKeep` 透传到 `validateDecisions`（false 严格模式真正生效）；失败路径不再向入参追加 keep；`CONSOLIDATION_PROMPT` 消除"每条必须出现"与"未提及自动保留"的自相矛盾。

### 测试

- 487 全绿（新增：650 记忆滑动窗口/隐式 keep 回归、低覆盖拒单、覆盖率达标补 keep、runDream 级 `dreamImplicitKeep:false` 严格模式端到端、滑动窗口成员正确性、prompt 决策 schema 约束）。

## [0.4.3] - 2026-08-18

### 修复

- **autoDream 思考型模型正文为空（issue #9）**：大记忆量 + 思考型模型时，streamText 只收 `text-delta`，模型把 token 预算全花在 reasoning 上导致正文为空（`no json array in llm output`）。本次双管齐下：
  - **方案 B（放宽上限）**：`dreamMaxTokens` 上限由 `32768` 放宽至 `131072`，大记忆量决策清单/摘要不再被截断。默认仍为 `4096`，行为不变。
  - **方案 A（推理强度透传）**：新增 `dreamReasoningEffort`（`low` / `medium` / `high` / `none`，默认 `none`），透传到 dream 两次 LLM 调用；sleep 侧新增 `sleepReasoningEffort`，同样透传到冲突消解 / 模式发现两处调用。`none` 时不传该字段，完全沿用模型默认，向后兼容。

## [0.4.2] - 2026-08-18

### 新增

- **autoSummarize 支持自定义模型**：新增 `summarizeProvider` / `summarizeModel` 配置项，可指定独立模型用于会话摘要提取。空字符串时保持原有行为（使用当前会话模型）。推荐使用轻量模型（如 qwen3.6-plus）以节省主模型 token 消耗。（#8, @lqs50）

## [0.3.9] - 2026-08-17

### 核心修复（社区审计反馈）

- **A. 事务原子性收敛**：`compareAndUpdate` 的 CAS 更新与 `generation` 递增现由 `runAtomically` 封装至单一数据库事务。CAS miss 不再递增 generation，彻底消除崩溃后 `DB=CAS-New / mirror=Old / dirty=false` 且无债务的状态分裂窗口。
- **B. 降级状态透传**：mirror 状态写入失败时 `service.update` / `compareAndUpdate` 不再返回静默成功。失败时附加 `_mirror` 属性 `{status: 'degraded', error}`，上层可感知底层存储降级。
- **D. 逐 type 物理终态结算**：修复 project 文件已提交、decision 失败时两 type 被批量标 failed 的缺陷。`mirror.sync` 现逐 type 返回结果，`syncMirror` 依据实际落盘状态将各 type 独立持久化为 committed / failed。
- **F. Generation 强整数校验与脏值拦截**：`setMirrorState` 用 `Number.isInteger` fail-closed；SQL 层新增 `CHECK generation = CAST(generation AS INTEGER)`；迁移逻辑扫描历史遗留的 `-7 / 1.5` 等非整数脏值并抛错阻断，杜绝静默沿用。

### 基础设施与契约对齐

- **并发初始化优化**：`PRAGMA busy_timeout` 严格先于 `PRAGMA journal_mode=WAL` 执行，消除 8 进程并发初始化的 `database is locked`。
- **E2E 契约对齐**：断言对齐 7 个模型工具 / 9 条 exact 路由（prefix fallback 不计入）。
- **回归测试**：450/450 全绿（此前 446/447 有 1 个并发失败）。

## [0.3.8]

- audit peer 复验 6 项运行时阻断全部修复。
- desired generation 同事务原子递增（崩溃窗口不再静默跳过）。
- 逐 type committed / failed / pending 回执，健康端点区分 ok / degraded / unknown。
- generation 上界 / 负数 CHECK。
