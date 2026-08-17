# dsh-mneme v0.4.0 系统级睡眠策划书（桉桉）

# dsh-mneme v0.4.0 策划书：系统级睡眠（Sleep Mode）

> **项目代号**：`dsh-mneme-sleep-mode`  
> **目标版本**：v0.4.0  
> **前置版本**：v0.3.9（450 测试全绿，审计加固 A/B/D/F 完成）  
> **文档状态**：策划阶段  
> **最后更新**：2026-08-17

---

## 一、背景与动机

### 1.1 v0.3.x 的成就

v0.3.9 完成了记忆基因的全部基础设施：

| 能力 | 状态 |
|---|---|
| 实体结构化 | ✅ entities / entity_attrs / entity_relations 三表 |
| 属性时间轴 | ✅ valid_until 机制，历史可追溯 |
| 实体搜索 | ✅ entity: / attr: 前缀搜索 |
| 审计加固 | ✅ CAS 同事务 + degraded 回执 + 逐 type 物理终态 + 整数 fail-closed |
| 测试覆盖 | ✅ 450/450 全绿 |

### 1.2 当前痛点

autoDream 是**被动触发**的——只有写入量达到阈值时才整理。这导致：

| 场景 | 问题 |
|---|---|
| 用户长期不写入新记忆 | 记忆库逐渐膨胀，无人整理 |
| 大量冷记忆占用活跃空间 | 搜索召回质量下降 |
| 高阶规律沉睡在文本中 | 无法自动提取模式（pattern） |
| 夜间系统空闲 | 算力浪费，整理任务堆积 |

### 1.3 Sleep Mode 的核心价值

将 autoDream 从"**被动阈值触发**"升级为"**主动定时维护 + 分层压缩**"：

```
autoDream（轻量守护）          Sleep（深度维护）
├── 阈值触发（写入量）         ├── 定时触发（空闲时间）
├── merge/archive/conflict      ├── 更激进的 conflict 消解
├── update（单条修正）          ├── 归档降级（冷记忆压缩）
└── summary 生成                ├── 模式发现（高阶规律提取）
                                └── 实体关系补全
```

---

## 二、设计原则

| 原则 | 说明 |
|---|---|
| **非侵入** | Sleep 不阻塞用户操作，后台异步运行 |
| **可中断** | 用户恢复活动时，Sleep 立即暂停，保留进度 |
| **分层压缩** | 活跃/温/冷/睡眠 四级记忆，搜索质量与存储成本平衡 |
| **模式发现** | 从大量记忆中提取高阶规律，输出 type="pattern" 记忆 |
| **审计延续** | Sleep 周期同样生成 receipt，与 autoDream 审计链打通 |

---

## 三、核心架构

### 3.1 睡眠周期（Sleep Cycle）

```
用户活动检测
    ↓
系统空闲 5 分钟 → 触发 Sleep Cycle
    ↓
Phase 1: 冲突消解（Conflict Resolution）
    - 扫描全部实体属性，发现矛盾对
    - 比 autoDream 更激进的裁决（可配置 strictness）
    - 输出：conflict + update + merge
    ↓
Phase 2: 归档降级（Archival Degradation）
    - 按活跃度分层处理
    - 输出：压缩摘要 / 完全归档 / 实体关系保留
    ↓
Phase 3: 模式发现（Pattern Discovery）
    - LLM 扫描最近 N 条记忆 + 实体变更历史
    - 输出：type="pattern" 记忆
    ↓
Phase 4: 实体关系补全（Entity Relation Completion）
    - 检查孤立实体，补全隐含关系
    - 输出：新增 entity_relations
    ↓
生成 Sleep Receipt → 保存到 dream_runs（与 autoDream 共用审计表）
```

### 3.2 分层压缩策略

| 层级 | 条件 | 动作 | 搜索可见性 |
|---|---|---|---|
| **活跃记忆** | 7 天内被召回 | 保持完整，优先注入 | 高 |
| **温记忆** | 7-30 天未召回 | 保留完整，降低 importance | 中 |
| **冷记忆** | 30-90 天未召回 | 压缩为 50 字摘要，原内容移到 `_full_content` | 低（仅关键词匹配） |
| **睡眠记忆** | >90 天未召回 | 完全归档，仅保留实体关系 + 摘要 | 极低（仅 entity: 搜索） |

