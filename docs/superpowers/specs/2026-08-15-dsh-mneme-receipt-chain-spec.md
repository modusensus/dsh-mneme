# dsh-mneme per-record 收据链 Spec

- **日期**：2026-08-15（初稿）
- **状态**：草案 — 8/17 与 EigenFlux 对拍交付
- **对拍对象**：Coze Assistant effect-receipt 三元组 `(step_digest, attempt, verdict)`
- **范围**：将 autoDream 审计从「run 级收据」下沉为「per-record 收据链」，解决重放状态漂移

## 1. 背景与目标

### 1.1 现状：run 级审计（已实现，v0.2.1）

dsh-mneme 的 autoDream 每次整理运行写入一条 `dream_runs` 审计行，记录五个事实：

1. 输入快照 sha256 digest（`snapshot_hash`，内容寻址，跨重跑稳定）
2. 原始 LLM 决策清单（`decisions`）
3. 逐 id 去向（`outcome.byId`，如 `merge-keep` / `conflict-winner` / `updated`）
4. 紧凑回执（`receipt`，机器可校验）
5. 应用计数（`applied`）与摘要入库标志（`summary_stored`）

`dream_runs` 实际 schema（`src/store.js`）：

```sql
CREATE TABLE IF NOT EXISTS dream_runs (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  status         TEXT NOT NULL,          -- ok | failed
  error          TEXT,
  provider       TEXT,
  model          TEXT,
  snapshot_hash  TEXT NOT NULL,
  input_count    INTEGER NOT NULL,
  input          TEXT,                   -- JSON: full input snapshot (id/type/title/content/importance/updated_at)
  decisions      TEXT,                   -- JSON: raw LLM decision list
  outcome        TEXT,                   -- JSON: { byId: {id: action} }
  applied        INTEGER NOT NULL DEFAULT 0,
  summary_stored INTEGER NOT NULL DEFAULT 0,
  receipt        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dream_runs_created ON dream_runs(created_at);
```

run 级回执格式（`src/dream.js` `buildReceipt` / `parseReceipt`，8 段，第 7 段为摘要标志位）：

```
dsh-mneme:run:<runId>:<status>:<snapshotHash[:12]>:<inputCount>:<applied>:<summaryFlag>
```

### 1.2 痛点：重放状态漂移

run 级收据只能回答「这次运行发生过、用了什么输入」。
它**无法**回答逐条裁决的局部问题：

- 某条 conflict 的 loser 是在哪一次被归档的？收据链上 winner/loser 谁是谁？
- 同一输入 digest + 同一决策，重放后 outcome 是否逐 id 一致？（当前仅靠 `applied` 计数对拍，计数一致不代表逐条一致）
- 规则版本升级（如 `minAgeHours`、`maxUpdatePerRun` 调整）后，旧裁决按旧规则做出的，如何在审计里区分「旧证据」与「新事实」？

### 1.3 升级目标

把 merge / conflict / update 的**判定依据 + 幂等校验点**下沉为**可独立校验的 per-record 收据链**：

1. 每条可变裁决（merge/conflict/update）生成独立收据，携带输入 digest（判定依据，防裸声明）
2. 收据成为幂等校验点：重放同一决策必须得到同一结果，无累积副作用
3. 引入 `policy_epoch`（规划中），旧裁决自动降级为历史证据（verdict=historical），不参与新事实判定
4. 与 Coze effect-receipt 三元组逐字段对拍，保证跨 Agent 链路（dsh-mneme / CatKing / Nexora）epoch 序对齐

## 2. 字段级映射（对照 Coze effect-receipt 三元组）

Coze 的 effect-receipt 是 `(step_digest, attempt, verdict)`：内容寻址的输入摘要 + 一次尝试记录 + 终态裁决。
dsh-mneme 现字段与 Coze 三元组对照如下：

| dsh-mneme 字段 | 含义 | Coze effect-receipt 对应 |
|---|---|---|
| `snapshot_hash` | 输入快照 sha256 digest（`hashSnapshot`：按 id 排序的 `id/type/title/content/importance/updated_at` 规范拼接） | `step_digest`（输入侧，内容寻址，跨重跑稳定） |
| `decisions` | LLM 决策清单（action: keep/merge/archive/conflict/update） | `attempt`（决策记录） |
| `outcome`（逐 id 去向） | 每个记忆的处置（`byId` → keep/archived/merge-keep/merge-archived/conflict-winner/conflict-archived/updated） | `verdict`（终态 + lineage 链） |
| `receipt` | 紧凑回执 `dsh-mneme:run:<id>:<status>:<hash>:<count>:<applied>`（代码实现含第 7 段 summary 标志） | 终态必留痕 |
| `policy_epoch`（规划） | 裁决规则版本（schema 新增），升级后旧裁决降级历史证据 | `epoch` 序 |

### 2.1 决策清单字段约定（`src/dream/decisions.js`）

| action | 关键字段 | 幂等校验点（applyDecisions） |
|---|---|---|
| `merge` | `ids`、`keepSource`、`title`、`content`、`importance?` | 其余 source 均已归档 → 跳过 |
| `conflict` | `winner`、`loser` | loser 已归档 → 跳过（不重复追加否决注记） |
| `update` | `ids:[id]`、`title?`、`content?`、`importance?` | 字段已与目标一致 → 跳过 |
| `keep` | `ids` | 无副作用 |
| `archive` | `ids` | 已归档 → 跳过 |

