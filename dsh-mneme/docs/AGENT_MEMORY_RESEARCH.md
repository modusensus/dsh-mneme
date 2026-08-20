> 📌 **归档说明**：本文由社区用户 **[@heptaspirit](https://github.com/heptaspirit)** 调研整理，经作者同意归档为 dsh-mneme **v0.7.0 规划参考输入**。
> 原始出处：[Discussion #21 — 兴趣漂移方向调研与思路分享](https://github.com/modusensus/dsh-mneme/discussions/21)
> 归档日期：2026-08-20

# dsh-mneme 记忆功能增强：调研笔记

> 日期：2026-08-20
>
> 在调研兴趣漂移的相关算法过程中陆续找了一些 agent memory 相关的文章，对照 mneme 的源码和本地数据整理了一下，觉得有些信息可能对 v0.7 的规划有点用，就写在这里。
>
> 这只是一次调研的整理，不是设计提案。里面提到的方向、建议、取舍，都以作者自己的判断为准——尤其是 mneme 本地化、低成本的定位，我在整理时一直拿它当标尺，凡是需要重型依赖的基本都划掉了。

---

## 一、调研来源

主要看了两篇综述性的材料，对这些资料里提到的架构设计进行了一些研究，外加对 mneme v0.6.0 源码和本地 memory.db 的核对：

1. 阿里云存储团队的《一口气读完 Agent Memory 的 21 篇论文》——agent memory 领域的全景梳理，从 MemGPT 到 Titans。
2. AWS 的《Agent 记忆系统的工程实践与演进》——生产环境下记忆系统的工程问题，五个方向都偏"跑久了才暴露"的类型。
3. 本地的 mneme 数据：79 条记忆，entities / entity_attrs / entity_relations 三张图谱表全是 0 条，recall_runs 也是 0 条。

## 二、两篇文章里跟 mneme 相关的部分

### 2.1 21 篇论文：挑几个有对照意义的系统

论文很多，跟 mneme 有实际对照价值的大概这些：

| 系统             | 核心机制              | mneme 的对应                                          | 差距                                         |
| -------------- | ----------------- | -------------------------------------------------- | ------------------------------------------ |
| MemGPT         | 虚拟内存分层 + LLM 自主换页 | hot-memory + 长期库 + 注入                              | 分层结构有了，缺"LLM 主动决定提升哪条记忆"                   |
| Zep / Graphiti | 时序知识图谱、边失效机制      | entities + entity_attrs（已有 valid_from/valid_until） | 属性层有时间戳，关系层没有（见建议 8）                       |
| Mem0           | LLM 判官：增删改        | autoDream 的 LLM 合并/冲突                              | 已覆盖；Mem0 v3 为省成本转向 ADD-only，mneme 的批处理方向一致 |
| MemOS          | 文本↔激活↔参数转换 + 冷热判断 | demoteToSummary / archived / restore               | 降级链完整，冷热判定正是 v0.7 heat 要补的                 |
| HippoRAG       | 海马索引 + PPR 图传播    | entities + relations                               | 图传播太重，1-hop 足够                             |
| Voyager        | 技能验证成功才入库         | pattern 类型                                         | pattern 可以"被引用过才升温"（远期）                    |
| CoALA          | 四类记忆划分            | hot-memory / history / preference / pattern        | 可作 TYPE_DECAY 的语义框架                        |

有一个点比较意外：mneme 的 entity_attrs 已经带 valid_from/valid_until（事实有效窗口），这是很多记忆系统都没有的，Graphiti 双时间轴的核心也就这个程度。属性层已经做了，关系层还没跟上。

### 2.2 AWS 工程实践：五个工程考量

AWS 那篇讲的都是"选型时看不出来、跑半年才显形"的问题，对照下来：

| 工程考量            | AWS 方案                              | mneme 现状                              | 备注                                            |
| --------------- | ----------------------------------- | ------------------------------------- | --------------------------------------------- |
| 写入纪律与失效机制       | 双 LLM 判官 / 六维打分 / workload-feedback | autoDream 合并 + sleep 降级               | 三类失效场景（低频但重要 / 时间新但语义旧 / 并存而非冲突）可写进 heat 模型约束 |
| Prompt Cache 冲突 | 冻结快照                                | 注入块在 system prompt                    | DSH 无显式 cachePoint，暂不可做                       |
| 跨模型容量           | 字符级上限                               | 已是字符级（MAX_BLOCK）                      | 方向一致，不用动                                      |
| Embedding 迁移    | 双写→回填→切换→归档                         | 换 embedder 需重建向量                      | v0.8+ 工程优化                                    |
| Skill 治理        | 写入与治理分离 + 可逆审计                      | pattern + receipt_chain + archived 不删 | mneme 已符合"治理可逆"原则                             |

AWS 文里 OpenClaw 的六维打分公式可以留作远期参考，其中四维在 mneme 的数据源上就能落地：

| 维度                        | 权重   | mneme 数据源         |
| ------------------------- | ---- | ----------------- |
| Relevance（召回后真被用上）        | 0.30 | 需"引用检测"，远期        |
| Frequency（短期引用次数）         | 0.24 | recall_runs       |
| Query diversity（被多少种问题触发） | 0.15 | recall_runs       |
| Recency（最近用过）             | 0.15 | last_accessed_at  |
| Consolidation（连续多天用）      | 0.10 | recall_runs       |
| Conceptual richness（概念密度） | 0.06 | tags + entity 关联数 |

不过 OpenClaw 的权重是黑盒、默认参数没法直接用，所以就算做也多信号也建议从单信号起步、公式留接口。

## 三、本地数据核对发现的两个前提问题

对照配置和调用链，发现图谱表和 recall_runs 都是 0 条的原因：

- `entityExtractionEnabled` 默认关——每次写入调一次 LLM 抽实体，关掉是合理的成本决策；
- `recordRecall` 是 opt-in 参数，默认不落库。

也就是说存储层、API、前端 ego graph 面板都就绪了，但数据源默认不积累。这影响的不只是图谱，也影响 v0.7 要做的"recall_runs 隐式反馈"——**如果保持默认关，就永远没有数据可用**。

所以建议里最前置的一条是：**记录默认开，消费默认关**。记录（recall 落库）成本接近零，先把数据攒起来；消费（用数据影响排序）保持默认关，行为不变。

## 四、可以做的方向（8 条，按依赖排序）

| # | 方向                               | 成本 | 依赖 |
| - | -------------------------------- | -- | -- |
| 1 | recall_runs 记录默认开、消费默认关          | 极低 | 无  |
| 2 | recall_runs 记 `injected` 标记      | 低  | 1  |
| 3 | heat 衰减 + TYPE_DECAY + 信号接口预留    | 中  | 无  |
| 4 | sleep 降级联合判定（importance/type 免疫） | 低  | 3  |
| 5 | 实体提取移入 sleep 批量阶段                | 低  | 无  |
| 6 | sleep 批量实体消歧                     | 中  | 5  |
| 7 | 1-hop 邻域回流检索 + heat 投影实体层        | 中  | 5  |
| 8 | 关系时效（valid_until + superseded）   | 低  | 5  |

### 4.1 数据前提（建议 1-2）

记录默认开、消费默认关，前面说过了。补充一条：recall_runs 的 candidates 上打个 `injected` 标记，"被召回"和"被注入进上下文"是两个强度不同的信号，打上标记以后要区分就有数据了。另外建议按 90 天滚动清理，防止无限膨胀。

### 4.2 heat 模型（建议 3-4）

v0.7 的方向在 #21 里已经定了（简化幂律 + type 差异化半衰期），这里只补充两点：

- 公式留个信号接口（新列或 metadata），以后想加多信号是增量不是重构。
- sleep 降级现在是 30/90 天硬阈值，不看 importance 不看 type，高价值的 preference 也会被降级。改成 `heat < 阈值 && importance < 5 && type 非免疫`，加两道保护，主体还是时间驱动。

另外一个小点：合并/更新刷新 updated_at 不应该算访问。如果将来排序用 updated_at 当新鲜度，会被 autoDream 的合并动作干扰——语义旧但时间戳新的记忆会显得很活跃。

### 4.3 图谱增强（建议 5-8）

图谱的存储、API、前端都好了，缺的是数据。所以这组建议第一步是让数据能攒起来，再考虑怎么用：

1. **实体提取移入 sleep 批量阶段**：写入时实时抽实体，LLM 成本落在写入路径上；挪到 sleep 里批量跑，写入路径零成本，只有开 sleep 的用户积累图谱。代价是图谱数据滞后一个 sleep 周期，对"长期关系网"来说无感。
2. **批量实体消歧**：extractor 目前明确不合并同义词，同一实体的全称/简称会变成多个孤立节点。sleep 批量消歧（仿 autoDream 的 winner/loser + 审计），或规则兜底（小写/去空格）。
3. **1-hop 邻域回流检索**：ego graph 的 BFS 代码在 api.js 里已经有了，检索侧直接复用——`entity:X` 顺带召回相邻实体的记忆。这是图谱相对纯向量检索的差异化价值，也是把图从"展示"变成"召回信号"的一步。
4. **heat 投影实体层**：实体热 = 关联记忆 heat 聚合，前端节点大小/明暗随热变化，兴趣漂移在图上可见。成本接近零，因为 heat 本来就是 v0.7 的改动。
5. **关系时效**：属性层有 valid_from/until，关系层补上 valid_until + superseded 标记（不删只标记，保留历史回溯），项目换方案后旧关系不会一直挂着。

## 五、暂时不做的方向

多数不是"明确不做"，而是"现在不划算"，作者如果觉得哪条值得可以捡起来。

**硬约束（基本排除）**：

| 方向    | 原因                   |
| ----- | -------------------- |
| 多模态记忆 | 需要大型在线多模态模型，与本地化定位冲突 |

**暂缓（条件成熟可重估）**：

| 方向                           | 暂缓原因                  | 重估条件                              |
| ---------------------------- | --------------------- | --------------------------------- |
| 参数化记忆（MemoryLLM/WISE/Titans） | 模型层改动，与插件定位互斥，另一条技术路线 | 基本放弃，除非 DSH 出模型层插件                |
| 图数据库 / Graphiti              | SQLite 递归 CTE 实测够用    | 实体十万级，或真要复杂模式匹配                   |
| PPR 图传播 / 社区子图               | 重型图算法，1-hop 够用        | 消歧做完 + 数据量上来 + sleep 预计算得分表       |
| MemOS 预加载 / KV-Cache         | KV-Cache 要 LLM 层接口    | "高 heat 记忆注入缓存预热"部分可做，等 heat 数据积累 |
| MIRIX 多 Agent 分工             | 新架构范式，subagent 场景没到   | subagent 常态化后，#17 的 scope 之上加路由即可 |
| Prompt cache 冻结快照            | DSH 无 cachePoint      | 实测缓存收益 > 会话内新鲜度损失；可先做"慢变部分冻结"折中   |

关于图数据库：本地验证过 SQLite 3.50.4 的递归 CTE（`WITH RECURSIVE`）做多跳查询完全可用，所以"图数据多了怎么办"的答案大概率不是上 Neo4j/Graphiti（那等于另起一套 Python + 图服务），而是继续用 SQLite 的 CTE——几千节点规模 BFS 也就几十毫秒。

## 六、如果参与 RFC，可以用这 9 条

1. recall_runs 记录默认开、消费默认关（最优先）
2. recall_runs candidates 记 `injected` 标记
3. heat 公式预留信号接口（不做闭式）
4. sleep 降级联合判定（importance/type 免疫）
5. 实体提取移入 sleep 批量阶段
6. sleep 批量实体消歧
7. 1-hop 邻域回流检索 + heat 投影实体层
8. 关系时效补全
9. 远期：多信号 heat、pattern 验证升温、workload-feedback、Embedding 迁移

## 七、这些建议对应的现有机制

| 建议  | 复用的现有机制                                         |
| --- | ----------------------------------------------- |
| 1-2 | recall_runs 表、touchRecalled                     |
| 3-4 | TYPE_DECAY（#21 已采纳）、sleep 批处理、archived          |
| 5-6 | sleep 的 LLM 阶段模式、receipt_chain、findEntityByName |
| 7   | api.js 的 ego graph BFS、entities 表               |
| 8   | entity_attrs 的 valid_from/until 模式              |

整理时的底线是每条建议都能在 mneme 现有的机制上找到承接点，无需引入新依赖、新概念。

---

## 参考来源

**近两年研究与经典：**

1. FadeMem：arXiv:2601.18642 → <https://arxiv.org/abs/2601.18642>
2. SSGM：arXiv:2603.11768 → <https://arxiv.org/abs/2603.11768>
3. TiMem：arXiv:2601.02845 → <https://arxiv.org/abs/2601.02845>
4. Adaptive Budgeted Forgetting：arXiv:2604.02280 → <https://arxiv.org/abs/2604.02280>
5. MaRS / Forgetful but Faithful：arXiv:2512.12856 → <https://arxiv.org/abs/2512.12856>
6. Generative Agents（Park et al., 2023）：arXiv:2304.03442 → <https://arxiv.org/abs/2304.03442>

**综述与工程：**  
7\. Agent Memory Consolidation 综述（Zylos, 2026-06）：<https://zylos.ai/research/2026-06-08-agent-memory-consolidation-selective-retention-forgetting>  
8\. 概念漂移与推荐系统（ACM, 2025）：<https://dlnext.acm.org/doi/10.1145/3707693>  
9\. 《一口气读完 Agent Memory 的 21 篇论文》（阿里云存储团队）：<https://github.com/adongwanai/AgentGuide/blob/main/resources/agent/papers/agent_memory/一口气读完agent%20memory的21篇核心论文.md>  
10\. AWS《Agent 记忆系统的工程实践与演进》：<https://aws.amazon.com/cn/blogs/china/agent-system-engineering-practice/>

**本项目相关：**  
11\. Discussion #21（兴趣漂移调研与采纳）：<https://github.com/modusensus/dsh-mneme/discussions/21>  
12\. Issue #17（记忆可见性边界，已纳入 v0.7 roadmap）：<https://github.com/modusensus/dsh-mneme/issues/17>

> 注：1–5 的 arXiv 编号来自检索结果引用，若编号有出入以 arXiv 检索为准。