**压缩实现**：
```javascript
async function compressMemory(memory, ctx) {
  if (memory.content.length <= 100) return memory; // 已够短，不压
  
  const prompt = `将以下记忆内容压缩为 50 字以内的核心摘要，保留关键实体和属性：\n\n${memory.content}`;
  const summary = await ctx.llm?.streamText?.([{ role: "user", content: prompt }]) 
    ?? memory.content.slice(0, 50);
  
  return {
    ...memory,
    content: summary + "\n\n（原内容已压缩，完整版见归档）",
    _full_content: memory.content,
    _compressed_at: new Date().toISOString()
  };
}
```

### 3.3 模式发现（Pattern Discovery）

**触发条件**：Sleep 周期中，记忆库 > 100 条且最近 7 天无新模式生成。

**输入**：
- 最近 100 条记忆（按 updated_at 排序）
- 最近 30 天内变更的 entity_attrs
- 高频出现的实体对（co-occurrence）

**Prompt**：
```
你是模式发现助手。请从以下记忆和实体变更中提取高阶规律：

规则：
1. 规律必须是可验证的，有具体证据支撑
2. 规律应该跨越单条记忆，反映趋势或关联
3. 不要输出显而易见的常识
4. 输出严格的 JSON 格式

输出格式：
{
  "patterns": [
    {
      "title": "规律标题",
      "description": "规律描述",
      "evidence": ["memory_id_1", "memory_id_2"],
      "confidence": 0.85,
      "scope": "user_behavior" // user_behavior / project_evolution / technology_trend
    }
  ]
}
```

**输出存储**：
```sql
-- 复用 memories 表，type="pattern"
INSERT INTO memories (id, type, title, content, importance, source, created_at)
VALUES ('pat_xxx', 'pattern', '规律标题', '规律描述 + 证据', 3, 'sleep_discovery', now);
```

### 3.4 实体关系补全

**触发条件**：Sleep 周期中，发现孤立实体（无 relation 的 entity）。

**策略**：
1. 检查该实体是否与其他实体在同一记忆中共现
2. 如果是 → 建立 `related_to` 关系
3. 如果是同一项目/团队的实体 → 建立 `part_of` 关系
4. 如果是技术栈依赖 → 建立 `depends_on` 关系

---

## 四、具体方案

### 4.1 Sleep 调度器（`src/dream/sleep.js`）

```javascript
export function createSleepScheduler({ service, store, config, logger, ctx }) {
  let idleTimer = null;
  let lastActivity = Date.now();
  let isSleeping = false;
  let sleepAbort = null;
  
  // 用户活动标记
  function markActive() {
    lastActivity = Date.now();
    clearTimeout(idleTimer);
    
    if (isSleeping && sleepAbort) {
      sleepAbort.abort(); // 中断当前 Sleep 周期
      logger?.info?.("dsh-mneme sleep: user active, sleep cycle aborted");
    }
    
    idleTimer = setTimeout(checkAndRun, config.sleepIdleMinutes * 60 * 1000);
  }
  
  async function checkAndRun() {
    if (!config.sleepModeEnabled || isSleeping) return;
    if (Date.now() - lastActivity < config.sleepIdleMinutes * 60 * 1000) return;
    
    isSleeping = true;
    sleepAbort = new AbortController();
    
    try {
      logger?.info?.("dsh-mneme sleep: starting sleep cycle");
      await runSleepCycle({ service, store, config, logger, ctx, signal: sleepAbort.signal });
    } catch (err) {
      if (err.name === 'AbortError') {
        logger?.info?.("dsh-mneme sleep: cycle aborted by user activity");
      } else {
        logger?.warn?.("dsh-mneme sleep cycle failed:", err.message);
      }
    } finally {
      isSleeping = false;
      sleepAbort = null;
    }
  }
  
  return { markActive, dispose: () => { clearTimeout(idleTimer); if (sleepAbort) sleepAbort.abort(); } };
}
```