这三条幂等校验点即 per-record 收据要下沉固化的事实。

## 3. per-record 收据结构（新增设计）

### 3.1 新表：`receipt_chain`

每条 merge / conflict / update 裁决一条独立收据（keep/archive 无内容变更，可选记录）。

```sql
CREATE TABLE IF NOT EXISTS receipt_chain (
  receipt_id   TEXT PRIMARY KEY,      -- 内容寻址或 UUID
  run_id       TEXT NOT NULL,         -- 父 dream_run.id
  record_id    TEXT NOT NULL,         -- 主目标 id（merge=keepSource / conflict=winner / update=目标 id）
  kind         TEXT NOT NULL,         -- merge | conflict | update
  input_digest TEXT NOT NULL,         -- 判定依据：涉及记录的 pre-state digest（防裸声明）
  winner_id    TEXT,                  -- conflict：胜者
  loser_id     TEXT,                  -- conflict：败者
  keep_source  TEXT,                  -- merge：保留源
  sources      TEXT,                  -- merge：JSON 数组，全部参与 id
  verdict      TEXT NOT NULL,         -- live | revoked | historical
  count_before INTEGER NOT NULL,      -- 幂等校验点：计数前值
  count_after  INTEGER NOT NULL,      -- 幂等校验点：计数后值
  policy_epoch INTEGER NOT NULL DEFAULT 0,  -- 裁决规则版本
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipt_chain_record ON receipt_chain(record_id);
CREATE INDEX IF NOT EXISTS idx_receipt_chain_run ON receipt_chain(run_id);
```

### 3.2 per-record 紧凑回执（类比 run 级回执）

```
dsh-mneme:rec:<runId>:<recordId>:<kind>:<verdict>:<inputDigest[:12]>:<countBefore>:<countAfter>:<epoch>
```

可独立解析（对齐 `parseReceipt` 的分段校验风格），供日志 / 对拍 / 工具链消费。

### 3.3 verdict 状态机

- `live`：当前生效的裁决（participant 记忆为 active 或归档但作为 provenance 引用）
- `revoked`：被后续 update / 反悔操作显式撤销
- `historical`：被 `policy_epoch` 升级淘汰的旧规则裁决，仅作历史证据，不参与新事实判定

verdict 演进：`live → revoked | historical`（单向，不复活）。

## 4. 幂等与重放

### 4.1 幂等不变量

> **I1**：重放同一决策 → 同一结果（无累积副作用）。

三个下沉校验点（见 §2.1）在重放时必须逐条成立：
- merge：sources 全归档即视为已落地，`count_before == count_after` 时收据状态不变
- conflict：loser 已归档即跳过，否决注记不重复追加
- update：字段已与目标一致即跳过

### 4.2 状态漂移检测

> **I2**：同一输入 digest + 同一决策必须复现同一 outcome（逐 id）。

检测协议：

1. 取一条 `receipt_chain` 收据，读取 `input_digest`
2. 对当前库中对应记录重算 pre-state digest（`hashSnapshot` 同构）
3. 比对 `snapshot_hash` / `input_digest`：不一致 → 漂移，定位是「哪个 id、哪次 run」引入的
4. 重放决策（dry-run 应用）并比对 `count_before → count_after` 与 `outcome.byId[record_id]`，逐条而非计数

漂移分级：
- **合法漂移**：`policy_epoch` 升级后按新规则重裁 → 旧收据标 `historical`
- **非法漂移**：digest 匹配但 outcome 不一致 → 静默错误，按 run 回溯

### 4.3 与 run 级收据的关系

run 级回执是「目录」，per-record 收据链是「明细」。校验时先解析 run 回执定位 `run_id`，再展开 `receipt_chain` 逐条核对；`applied` 计数必须等于本 run 下 live 收据数。

## 5. 8/17 交付清单

- [ ] 本文档发布（发布到 `docs/superpowers/specs/`）
- [ ] `dream_runs` schema 增加 `policy_epoch`（若适用；同时新增 `receipt_chain` 表）
- [ ] `dream.js` 增加 per-record 收据构建/解析（`buildRecordReceipt` / `parseRecordReceipt`），复用 `hashSnapshot` 计算 `input_digest`
- [ ] 与 Coze 字段级对拍：确认 `snapshot_hash↔step_digest`、`decisions↔attempt`、`outcome↔verdict`、`policy_epoch↔epoch` 映射无歧义
- [ ] 三方（dsh-mneme / CatKing / Nexora）epoch 序对齐：约定 `policy_epoch` 的递增规则与跨 Agent 同步方式
- [ ] 补测试：重放不变量 I1/I2（dry-run 重放同 digest 复现同 outcome）

## 6. 验收标准

1. ✅ 每次 merge/conflict/update 裁决在 `receipt_chain` 留痕，含输入 digest 与计数前后值
2. ✅ 重放不改变任何收据状态（I1）
3. ✅ 同 digest + 同决策复现同 outcome（I2），漂移可定位到具体 run/record
4. ✅ `policy_epoch` 升级后旧收据可识别为 historical，不污染新事实判定
5. ✅ 收据链可用紧凑回执 `dsh-mneme:rec:...` 独立解析，与 Coze 三元组对拍无歧义
