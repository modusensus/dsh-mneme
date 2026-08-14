# dsh-mneme 开发日志：裁决审计与三轴线压测

> 2026-08-15 · 把 roadmap 里的「长会话压测」与「来源链」从设想变成可运行的现实。

- 版本线：v0.1.6（未发版，改动计入 `CHANGELOG` `[Unreleased]`）
- 测试：140 → **152**（新增审计 9 + 三轴线压测不变量 3）
- 新增命令：`npm run stress`
- 仓库：github.com/modusensus/dsh-mneme

---

## 缘起：一条来自社区的意见

有人对 autoDream 提出压测建议，核心是**三条轴线**：

1. **长会话检索**：长时间使用后，检索是否仍能召回该召回的东西（Recall@k），以及库里有没有清不掉的陈旧记忆（陈旧记忆率）
2. **冲突裁决**：矛盾记忆的仲裁结果应该是**可重放**的——同一批输入必须稳定地产出同一批裁决，且能事后复核
3. **多 Agent 并发**：多个 Agent 同时写记忆时，会不会丢更新、重复合并、事务崩溃后丢数据

最后一句点到了要害：**「最好给 autoDream 每次裁决保留输入快照与 receipt，否则高通过率也难定位静默错误。」**

这句话其实是把设计文档里两条 roadmap 直接点名了——`长会话压测` 和 `来源链`。既然被点名，那就动手做。

---

## 第一件事：让每次裁决都有「回执」

### dream_runs 审计表

新增 `dream_runs` 表，每次 autoDream 运行写一行，完整保留裁决现场：

| 字段 | 内容 |
|------|------|
| `snapshot_hash` | 输入快照的 sha256 digest（内容驱动、含 id，可校验输入是否漂移） |
| `input` | **完整输入快照**（id/type/title/content/importance/updated_at），仅凭审计行就能离线重建裁决输入 |
| `decisions` | LLM 原始决策清单 |
| `outcome` | 逐 id 去向（keep / merge-keep / merge-archived / archived / conflict-winner / conflict-archived） |
| `applied` / `summary_stored` | 应用数与摘要标记 |
| `receipt` | 紧凑可校验回执：`dsh-mneme:run:<id>:<status>:<hash12>:<count>:<applied>:<summary>` |

几个设计决定：

- **成功与失败都入库**。失败运行（无路由 / LLM 流中止 / JSON 非法 / 校验拒绝 / 摘要失败）记录 `status=failed` + `error`；摘要失败但决策已应用时，**已应用的决策仍被保留**——这正是不依赖高通过率就能定位问题的前提。
- **写入不走通知链**。审计写是簿记不是记忆变更，走 service 的直通方法，故意不触发写钩子——否则会回环进 dream 调度器。
- **幂等写入**：`ON CONFLICT(id) DO UPDATE`，同一 runId 重放覆盖不重复。
- **receipt 可解析**：`parseReceipt` 能从回执还原 runId/status/hash/计数，用于核对审计行与回执是否一致。

### 快照哈希

`hashSnapshot` 从每个记忆的 `[id, type, title, content, importance, updated_at]` 排序后拼规范串做 sha256。同一输入必然同一摘要——这是「可重放」的数学基础：*同一快照 + 同一决策 → 必然同一 outcome*。

---

## 压测暴露的第一个真实 bug：裁决不是幂等的

写「可重放」测试时，第一个断言就把自己打脸了：

**conflict 决策重复应用会反复追加「已否决旧信息」注释；merge 决策重复应用会重复计数。**

```js
// 同一个决策清单 apply 3 次后：
winner.content.split("已否决旧信息").length - 1  // 期望 1，实际 3
```

这正是社区意见里「重复合并」的风险：在并发或重放场景下，同一裁决被应用多次会产生**累积副作用**——来源链注释膨胀、合并被重复执行。

修复很朴素，在 `applyDecisions` 里加幂等语义：

- **conflict**：败者已归档 → 说明已裁决过 → 跳过（来源注释永不重复追加）
- **merge**：所有非 keepSource 来源都已归档 → 说明合并已落地 → 跳过（不重复计数）

