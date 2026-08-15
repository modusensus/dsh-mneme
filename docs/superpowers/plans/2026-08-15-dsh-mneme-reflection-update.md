# dsh-mneme 演进计划书（v0.2.1 reflection-update）

> **当前版本**：v0.2.0（语义记忆引擎）
> **文档状态**：v0.2.1 策划 + 后续版本路线图
> **发布节奏**：2-3 天一个版本
> **最后更新**：2026-08-15

## 一、版本总览

| 版本 | 周期 | 核心主题 | 关键交付 |
|---|---|---|---|
| **v0.2.1** | 2-3 天 | 反思更新 | `update` 决策 + 失败追踪表 |
| **v0.2.2** | 2-3 天 | 流水线补全 | api.js 完善 + 测试补全 + 混合搜索调优 |
| **v0.2.3** | 2-3 天 | 轻量结构化 | 实体-属性注释标记（零 schema 变更） |
| **v0.3.0** | 1 周 | 记忆基因 | 正式 entities/attrs/relations 三表 + 知识图谱查询 |
| **v0.3.1** | 3-5 天 | 系统级睡眠 | Sleep 调度器 + 分层压缩（活跃/温/冷） |
| **v0.4.0** | 1-2 周 | 反思性成长 | 纠错双向回流 + 规则演进 + 自适应参数 |
| **v0.5.0+** | 远期 | 自进化记忆 | 兴趣漂移分析 + 跨 workspace 协作（等 DSH 支持） |

## 二、v0.2.1 详细计划：反思更新（Update）+ 失败追踪

### 2.1 目标
让 autoDream 具备修正单条记忆的能力，同时建立"失败记忆"基础设施，为后续反思进化积累数据。

### 2.2 改动清单

#### A. 决策引擎扩展（`src/dream/decisions.js`）

```javascript
// 1. ACTIONS 扩展
const ACTIONS = new Set(["keep", "merge", "archive", "conflict", "update"]);

// 2. validateDecisions 新增 update 校验
if (d.action === "update") {
  // 只能更新单条
  if (!Array.isArray(d.ids) || d.ids.length !== 1) {
    errors.push(`${at}: update must target exactly one id`);
    continue;
  }
  // 必须产生实际变化
  const mem = snapshot.get(d.ids[0]);
  const hasChange = (d.title !== undefined && d.title !== mem?.title)
    || (d.content !== undefined && d.content !== mem?.content)
    || (d.importance !== undefined && d.importance !== mem?.importance);
  if (!hasChange) {
    errors.push(`${at}: update must change at least one field`);
    continue;
  }
  // 不能更新 summary
  if (mem?.type === "summary") {
    errors.push(`${at}: cannot update summary via update action`);
    continue;
  }
  // 24h 保护期
  const ageHours = (Date.now() - new Date(mem.created_at).getTime()) / 3600000;
  if (ageHours < 24) {
    errors.push(`${at}: memory too young (< 24h)`);
    continue;
  }
}

// 3. 频率限制：每次 autoDream 最多 2 个 update
const updateCount = decisions.filter(d => d.action === "update").length;
if (updateCount > 2) {
  errors.push(`too many update decisions: ${updateCount} > 2`);
}

// 4. applyDecisions 新增 update 分支
else if (d.action === "update") {
  const id = d.ids[0];
  const mem = service.getById(id);
  if (!mem || mem.archived) continue;
  // 幂等检查
  const same = (d.title === undefined || d.title === mem.title)
    && (d.content === undefined || d.content === mem.content)
    && (d.importance === undefined || d.importance === mem.importance);
  if (same) continue;
  service.update(id, {
    title: d.title ?? mem.title,
    content: d.content ?? mem.content,
    importance: d.importance ?? mem.importance
  });
  applied++;
}
```

#### B. Prompt 增强（`src/dream.js`）

```javascript
const CONSOLIDATION_PROMPT = `你是记忆库整理助手...
4. 发现单条记忆中的信息已过时、错误或遗漏 → 输出 update（直接修正内容）
   - update 的 ids 只能包含一个 id
   - 必须提供修正后的 title 和/或 content
   - 仅当内容确实需要修正时才使用，不要滥用
   - 每次整理最多输出 2 个 update
   - 24 小时内新建的记忆不可 update
