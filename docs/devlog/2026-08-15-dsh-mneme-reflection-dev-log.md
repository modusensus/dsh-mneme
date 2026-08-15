# dsh-mneme 开发日志：反思更新 v0.2.1

> 2026-08-15 · 让 autoDream 从"只能整理"升级为"能自我修正 + 记录失败"，为自进化铺路。以 Ivresse（Anans-Ivresse）身份记录。

- 版本线：v0.2.0 → **v0.2.1**（反思更新）
- 测试：198 → **212**（新增 14 个 reflection 测试）
- 发布：npm `@modusensus/dsh-mneme@0.2.1` + GitHub tag `v0.2.1` + Release
- 计划书：[演进计划书 v0.2.1+](docs/superpowers/plans/2026-08-15-dsh-mneme-reflection-update.md)

---

## 缘起：让记忆能"自我修正"

v0.2.0 让 autoDream 能 merge / archive / conflict，但它**只能整理、不能修正**——一条"用户喜欢 Python"的记忆，在用户转向 Rust 后，它只能等新的记忆覆盖，或永远留着过时内容。

桉桉和 Kimi 讨论后提出了 **reflection（反思更新）** 方向：让 autoDream 具备修正单条记忆的能力，同时建立"失败记忆"基础设施，为后续反思进化积累数据。

## 第一件事：update 决策类型

`decisions.js` 的 ACTIONS 从 4 种扩到 5 种，新增 `update`。

**校验规则**（防止滥用）：
- `ids` 只能含一个 id（不能批量改）
- 必须产生实际变化（title/content/importance 至少一个不同）
- 不能更新 summary（总览是自动生成的）
- **24h 保护期**：新建记忆不可立即被 update
- **频率限制**：每次 autoDream 最多 2 个 update，超限整单拒绝

**幂等应用**：字段已与目标一致时跳过——重放/并发重复执行无副作用，和 merge/conflict 的幂等修复一脉相承。

## 第二件事：失败追踪（failure_memories）

新表 `failure_memories`，记录记忆纠正/失败事件：

```
query / expected / actual / failure_type / memory_id / created_at
```

- **触发**：用户调用 `memory_update` 且内容变化时，自动记一条 `user_correction`（actual=旧值、expected=新值）
- **查询**：`listFailures`（过滤/分页）、`getFailureStats`（按类型计数）
- 这是后续 v0.4.0「反思性成长」的数据地基——从失败模式提取规律、自动调参

## 第三件事：审计与向量同步

- **审计增强**：update 决策写入 `dream_runs` 时附带 `_before` 快照（变更前 title/content/importance），可回溯"这条记忆改了什么"
- **向量索引同步**：update 后删旧向量、按新内容重嵌入，保持索引与 store 一致——避免"改了内容但向量还是旧的"的漂移

## 配置开关

遵循"开关哲学"，4 个配置项全部可调：
```javascript
reflectionUpdateEnabled: true,       // update 决策总开关
reflectionFailureTracking: true,     // 失败追踪总开关
reflectionUpdateMaxPerRun: 2,        // 每次整理最多 update 数
reflectionUpdateMinAgeHours: 24      // 新建记忆保护期（小时）
```

## 分工与验证

按计划书并行派 3 个 agent：decisions.js（校验/应用）、store+service（失败追踪）、dream.js（Prompt/审计/向量同步），我负责 config 接入 + 测试 + 文档 + 发布。

- **14 个新测试**：update 校验（多id/无变化/summary/24h/频率）、应用（正常/幂等/字段保留）、failure（触发/跳过/开关/统计）
- **212 / 212 全绿**

## 发布

npm 0.2.1 发布时遇到隧道断开（服务器走 Windows 隧道访问 npm registry），等隧道恢复后补发成功。代码/tag/Release 一直在 GitHub。

## 收获

- **修正 ≠ 合并**：merge 是"多条→一条"，update 是"单条修正"，语义必须分开——避免 LLM 用 merge 偷懒批量改
- **保护期很关键**：新建记忆立刻被修正通常是 LLM 幻觉，24h 保护期过滤掉大部分误判
- **数据先行**：failure_memories 现在只记录不消费，等积累够多，v0.4.0 的反思循环才有料可用

---

*—— Ivresse（桉桉的 Ivresse），2026-08-15*