这是审计功能顺手抓到的第一个真实缺陷——如果只追求「决策通过率高」，这类静默累积永远发现不了。

---

## 三轴线压测落地

新增 `npm run stress`（`scripts/stress-dsh.js`），LLM 全部用**确定性 mock**，离线可跑、零 Key。

### 轴线 1 · 长会话检索：Recall@k 与陈旧残留率

- 20 个主题 × 8 轮 = 160 条旧变体记忆，逐轮追加并触发 autoDream
- mock 决策把「变体」条目归档、保留规范记忆（importance 5）
- 指标：
  - **Recall@5 = 100%**、**Recall@10 = 100%**（每个主题的规范记忆稳定在 top-5 召回）
  - **陈旧残留率 = 0%**（旧变体全部被 dream 清掉，没有漏网的过时记忆）

### 轴线 2 · 冲突裁决：可重放仲裁集

- 构造 4 组矛盾记忆（截止日期、语言偏好、存储选型、部署环境），旧信息先存、新信息后到
- mock 决策按「(旧)」后缀确定性裁决 → 同一快照必然同一决策
- 验证：仲裁正确率 100%（胜者保留 + 败者归档 + 来源链注释）、receipt 可解析、**决策清单重放幂等**（repeat 无副作用）

### 轴线 3 · 多 Agent 并发

三个不变量，一个比一个有意思：

- **重复合并**：20 个 agent 同标题并发保存 → 最终活跃恰好 1 条 ✅
- **丢更新（演示 + 修复）**：两个连接各自读同一基线再写回——经典无锁 RMW 竞态，`count` 从 0 各 +1 后只到 1（应=2），**真的丢了增量**；改成写前重读最新值后正确到 2。这个演示如实揭示了风险：生产中多 Agent 写同一库需要行级锁或独立 memoryDir
- **事务/崩溃恢复**：中途抛错后已提交写入不丢，reopen 后完整可读、无半成品残留 ✅

---

## 一个编辑事故：store.js 的 createStore 被吞了

改 `dream_runs` 表时，一次批量编辑意外把 `toDreamRun` 的收尾和 `export function createStore(path) {` 的开头一起吞掉——`db.exec(SCHEMA)` 直接露在模块顶层，**全部 14 个测试文件同步报 `SyntaxError: Unexpected token '.'`**。

排查过程很有意思：`get_errors` 说无错误、文件是合法 UTF-8、没有隐藏字符、内容看着也完整——直到 grep 才发现 `createStore` 整个从文件里消失了。教训两条：

1. **改完 store 先验证可导入**：`node -e "import('./src/store.js')"` 一条命令的事
2. **批量编辑高风险文件后要 grep 关键符号**：`createStore` 这种入口函数消失了，比语法错误更隐蔽

修复后 152 个测试全部恢复通过。

---

## 文档同步

功能落地后把仓库所有说明文件对齐到现状：

- `README.md` / `README_EN.md` / `dsh-mneme/README.md`：测试徽章 140 → **152**，补 `npm run stress`
- `CHANGELOG.md`：新增 `[Unreleased]`（审计 + 幂等 + 压测）
- spec：勾掉 roadmap 两项，验收标准 +2，目录结构 152+
- 博客 devlog：测试数 4 处 140 → 152

---

## 数据一览

```
npm test          152/152 通过（+audit 9，+stress 3）
npm run e2e       exit 0
npm run stress    三轴线全绿
  轴线1  Recall@5=100%  Recall@10=100%  陈旧残留=0%（20 主题 × 8 轮 = 160 条）
  轴线2  仲裁正确率=100%  重放幂等=是
  轴线3  去重✅ 丢更新⚠️(揭示) 串行修复✅ 崩溃恢复✅
```

现在，autoDream 的每一次「做梦」都留下了一份可回放的病历：输入快照、决策清单、逐条去向、回执。将来任何一个静默错误——哪怕决策校验全数通过——都能顺着 receipt 找到它发生在哪一轮、动了哪条记忆、为什么。

> *Mnemosyne 说：你忘记了，没关系，我记得。*

---

*附：压测与审计全程 mock LLM，无外部 API 调用；所有 Key 未入库、未进 git。*
