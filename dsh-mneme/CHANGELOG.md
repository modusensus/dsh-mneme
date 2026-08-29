# Changelog

## [0.7.3] - 2026-08-29

### 🆕 新功能（issue #38）

- **左下角入口按钮可关闭**：新增配置 `showSidebarTrigger`（默认 `true`，关闭时行为与之前完全一致）。dsh-mneme 的记忆入口按钮注入在侧边栏底部 footer slot（左下角），与同样抢占该位置的插件（如 dsh-cost-meter）冲突时 UI 会叠加/错乱。现在可在 **Web 面板「设置」→「侧边栏入口按钮」**一键关闭；关闭仅隐藏按钮，记忆库仍可通过顶部「记忆库」标签访问，功能不受影响
- 设置走 settings-over-config（与 `autoTagEnabled` 同机制）：面板开关持久化到 `user_settings`，未触碰时回退插件配置默认值；`/api/dsh-mneme/config` 的 GET/PUT 同步支持该字段（PUT 只接受布尔，非法值 400）

### 测试

- 新增 7 个回归测试（api 3 + settings 2 + config 1 + client 1），全套 **776 通过**

## [0.7.2] - 2026-08-26

### 🐛 修复（issue #35）

- **目录页删除按钮点击无反应**：`lib/client.js` 的 `DirectoryPanel.handleDelete` 之前依赖宿主 `window.confirm`（在 DSH 宿主 web 环境不可靠，可能被拦截或直接返回 false，点击看起来无反应），且删除失败的所有路径都被静默吞掉。改为**面板内联两步确认**（点 ✕ → 按钮变「确认？」→ 再点才发 DELETE，3 秒自动重置，点击行内其它地方取消），不再依赖任何原生对话框；删除失败（网络 / 401 / 500 / `deleted!==true`）时行内红色错误提示「删除失败」，3.5 秒自动消失，不再静默

### 🆕 新功能（issue #34）

- **对话开始自动注入当前时间**：新增 opt-in 配置 `injectTimePrefix`（默认 `false`，关闭时行为与之前完全一致）。开启后，新对话开始时在注入文本头部注入一次当前日期时间（格式 `[当前时间: 2026-08-26 周二 19:30]`，星期中文），按 session 闩锁——同一会话只注入一次，新会话再注入，满足"只需对话开始时"

### 测试

- 新增 6 个回归测试（client 2 + inject 3 + config 1），全套 **770 通过**

## [0.7.1] - 2026-08-24

### 🐛 修复（issue #31）

- **memory_save / memory_update 的 tags 桥接进 entity_attrs 标签存储**：工具传入的 tags 之前只写 `memories.tags` 列，目录视图（`getDirectory`）/ `tag:` 检索 / tagBoost 从 `entity_attrs`（attr_key='tags' AND valid_until IS NULL）读取，导致看不到；现在 `saveWithDedupe` 创建/合并分支与 `service.update` 在写入后同步调 `store.setMemoryTags(id, tags)`，显式 `tags: []` 会把记忆移回 untagged
- **`store.setMemoryTags` 反向同步 `memories.tags` 列**：手动/autoTag 打标后，搜索结果与 API 返回的 `memory.tags` 不再和目录漂移
- **autoTag 面板开关成为运行时真正的消费方**：dream 的 autoTag 判定与 `service.setMemoryTags` 的 manual 门禁改为读取「settings 覆盖合并 plugin config」的有效值；`getAutoTagConfig()` 未存储键返回 `null` 而非 `false`，`setAutoTagConfig` 只持久化用户实际触碰的键（部分更新不再误关另一开关）；`manualTagEnabled` 默认统一为插件配置的 `true`
- 新增 7 个回归测试，全套 764 通过

## [0.7.0] - 2026-08-24

### 🆕 自进化记忆（heat 热度模型）

让记忆库从"存得准、召得回"进化为会自我衰减、识别兴趣漂移的智能体：