### 4.2 Sleep 周期执行（`runSleepCycle`）

```javascript
async function runSleepCycle({ service, store, config, logger, ctx, signal }) {
  const receipt = { phases: [], started_at: new Date().toISOString() };
  
  // Phase 1: 冲突消解
  if (!signal.aborted) {
    const conflicts = await resolveConflicts({ service, store, config, ctx, signal });
    receipt.phases.push({ name: 'conflict_resolution', applied: conflicts.length });
  }
  
  // Phase 2: 归档降级
  if (!signal.aborted) {
    const archived = await archivalDegradation({ service, store, config, ctx, signal });
    receipt.phases.push({ name: 'archival_degradation', applied: archived.length });
  }
  
  // Phase 3: 模式发现
  if (!signal.aborted && store.count() > 100) {
    const patterns = await patternDiscovery({ service, store, config, ctx, signal });
    receipt.phases.push({ name: 'pattern_discovery', applied: patterns.length });
  }
  
  // Phase 4: 实体关系补全
  if (!signal.aborted) {
    const relations = await relationCompletion({ service, store, config, ctx, signal });
    receipt.phases.push({ name: 'relation_completion', applied: relations.length });
  }
  
  receipt.finished_at = new Date().toISOString();
  store.saveDreamRun({ ...receipt, type: 'sleep' }); // 复用 dream_runs 表
  
  logger?.info?.(`dsh-mneme sleep: cycle complete, phases: ${receipt.phases.map(p => `${p.name}=${p.applied}`).join(', ')}`);
}
```

### 4.3 配置扩展（`src/config.js`）

```javascript
// Sleep Mode（v0.4.0）
sleepModeEnabled: z.boolean().default(false),
sleepIdleMinutes: z.natural().min(1).max(60).default(5),
sleepConflictStrictness: z.union([
  z.literal("gentle"),   // 只处理高置信度冲突
  z.literal("normal"),   // 标准 autoDream 级别
  z.literal("aggressive") // 更激进的裁决
]).default("normal"),
sleepArchiveDays: z.natural().min(7).max(365).default(30),
sleepCompressDays: z.natural().min(7).max(365).default(90),
sleepPatternMinMemories: z.natural().min(10).max(1000).default(100),
sleepPatternLookbackDays: z.natural().min(1).max(90).default(30),
sleepMaxPatternPerRun: z.natural().min(0).max(10).default(3),
```

### 4.4 与 autoDream 的关系

| 维度 | autoDream | Sleep Mode |
|---|---|---|
| **触发** | 写入阈值（10条/5000字符） | 系统空闲（5分钟无活动） |
| **频率** | 每次写入后检查 | 每小时检查一次 |
| **范围** | 增量（新写入的记忆） | 全量（整个记忆库扫描） |
| **深度** | 轻量（merge/archive/conflict/update） | 深度（冲突消解+归档+模式发现+关系补全） |
| **中断** | 不可中断（运行时间短） | 可中断（用户恢复活动时暂停） |
| **审计** | receipt 存入 dream_runs | receipt 存入 dream_runs（type='sleep'） |

**两者共存**：
- autoDream 负责**实时轻量整理**（每次写入后）
- Sleep 负责**定时深度维护**（系统空闲时）
- 两者共享 `dream_runs` 审计表，通过 `type` 字段区分

---

## 五、实施计划

### Phase 1：Sleep 调度器 + 基础框架（2-3 小时）

| 任务 | 文件 | 说明 |
|---|---|---|
| Sleep 调度器 | `src/dream/sleep.js` | 空闲检测 + 可中断执行 |
| 配置项 | `src/config.js` | sleepModeEnabled 等 6 项配置 |
| 活动监听 | `src/index.js` | 用户写入/搜索时 markActive |
| 中断机制 | `src/dream/sleep.js` | AbortController 实现 |

### Phase 2：归档降级（2 小时）

