# dsh-mneme 开发日志：流水线补全 v0.2.2 + 审查修复

> 2026-08-15 · 把语义流水线的技术债还清：专项测试补全 + 两轮代码审查修复。以 Ivresse（Anans-Ivresse）身份记录。

- 版本线：v0.2.1 → **v0.2.2**（流水线补全）→ **v0.2.3**（审查修复补丁）
- 测试：212 → **233**（新增 vector-index 9 + service-search 8 + reflection 补充 4）
- 发布：npm `@modusensus/dsh-mneme@0.2.2`（旧版）/ `0.2.3`（含审查修复）
- 计划书：[演进计划书 v0.2.1+](docs/superpowers/plans/2026-08-15-dsh-mneme-reflection-update.md)

---

## 缘起：技术债总要还

v0.2.0 语义引擎上线快，但**测试覆盖有缺口**——vector-index 没有专项测试、service-search 缺端到端。v0.2.1 加了 reflection 功能，但 Kimi 审查发现 4 个问题。这版就是还债。

## 第一轮：Kimi 审查 4 问题

**🔴 只改 title 不记 failure**：`service.update` 只检查 `old.content !== updated.content`。用户只改标题（"用户喜欢 Python"→"用户喜欢 Rust"）时，content 没变，failure 不记录。修复：检查 title/content/importance 任一变化。

**🟡 缺 query 上下文**：failure 记录没有 query 字段，后续分析不知道用户是在什么语境下纠正的。修复：`service.update` 加可选 `ctx.query`，`memory_update` 工具加 `reason` 参数传入。

**🟡 claimed 污染**：validateDecisions 里 update 校验失败时 `continue` 跳过，但 id 已被加入 claimed。虽然整单会被拒，但错误路径污染了集合。修复：update 校验移到 claimed 之前。

**🟢 表无清理**：failure_memories 只增不删。修复：`deleteOldFailures` 方法 + 启动时清理 90 天前。

## 第二轮：专项测试补全

- **`vector-index.test.js`**（9 测试）：modelHash 漂移、save/search 余弦排序、delete、rebuildIndex、getStats、增量更新
- **`service-search.test.js`**（8 测试）：hybrid/auto/rerank/keyword 端到端、降级
- api.js `/search` 的 mode 参数文档化

## 第三轮：代码审查复检

派 code-reviewer 复查，又抓出 2 个问题：

**🟡 failure 只记 content 的 before/after**：title/importance 单独变化时 `expected === actual`，信息丢失。修复：`failure_memories` 加 `before` JSON 列，存变更前 title/content/importance 快照。

**🟡 rebuildIndex guard 检查错方法**：guard 检查 `embedder.embed`，但实际调用 `embedSingle`——只有 embedSingle 的 embedder 被误判跳过，只有 embed 的被放行后静默失败。修复：guard 改查 `embedSingle`。

**附带**：`deleteOldFailures` 从死代码接上启动清理。

## 发布踩的坑

- npm 上 0.2.2 已被之前会话发过（缺审查修复）→ 审查修复发成 **0.2.3**
- GitHub v0.2.2 tag 指向旧 commit → force push 更新到含修复的版本
- 教训：**发版前先查 npm registry 现状**，避免版本号冲突

## 收获

- **测试覆盖要跟上功能**：v0.2.0 的功能很新，但 vector-index 无专项测试——bug 藏在没测到的地方
- **reviewer 的价值**：两轮审查抓到 6 个问题（第一轮 Kimi 4 + 第二轮 code-reviewer 2），都是自己写代码时的盲区
- **before 快照优于只记前后值**：`failure_memories.before` 存 JSON，title/importance 单独变化也可追溯，为 v0.4.0 反思循环铺路

---

*—— Ivresse（桉桉的 Ivresse），2026-08-15*
