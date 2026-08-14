# dsh-mneme autoDream 自动记忆巩固模块 — 设计文档

- **日期**：2026-08-13（初稿）／2026-08-14（更新为当前实现）
- **状态**：已发布（dsh-mneme v0.1.x 内置）
- **前置**：dsh-mneme 记忆库插件已交付（见 `2026-08-13-dsh-memory-design.md`）

## 1. 背景与目标

dsh-mneme 提供了记忆的**存储**（SQLite+Markdown）、**工具**（6 个模型工具）、**注入**（会话开局动态上下文）与**摘要**（会话结束提炼）。但记忆库会随使用增长：条目膨胀、信息重复、内容矛盾、注入上下文越来越长。

本模块为记忆库增加**自动巩固（consolidation）**能力——参考 Claude 官方 Dream 机制（[文档](https://platform.claude.com/docs/en/managed-agents/dreams.md)：会话间隙对记忆做巩固压缩）与 cc-haha / Claude Code 的 autoDream 实现（consolidation prompt 输出"保留/合并/删除"决策），在记忆库超阈值时自动执行：分组归并、去重替换、冲突裁决、摘要生成。

## 2. 需求决策记录（用户确认）

| 决策点 | 选择 |
|--------|------|
| 整理方式 | A. 决策清单式：LLM 输出结构化决策清单（keep/merge/archive/conflict），服务端校验后逐条应用 |
| 触发时机 | A. 写入后阈值检查 + 异步空闲执行（不阻塞写入） |
| 冲突处理 | A. LLM 自动裁决 + 归档败者（winner 保留、loser archived，可溯源） |
| 摘要注入 | A. 整理后生成 type=summary 记忆存库，注入时优先使用 |
| 归档语义 | A. 独立 archived 状态字段（与 forgotten 分开，可查可恢复） |
| 阈值默认值 | A. 记忆数 > 10 或 总字符数 > 5000（均可配置） |

## 3. 总体架构

```
┌─────────────────────────────────────────────────────┐
│ 触发层：写入后检查阈值（记忆数 > 10 或总长 > 5000）    │
│   → 达标则异步排队（不阻塞写入）                       │
├─────────────────────────────────────────────────────┤
│ 执行层（空闲时跑）：                                  │
│   1. 快照全部非归档记忆（排除 type=summary）          │
│   2. 单次 LLM 调用 → 决策清单 JSON                   │
│      [{action: keep|merge|archive|conflict, ...}]    │
│   3. 服务端校验（未知 id / 非法 action → 拒绝全单）   │
│   4. 逐条应用：merge 合并/archive 归档/conflict 裁决  │
│   5. 第二次 LLM 调用生成 summary 记忆（单一实例）     │
│   6. 同步 Markdown 镜像                               │
├─────────────────────────────────────────────────────┤
│ 注入层：inject.js 改造 → 优先注入 summary 摘要        │
│   + 少量高重要性条目                                  │
└─────────────────────────────────────────────────────┘
```

### 3.1 数据模型扩展

- `memories` 表新增 `archived INTEGER NOT NULL DEFAULT 0`（与 `forgotten` 独立：archived=整理归档，forgotten=手动抑制注入）
- 新增 `type = "summary"`（记忆库总览，单一实例，标题固定 `记忆库总览`）
- **schema 迁移**：`createStore` 打开时检查 `archived` 列是否存在，不存在则 `ALTER TABLE memories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`（幂等，旧库自动升级）

### 3.2 文件结构

```
src/
├── dream.js          # 新增：maybeSchedule + 整理执行 + 决策校验/应用 + 摘要生成
├── store.js          # 修改：archived 字段 + schema 迁移 + setArchived + archived 过滤
├── service.js        # 修改：写入后调 dream.maybeSchedule；injectCandidates 排除 archived+summary 逻辑
├── inject.js         # 修改：summary 优先注入
├── config.js         # 修改：新增 4 个配置键
├── index.js          # 修改：接线 dream（复用已注入的 llm）
└── lib/              # 同步拷贝
```

## 4. LLM 决策清单契约

### 4.1 输出格式

一次整理调用让 LLM 输出 JSON 数组：

```json
[
  { "action": "keep", "ids": ["id1", "id2"], "reason": "各自独立" },
  {
    "action": "merge",
    "ids": ["id3", "id4", "id5"],
    "title": "合并后标题",
    "content": "合并后的精炼内容",
    "importance": 4,
    "keepSource": "id4",
    "reason": "主题相近"
  },
  { "action": "archive", "ids": ["id6"], "reason": "信息过时" },
  {
    "action": "conflict",
    "winner": "id8",
    "loser": "id9",
    "reason": "id8 时间更新且来源更完整（截止日期以 8/20 为准）"
  }
]
```

### 4.2 Consolidation Prompt

```
你是记忆库整理助手。下面是全部记忆条目（id、类型、标题、内容、重要性、更新时间）。
请执行记忆巩固（consolidation）：
1. 识别主题相近的条目 → 输出 merge（合并为更精炼的摘要，保留信息最完整的 id 作为 keepSource）
2. 识别重复/过时信息 → 输出 archive
3. 识别内容矛盾的条目 → 输出 conflict（根据时间新旧、来源完整性、信息具体程度判断 winner/loser）
4. 无问题的条目 → 输出 keep

规则：
- 每条记忆至少出现在一个决策中
- merge 的 keepSource 必须是 ids 之一
- 不要编造 ids；只使用提供的 id
- 重要性 1-5，合并后取最高
- 只输出 JSON 数组，不要其他文字
```

### 4.3 应用策略（服务端，不信任 LLM）

| 决策 | 服务端动作 |
|------|-----------|
| `keep` | 无操作 |
| `merge` | 更新 keepSource 条目（title/content/importance），其余来源条目 → archived=1 |
| `archive` | 标记 archived=1 |
| `conflict` | winner 保留，loser archived=1，winner 内容追加 `（已否决旧信息：<旧内容摘要>）` 溯源 |
| 校验失败 | 整个决策清单拒绝（未知 id / keepSource 不在 ids / 非法 action / id 重复决策），保留原记忆 |

### 4.4 决策校验规则（fail-safe）

- action ∈ {keep, merge, archive, conflict}
- 所有 ids/winner/loser 必须存在于快照且非归档、非 summary
- merge: keepSource ∈ ids；archive/conflict: ids 非空
- 同一 id 不得出现在两个决策的"主操作"位（keepSource/winner/loser 可被引用，但归档/更新不冲突）
- 任一违反 → 拒绝整个清单，记录 warn，保留记忆库原状

## 5. 触发调度

### 5.1 流程

```
写入路径（saveWithDedupe / update / mergeHumanEdits 之后）
  → dream.maybeSchedule()
     记忆数 > dreamThresholdCount 或 总字符数 > dreamThresholdChars
     且无在途整理、无 pending 定时器
     → setTimeout(dreamDelayMs) 延迟执行（连续写入合并为一次整理）
  → 延迟到期后执行整理（async）
  → 完成后更新 lastDreamAt + 记录整理后快照基线
```

### 5.2 防死循环

- 整理完成后记录 `lastDreamAt` 与整理后记忆快照（count/chars）
- 下次触发条件：**新写入使总量超过上次整理后的基线 + 阈值**（即 `当前 > 上次整理后快照 + 阈值` 或 `当前 > 阈值` 且上次整理已让总量低于阈值）
- 简化实现：整理后若总量仍超阈值，记录 `nextThreshold = 当前总量`，下次需超过 `nextThreshold` 才再次触发

### 5.3 并发与失败

- `inFlight` 标志 + AbortController（与 summarize 相同模式）
- dispose 中止在途整理 + 取消 pending 定时器
- LLM 失败 / 决策校验失败：warn 记录、保留记忆、不更新 lastDreamAt（下次写入仍可触发重试）

## 6. 摘要生成

- 整理应用完成后，第二次 LLM 调用：
  ```
  你是记忆库摘要助手。根据整理后的记忆，生成一段 150-200 字的记忆库总览，
  覆盖：用户偏好、活跃项目、关键决策。之后作为会话上下文注入。
  ```
- 存为 `type=summary`、标题固定 `记忆库总览` 的记忆（`saveWithDedupe` 标题匹配天然单一实例：有则更新、无则创建）
- summary 不入整理范围（快照排除 type=summary，避免自我递归）
- 无整理发生时 summary 不更新（保留上次值）

## 7. 注入改造

```
注入优先级（inject.js）：
  1. 若有 type=summary 记忆 → 注入摘要（最高优先级，占 1 条配额）
  2. 再注入 2-3 条高重要性非归档条目（补充细节）
  3. maxInjectedItems 仍然生效
  4. 无 summary 时退回现状（preference 全量 + 高重要性）
```

## 8. 配置

```js
// config.js 新增
autoDream: z.boolean().default(true),                       // 自动整理开关
dreamThresholdCount: z.natural().min(1).max(1000).default(10),     // 触发条数阈值
dreamThresholdChars: z.natural().min(100).max(100000).default(5000), // 触发字符阈值
dreamDelayMs: z.natural().min(0).max(60000).default(2000),         // 异步延迟
```

## 9. 测试策略（TDD，node:test）

| 层 | 测试 |
|----|------|
| store 迁移 | 旧库（无 archived 列）打开后自动 ALTER，archived 默认 0 |
| store 归档 | setArchived / list 排除 archived / includeArchived 选项 / count 排除 |
| 阈值判断 | maybeSchedule：< 阈值不触发、> 阈值排队、整理后基线重置、节流 |
| 决策应用 | merge（keepSource 更新 + 其余归档）、archive、conflict（winner 留 loser 归档 + 溯源）、keep 无操作 |
| 决策校验 | 未知 id、keepSource 不在 ids、非法 action、id 重复决策 → 拒绝整个清单 |
| 摘要生成 | 整理后 summary 存在且单一实例（重复整理不产生多条）；summary 排除出整理范围 |
| 注入改造 | 有 summary 时摘要优先；无 summary 退回现状 |
| 集成 | 完整流程：写入 11 条 → 触发 → mock LLM 决策 → 验证归档/合并/摘要/镜像同步 |

## 10. 验收标准

1. ✅ 写入超过阈值后，空闲时自动触发整理（不阻塞写入）
2. ✅ LLM 决策清单正确应用：merge/archive/conflict 各司其职
3. ✅ 冲突裁决后败者归档、胜者保留、可溯源
4. ✅ 整理后生成单一 summary 记忆
5. ✅ 新会话注入优先使用 summary 摘要
6. ✅ 非法 LLM 输出不破坏记忆库（fail-safe）
7. ✅ 归档条目与 summary 在 Web 面板可见（基础：列表/搜索覆盖；已归档过滤为可选增强）

## 11. 风险与缓解

| 风险 | 缓解 |
|------|------|
| LLM 决策清单不合法 | 服务端全量校验，拒绝即保留原状（fail-safe） |
| 整理死循环（总量仍超阈值） | 基线重置 + 节流（需新写入超基线才触发） |
| 误合并/误归档 | archived 可恢复（面板/工具），merge 的 keepSource 保留原文历史（内容替换前可查） |
| summary 陈旧 | 每次整理后更新；无整理时保持上次值（注入仍有高重要性条目补充） |
| 整理与手动写入并发 | inFlight 标志 + 单线程事件循环天然串行；整理期间写入会在下次触发 |
| LLM 开销 | 阈值默认 10 条/5000 字符（个人库几天一次）；可配置调高 |