- **幂律衰减 + per-type 差异化半衰期**：`H = 1/(1+λ·Δt)^α`，预置 TYPE_DECAY（preference/pattern/summary 免疫 λ=0；project 慢衰减 0.0008；decision 中速 0.002；history 较快 0.006）；全局 `heatGlobalAlpha`(默认 1.2) 控制形状
- **sleep 热联合双保护**：降级需同时满足"冷"(heat < sleepHeatThreshold 0.05) +"非紧要"(importance < 5) +"非免疫类型"——冷但重要与热但低值均受保护，immune 类型永不因 sleep 降级
- **updated_at ≠ 访问语义修正**：合并/更新刷 updated_at 不再计为访问；sleep demotion ref 只用 `last_accessed_at ?? created_at`；touchRecalled 由 `heatEnabled` 门控而非 `sleepModeEnabled`
- **recall_runs injected 两档标记**：搜索帧 `injected:false`(被召回)，注入帧 `injected:true`(被注入上下文)；两路都受 `recallRecordDefault` 门控；mode="inject" 也记账
- **90 天滚动清理**：`purgeRecallRunsOlderThan(days)` 启动时按 `recallRetentionDays`(默认 90) 清理，防膨胀
- **实体热投影**：ego-BFS API 节点带 `heat` 字段（关联记忆 heat max）；前端 `nodeRadius`/`fillOpacity` 随热度变化，兴趣漂移在图谱上可见
- **配置新增**：`heatEnabled`(true)、`heatGlobalAlpha`(1.2)、`heatTypeDecay`(TYPE_DECAY)、`sleepHeatThreshold`(0.05)、`recallRecordDefault`(true)、`recallRetentionDays`(90)

### 修复

- **sleep 降级误保护问题修复**：既有 `sleep.test.js` 降级测试因新热闸变为 noop → 加 `demotionConfig()` 帮助函数把 project λ 调快到 0.02，复现旧路径（默认保守语义由 `sleep-heat.test.js` 单独覆盖）；`updated-at-semantics.test.js` 同理调整
- **注入帧 source 冲突**：注入帧 source 固定 `"inject"`，不与记忆行自带的来源列混淆

### 测试

735 → **757** 全绿（新增 `heat.js` 纯模块 6 测 + `sleep-heat.test.js` 5 测 + `recall-runs.test.js` 5 测 + `updated-at-semantics.test.js` 3 测 + `graph-api.test.js` ego-node heat 2 测 + `recall-layer.test.js` 2 测更新 + `sleep.test.js` + `sleep-heat.test.js` 适配 5 处 + `recal l-layer.test.js` 适配 2 处）。

## [0.6.11] - 2026-08-23

### 修复
- **memory 渲染器暴露记忆 ID 并抗注入（PR #27，社区贡献 Jstn-1g）**：工具结果会进入 Agent 上下文，现做有界渲染——限制条数（search 20 / list 50）、整体块预算上限，标题/标签/正文按 Unicode code point 边界截断（emoji 保持完整、不劈半 surrogate），转义换行、引号、反斜杠与 ` `/` ` 等防 JSONL 框架注入；`id` 作为后续操作句柄绝不截断，超限整条省略并在 summary 里报告而非输出无效句柄。关联 issue #14（Agent 无法自主删除记忆）。
### 测试
- 723 → **735** 全绿（新增 memory 渲染器 12 条边界用例）。

## [0.6.10] - 2026-08-23

### 质量优化（记忆面板卡片布局 polish）
- **清理死 CSS**：移除卡片式布局重构后遗留的 `.mneme-xside` / `.mneme-xside--filter` / `.mneme-xbrowse` / `.mneme-xtree` / `.mneme-xdetail` 5 行无引用的定义（三卡实际用 `mneme-card--search/tree/detail`）。
- **合并 `.mneme-xmain` 双定义**：旧 `row` 版并入唯一 `column` 版，消除同 selector 重复声明。
- **补无障碍（a11y）**：分类栏 `mneme-xtype` 按钮加 `aria-pressed`；三张卡片加 `role="region"` + `aria-label`；搜索框加 `aria-label`。
- **测试**：723 全绿（纯 CSS / aria 改动，用例数不变）。

## [0.6.9] - 2026-08-23