| 任务 | 文件 | 说明 |
|---|---|---|
| 活跃度查询 | `src/store.js` | getMemoriesByRecency / getUnrecalledSince |
| 压缩逻辑 | `src/dream/sleep.js` | compressMemory + _full_content 保存 |
| 分层处理 | `src/dream/sleep.js` | 活跃/温/冷/睡眠 四级逻辑 |

### Phase 3：冲突消解 + 模式发现（3-4 小时）

| 任务 | 文件 | 说明 |
|---|---|---|
| 冲突扫描 | `src/dream/sleep.js` | 全量实体属性矛盾检测 |
| 模式发现 | `src/dream/sleep.js` | LLM 扫描 + pattern 生成 |
| 关系补全 | `src/dream/sleep.js` | 孤立实体检测 + 隐含关系建立 |
| receipt 生成 | `src/dream/sleep.js` | 复用 dream_runs 表，type='sleep' |

### Phase 4：测试与文档（2-3 小时）

| 测试 | 类型 | 说明 |
|---|---|---|
| 空闲触发 | 单元 | 5 分钟无活动后触发 |
| 用户中断 | 单元 | 恢复活动时 Sleep 立即暂停 |
| 归档降级 | 集成 | 30 天未召回记忆被压缩 |
| 分层正确性 | 集成 | 活跃/温/冷/睡眠 四级边界 |
| 模式发现 | 集成 | Mock LLM 输出，验证 pattern 存储 |
| 关系补全 | 集成 | 孤立实体被正确关联 |
| receipt 审计 | 集成 | Sleep receipt 存入 dream_runs |
| Fail-safe | 集成 | Sleep 失败不阻塞主流程 |

| 文档 | 说明 |
|---|---|
| `docs/SLEEP.md` | Sleep Mode 设计文档 |
| `MIGRATION.md` | v0.3.x → v0.4.0 迁移说明 |
| README 更新 | 新增 Sleep Mode 特性说明 |

---

## 六、风险评估与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Sleep 占用过多 CPU/内存 | 中 | 中 | 可中断设计；Phase 分批执行；配置 maxDuration |
| 压缩摘要丢失关键信息 | 中 | 高 | 保留 _full_content；压缩后人工可恢复；confidence 阈值 |
| 模式发现 hallucination | 中 | 中 | 必须有 evidence 支撑；maxPatternPerRun 限制；人工可删除 |
| Sleep 与 autoDream 冲突 | 低 | 高 | 两者操作不同记忆子集；CAS 守卫；事务隔离 |
| 用户误以为 Sleep 是 bug | 低 | 低 | 日志输出 "Sleep cycle started"；Web 面板显示状态 |

---

## 七、验收标准

- [ ] `sleepModeEnabled: true` 后，系统空闲 5 分钟触发 Sleep Cycle
- [ ] 用户恢复活动时，Sleep 立即中断，不阻塞操作
- [ ] 30 天未召回记忆被压缩为摘要，原内容保存到 `_full_content`
- [ ] 90 天未召回记忆完全归档，仅保留实体关系
- [ ] Sleep 周期生成 receipt，存入 dream_runs（type='sleep'）
- [ ] 模式发现输出 type="pattern" 记忆，有 evidence 支撑
- [ ] 孤立实体被自动补全关系
- [ ] 新增测试 ≥ 15 个，全绿
- [ ] 文档：`docs/SLEEP.md` + README 更新

---

## 八、与后续版本的关系

| 版本 | 依赖 v0.4.0 的什么 | 新增什么 |
|---|---|---|
| **v0.4.1** | Sleep 调度器 | 夜间定时触发（cron 模式，非空闲触发） |
| **v0.4.2** | 模式发现 | 自适应参数（根据 pattern 调整 autoDream 阈值） |
| **v0.5.0** | 完整 Sleep + Pattern | 纠错双向回流（从 failure 中提取规律，反向优化策略） |

---

## 九、一句话总结

> **v0.4.0 的 Sleep Mode 是 dsh-mneme 从"被动整理"进化为"主动维护"的关键一步。autoDream 负责实时轻量整理，Sleep 负责定时深度维护——冲突消解、归档降级、模式发现、关系补全。可中断、可审计、Fail-safe，让记忆库在无人值守时也能自我进化。**