5. 无问题的条目 → 输出 keep`;
```

#### C. 审计增强（`src/dream.js`）

```javascript
// runDream 中，applyDecisions 前记录 update 的变更前快照
const updateSnapshots = {};
for (const d of decisions) {
  if (d.action === "update") {
    const mem = snapshot.get(d.ids[0]);
    if (mem) updateSnapshots[d.ids[0]] = { title: mem.title, content: mem.content, importance: mem.importance };
  }
}

// decisions 写入 audit 时，update 决策附加 _before
const auditDecisions = decisions.map(d => {
  if (d.action === "update" && updateSnapshots[d.ids[0]]) {
    return { ...d, _before: updateSnapshots[d.ids[0]] };
  }
  return d;
});

// buildOutcome 扩展
else if (d.action === "update") {
  byId[d.ids[0]] = "updated";
}
```

#### D. 向量索引同步（`src/dream.js`）

```javascript
// maintainIndexAfterDream 中新增
else if (d.action === "update") {
  const id = d.ids[0];
  const mem = service.getById(id);
  if (mem) {
    vectorIndex.deleteEmbedding(id);
    const text = [mem.title, mem.content].filter(Boolean).join("\n");
    const v = await embedder.embedSingle(text);
    if (v?.length) vectorIndex.saveEmbedding(id, v);
  }
}
```

#### E. 失败追踪表（`src/store.js`）

```sql
CREATE TABLE failure_memories (
  id TEXT PRIMARY KEY,
  query TEXT,           -- 用户原始查询/意图（可选）
  expected TEXT,        -- 期望结果
  actual TEXT,          -- 实际结果
  failure_type TEXT,    -- outdated / miss / wrong / user_correction
  memory_id TEXT,       -- 关联的记忆 id
  created_at TEXT NOT NULL
);
```

```javascript
// store.js 新增方法
saveFailure({ id, query, expected, actual, failure_type, memory_id })
listFailures({ limit, since, memory_id, failure_type })
getFailureStats({ since })  // 按类型统计失败次数
```

#### F. 失败追踪触发（`src/service.js` + tools）

```javascript
// service.js update() 方法增强
function update(id, patch) {
  const old = store.getById(id);
  const updated = store.update(id, patch);
  // 记录用户纠正
  if (old && updated && config.reflectionFailureTracking) {
    store.saveFailure({
      id: randomUUID(),
      expected: updated.content,
      actual: old.content,
      failure_type: "user_correction",
      memory_id: id,
      created_at: new Date().toISOString()
    });
  }
  syncMirror();
  notifyWrite();
  scheduleEmbed(updated);
  return updated;
}
```

#### G. 配置扩展（`src/config.js`）

```javascript
reflectionUpdateEnabled: z.boolean().default(true),
reflectionFailureTracking: z.boolean().default(true),
reflectionUpdateMaxPerRun: z.natural().min(0).max(5).default(2),
reflectionUpdateMinAgeHours: z.natural().min(0).max(168).default(24),
```

### 2.3 测试清单

| 测试 | 类型 | 说明 |
|---|---|---|
| update 校验：多 id | 单元 | `ids.length !== 1` → 拒绝 |
| update 校验：无变化 | 单元 | title/content/importance 全相同 → 拒绝 |
| update 校验：summary 类型 | 单元 | type="summary" → 拒绝 |
| update 校验：24h 保护 | 单元 | created_at < 24h → 拒绝 |
| update 校验：频率限制 | 单元 | >2 个 update → 拒绝全单 |
| update 应用：正常更新 | 单元 | title/content/importance 部分更新 |
| update 应用：幂等跳过 | 单元 | 内容已与目标一致 → 跳过 |
| update + 向量同步 | 集成 | 更新后向量索引一致性 |
| update + audit | 集成 | _before 快照正确记录 |
| failure 记录 | 集成 | update() 触发后 failure_memories 有数据 |
| failure 查询 | 单元 | listFailures / getFailureStats |