### 修复
- **autoDream 恒失败（Issue #26，P0：跳过非法决策）**：模型几乎必然为语义相关性产出跨类型 merge（`decision[4]: merge ids span multiple types (decision, preference)`），而 `validateDecisions` 硬性禁止跨类型合并（提示词亦注明「仅合并同类型」），此前「任意非法即整单拒绝」导致整批 consolidation 完全不应用（`applied=0`、空转一次 LLM 调用），并连带阻塞依赖 dream 成功的 `autoTag`。现改为：`dreamSkipInvalid`（默认 `true`）下逐条非法的决策被**跳过**、应用合法子集（`applied>0`），run 状态记为 **`degraded`**（不再是 `failed`），审计行 `outcome.skipped` 记录被跳过的决策、`error` 注明跳过数；`autoTag` 照常触发。防洗白语义不变：显式覆盖率不足（截断输出）、update/create 超量等**全局**错误仍整单拒绝。`dreamSkipInvalid:false` 可恢复旧的整单拒绝行为。

### 新增
- **`allowCrossTypeMerge`（Issue #26，P1：显式放开跨类型合并）**：默认 `false` 保持现有类型边界（`preference` 注入权重更高、`decision`/`project` 注入上下文不同，合并会丢类型信息）；显式开启后跨类型 merge 被视为合法、可被应用，类型边界由用户自行承担。

### 测试
- 716 → **723** 全绿（新增 skipInvalid 单元/集成、allowCrossTypeMerge、退出开关共 7 用例；环境既有 2 例除外：graph-api 时序 <50ms、reranker 本地缺 `@huggingface/transformers`）。

## [0.6.8] - 2026-08-22

### 修复
- **dream/sleep LLM 路由优先级（Issue #25）**：`resolveRoute` / `resolveSleepRoute` 原先总是先取 `agentDefaultModel.currentSelection()` 并直接返回，导致 `dreamProvider`/`dreamModel`、`sleepProvider`/`sleepModel` 在标准 DSH 安装下恒为死代码（`dream_runs` 审计表的 `provider`/`model` 始终是 agent 默认模型，配置的模型从未生效）。现改为显式 config 路由优先、agent 默认降为回退：dream 顺序为 `dreamProvider/dreamModel` → agent 默认；sleep 顺序为 `sleepProvider/sleepModel` → `dreamProvider/dreamModel` → agent 默认。这同时打通了 #9 的「换用非思考模型」出路——此前即便配置了廉价/非思考模型也无法生效。

### 测试
- 用例总数不变（716）；更新 `dream.test.js` / `llm-audit.test.js` 的 `model_id` 断言为配置路由（`deepseek:deepseek-chat`）。

## [0.6.7] - 2026-08-22

### 新增（记忆面板前端增强）
- **记忆删除端点**：新增 `DELETE /api/dsh-mneme/memories`（按 `id` 或 `query` 删除，对齐 `memory_delete` 工具）；`GET`/`PUT /api/dsh-mneme/config` 提供 `autoTagEnabled`/`manualTagEnabled` 读写（partial 更新，默认关）。
- **记忆删除 UI**：目录视图支持选中删除记忆（二次确认 + 本地不可变移除）；新增「编辑模式」开关（读写 `manualTagEnabled`），编辑态删除按钮常显，移动端可删。
- **autoTag 手动开关**：settings 面板新增 autoTag（自动打标签）开关，独立加载 `GET /api/dsh-mneme/config`（不阻塞 profile/rules/commands/vector），saveAutoTag 写 `autoTagEnabled`。
- **记忆页卡片式布局**：中间分类栏（`.mneme-xfilter-bar`）+ 底部三卡片（search/tree/detail，`.mneme-xcards`），替换原横向三栏。

### 修复
- **卡片布局 CRITICAL 括号错位**（子 agent 复核 + 逐层核验）：tree 卡嵌套 months.map 后缺一个关闭 `)`，导致 detail 卡被错误吞进 tree 卡内部（括号总数平衡故语法检查/测试均过，仅渲染时三卡布局错位）。修复：补关 tree 卡 + 去掉补偿性多余括号，核验三卡已平级为 xcards 直接子节点。

### 测试
- 710 → **716** 全绿（新增删除端点 / config 读写 / 目录文件树 / 卡片布局用例）。

## [0.6.6] - 2026-08-20

### 修复
- **kimi-k3 复验 2 项**：autoTag 跳过已打标记忆（不再每轮重复打同一批最新记忆、老记忆饿死；写时与现有 tags 合并，不覆盖人工标签）；`tag:` 搜索的召回统计（touchRecalled）改由 `recordRecall` 门控，面板搜索不再污染遗忘曲线。

