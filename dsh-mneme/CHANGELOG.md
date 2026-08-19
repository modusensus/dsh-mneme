# Changelog

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