### 2.4 验收标准

- [ ] `update` 决策类型完整实现（校验 + 应用 + 向量同步）
- [ ] `failure_memories` 表创建 + 写入 + 查询
- [ ] 用户调用 `memory_update` 时自动记录 failure
- [ ] 所有新增代码测试覆盖率 ≥ 85%
- [ ] v0.2.0 向后兼容（默认 embedProvider="openai" 不变）

## 三、v0.2.2 计划：流水线补全

- reranker 专项测试（三策略降级/分数阈值/batch）
- clustering 专项测试（K-Means++/空簇/冲突检测）
- vector-index 专项测试（modelHash 漂移/重建/增量）
- service-search 端到端测试（hybrid/auto/rerank 对比）
- api.js 完善（mode 参数文档化、semantic 加 reranker 状态）
- 性能基准（benchmark:search / benchmark:rerank）

## 四、v0.2.3 计划：轻量结构化（记忆基因雏形）

- 实体抽取模块 `src/entities/extractor.js`（轻量 LLM 抽取 entity/attr/value，HTML 注释嵌入 content）
- 实体搜索增强（`entity:` 前缀，正则提取）
- autoDream 实体感知（同 entity 不同 attr value → update 而非 conflict）
- 配置开关 `entityExtractionEnabled` 默认 false（实验性）
- 为什么先不改 schema：验证准确率 + 积累数据 + 注释兼容 Markdown

## 五、v0.3.0 计划：记忆基因（正式结构化）

- 三张表：entities / entity_attrs（valid_from/valid_until 时间轴）/ entity_relations
- 时间轴查询、supersedes 链、知识图谱查询（`graph:user`）
- 迁移脚本：从 v0.2.3 注释标记解析填充新表

## 六、v0.3.1 计划：系统级睡眠（Sleep Mode）

- autoDream（轻量守护）vs Sleep（夜间批处理，凌晨 3 点 / 空闲 10 分钟）
- 分层压缩：活跃（7 天内）/ 温（7-30 天）/ 冷（30-90 天压缩 50 字摘要 + _full_content）/ 睡眠（>90 天归档）
- 模式发现：LLM 扫最近 100 条 → type="pattern" 记忆

## 七、v0.4.0 计划：反思性成长

- 纠错双向回流：修正记忆 + 记录 failure + 分析失败原因 + 反向优化
- 规则演进：每周扫 failure_memories，LLM 分析 → type="rule" 记忆
- 自适应参数：outdated/miss/irrelevant/user_correction 触发不同参数调整

## 八、v0.5.0+ 展望

兴趣漂移分析 / 跨 Workspace 协作 / 记忆联邦 / 可视化面板

## 九、关键设计原则

| 原则 | 说明 |
|---|---|
| **开关哲学** | 每个新特性都是 `config.xxxEnabled`，默认关闭，稳定后再默认开启 |
| **数据先行** | 先跑起来积累数据，再决定是否动 schema |
| **Fail-safe** | 任何新模块失败不阻断主流程，自动降级 |
| **审计优先** | 每次变更都有记录 |
| **Markdown 兼容** | 所有结构化信息先以注释形式落地 |

## 十、v0.2.1 启动检查清单

- [ ] Fork 分支：`git checkout -b feat/v0.2.1-reflection-update`
- [ ] 修改 `src/dream/decisions.js`（ACTIONS + validate + apply）
- [ ] 修改 `src/dream.js`（Prompt + _before 快照 + buildOutcome + maintainIndex）
- [ ] 修改 `src/store.js`（failure_memories 表 + saveFailure + listFailures）
- [ ] 修改 `src/service.js`（update() 触发 failure 记录）
- [ ] 修改 `src/config.js`（reflection 配置项）
- [ ] 编写测试（8 个单元/集成测试）
- [ ] 更新 `SEMANTIC.md`（新增 update 决策说明）
- [ ] 更新 `MIGRATION.md`（v0.2.0 → v0.2.1）
- [ ] `npm test` 全绿
- [ ] Commit：`feat(dream): add update decision type and failure tracking`
- [ ] Merge to main，打 tag `v0.2.1`