### 测试
- 709 → **710** 全绿（新增 autoTag 跳过已打标用例）。

## [0.6.5] - 2026-08-20

### 新增
- **Tag 标签系统**：`#标签` 格式解析（规则 `[a-zA-Z0-9_一-龥-]+`，≤20字符，非法/超长自动丢弃）；autoDream 整理后 LLM 自动打标 1-3 个（fail-safe 保护，`autoTagMaxPerRun=10` 限频）；`tags` 统一落盘至 `entity_attrs`（`attr_key='tags'` JSON）；新增 `tag:` 搜索前缀（支持与关键词、`entity:`、`attr:` 自由组合）；Mirror 视图顶部渲染 `#tag` 标识行；记忆面板集成交互式标签 Chip（点击过滤/添加/移除）；全功能默认 opt-in，同步开放 3 组独立配置。
- **目录视图**：面板新增「目录」视图，按 tag 分组生成一级手风琴文件夹，无标签记忆归入「无标签」兜底组；组内按重要性/时间双降序排列；点击条目直跳详情页；新增 `GET /api/dsh-mneme/directory` 端点输出结构化树。
- **Tag 加权召回**：检索二次重排增强。候选记忆 tags 与 Query 提取 tags（含 `#xxx` 及已知列表）交集 → 基础分 `×1.15`；与 Session 热记忆 tags 交集 → `×1.08`；opt-in 设计（`tagBoostEnabled=false` 默认），支持开关对比调优。

### 修复
- **边界与稳定性**：自动清理空 tag 残留；严格拦截超长 tag；循环 wiki-link 无遍历死循环（读侧纯查询，不递归）。
- **数据同步**：多标签记忆在目录分组、搜索面板与底层 JSON 间的状态一致性校验。

### 测试
- 628 → **709** 全绿（新增 tag-boost 11 + 边界鲁棒性 6 + 版本内集成覆盖）。

> 📌 注：v0.6.2 / v0.6.3 / v0.6.4 为开发代号，功能随本版一并发布。

## [0.6.1] - 2026-08-20

### 新增

- **Wiki-Link 双向链接（笔记化记忆库第一步）**：记忆正文支持 `[[target]]` / `[[显示|target]]` 双括号链接语法，新解析器 `src/parser/wikilink.js` 统一在保存时抽取目标，写入 `entity_relations` 的 `links_to` 关系（新增 `partial` 唯一索引 `(source_memory_id, relation)` 仅对 `links_to` 去重，其余关系保持 append-only 不丢 supersedes 审计）。
- **service 三 API + 保存后异步解析**：`service.getBacklinks(memoryId)` / `service.getForwardLinks(memoryId)` / `service.resolveWikiLink(name)`；记忆保存后经 `enqueue` 串行 fire-and-forget 异步解析链接，不阻塞主保存流程。
- **3 只读 HTTP 端点**：backlinks / forward-links / wikilink-resolve，输出脱敏（不泄漏 source 原文），配套前端 BackLinksPanel React 组件 + 正文 wikilink 渲染。
- **`wikiLinkEnabled` 配置**：默认 `false`（opt-in），开启后才解析/渲染链接，保持旧行为。

### 修复

- **code review 2 项**：全表 UNIQUE 索引改为 `partial` 唯一索引（仅 `links_to`），防老库启动崩溃（存量其他关系撞唯一约束）；`saveRelation` 还原 append-only 语义，不再吞 supersedes 审计。

### 测试

- 628 → **654** 全绿（新增 `test/wiki-link.test.js`：parser 语法/别名/转义 + store partial 索引去重 + service 三 API + 异步解析串行 + 端点脱敏）。

## [0.6.0] - 2026-08-20

### 新增

- **会话生命周期（把会话当存档点）**：新配置 `sessionLifecycleEnabled`（默认 `false`）。开启后，会话被删除/销毁（`session/disposed` 宿主事件）时自动把该会话内出生（`session_id` 溯源）的记忆**软隐藏**——`session_disposed_at` 标记，隐藏于检索/注入/列表/整理，但不删除，随时可恢复。独立 `session_disposed_at` 字段与 `archived`（用户/AI 主动归档）**正交**：restore 只清 disposed 标记，绝不复活用户手动归档的记忆。存量无 `session_id` 的记忆视为全局，永不参与会话清理。默认关闭保持旧行为，销毁会话不影响记忆。
- **store/service 新增接口**：`store.setDisposedBySession(sessionId, disposed)`（幂等，状态守卫 WHERE 只动 IS NULL / IS NOT NULL 行，返回实际翻转行数）、`service.disposeBySession(sessionId)`、`service.restoreBySession(sessionId)`、`service.listBySession(sessionId, { includeDisposed })`（默认隐藏 disposed）。
- **memory_delete 支持描述删除**：`memory_delete` 增加 `query` 参数，可按描述匹配删除，不只靠记忆 ID（PR #16）。
- **事件订阅熔断**：`session/disposed` 事件回调内部异常 catch 住，不抛进 DSH 会话清理流程——用户删个对话不会搞崩插件。

### 修复

- **code-review 4 项（阿里云 kimi-k2.7-code 审查）**：`store.listBySession` 默认过滤 `session_disposed_at` + `service.listBySession` 透传 `includeDisposed`（已隐藏记忆不再从该路径重新暴露）；`toApiList` 条件输出 `disposed` 标记（restore 不再盲操作）；补 `(session_id, session_disposed_at)` 复合索引（置于 addColumn 迁移后，兼容 legacy 库）。

### 测试

- 613 → **628** 全绿（新增会话生命周期 13 例：store 4 例——迁移重启存活/dispose 幂等 round-trip/search+list 排除/searchVector 排除/setDisposedBySession 状态守卫，service 7 例——dispose 只影响该会话/restore 清标记/幂等/未知会话空操作/legacy 全局记忆/restore 不复活手动归档/正交性/listBySession 默认隐藏 + includeDisposed 可见 + DTO 携带 `disposed` 标记；另含 memory_delete `query` 删除 2 例）。

## [0.5.3] - 2026-08-20

### 新增

- **`dreamReasoningEffort` / `sleepReasoningEffort` 支持 `off`**：显式关闭思考。deepseek-v4-flash 等思考型模型即使 `none`（不传字段）也会按默认 thinking 把整个 token 预算烧在推理上，返回空正文（`no json array in llm output`；deepseek harness 实测 `finish_reason:"length"`、content 长度 0、8192 completion = 8192 reasoning）。设 `off` 后 12s / 2075 token 即完成，且 `dreamMaxTokens: 8192` 默认值保持够用。sleep 侧同步支持。

### 修复

- **决策字段名归一化兜底（deepseek harness 实测）**：`extractJsonArray` 后新增 `normalizeDecisions`，把 thinking 模型输出的别名键 / wrapper 对象重写到规范字段——`target_ids` / `targetIds` / `memory_ids` → `ids`、`keep_source` → `keepSource`、`winner_id` → `winner`、`loser_id` → `loser`、`new_title` / `merged_title` → `title`、`consolidation` 作 action 键或 action 值 → `merge` 等；顶层 `{consolidation:[...]}` 等 wrapper 对象自动解包；`ids` 单值字符串包成数组；create 决策的 `type` 字段绝不被误当 action。字段名不听话但语义正确的输出不再整单被拒（实测方案 A 输出 `consolidation`/`target_ids`、方案 B 输出 `targetIds` 均非规范名）。

### 测试

- 603 → **613** 全绿（新增 `test/normalize-decisions.test.js` 归一化 9 例、reasoning-effort `off` 用例）。

## [0.5.2] - 2026-08-20

### 新增

- **记忆溯源 `session_id`**：每条记忆记录出生会话 id——`memory_save` 工具从 `exec.agent.session.id` 取（无会话上下文置 null 不伪造），`autoSummarize` 从 turn/end 钩子的 `session.id` 取；merge 保留原记忆的出生会话（溯源只记出生点，`store.update` 不触碰该字段）。旧库打开自动补列（`addColumn` 幂等迁移，存量数据 session_id 为 null，无迁移成本）。为 v0.6.0 推理路径可视化与兴趣漂移分析攒原材料。

### 测试

- 597 → **603**（新增 `test/provenance.test.js` 6 例：写入/缺省置空/merge 保留原会话/工具路径带与不带 agent/旧库迁移）

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
