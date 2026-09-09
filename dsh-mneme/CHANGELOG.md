# Changelog

## [0.7.29] - 2026-09-10

## 🐛 修复

- **实体抽取静默失败（#108/#109）**：实体抽取的 LLM 路由契约缺陷——`provider`/`model` 未显式配置时兜底读取默认路由选择有误，且 reasoning effort 被模型拒绝后无重试路径，导致抽取静默失败或结果为空。修复：`streamEntityText` 抽取为可测试导出的 `createEntityStreamAdapter` 工厂（显式 `provider`/`model` 优先，缺省兜底读 `agentDefaultModel.currentSelection`）；配置的 `reasoningEffort` 被模型拒绝时自动去掉重试一次（与 autoDream/sleep 同一降级策略）；新增实体抽取思考强度配置（`entityExtractionReasoning`）。

## ✨ 新增

- **面板实体抽取控件**：设置页新增实体抽取 `provider`/`model`/思考强度三个控件，与巩固/睡眠一致的级联下拉 + 连通性测试。
- **「帮助与反馈」卡片**：设置页底部新增反馈入口——GitHub issue 预填（自动附插件版本 + 平台）+ 邮件 `work@modusensus.space` + 浏览已知问题去重；配套新增 `GET /api/dsh-mneme/info`（返回插件版本，供反馈环境信息）。

## 🏗️ 工程

- 744 测试全绿（新增 effort 拒绝重试 / 显式路由优先 / info 版本一致性 / 反馈卡片源码断言 用例）。

## [0.7.28] - 2026-09-09

## 🐛 修复

- **连通性测试 `reply` 恒空（思考模型）**：`POST /api/dsh-mneme/test-model` 的最小调用 `maxTokens` 仅 16，思考模型（如 deepseek-v4-flash / glm-5.3-flash）的推理过程即可将其耗尽，正文一个字都吐不出来——`reply` 恒为空，「真的答了 ok 而非只报通」对思考模型不成立。提到 1024（按实际用量计费，手动按钮无放大成本）。
- **连通性测试按钮串扰**：测试结果状态为巩固/睡眠两组共享单份，点任一「测试连通性」按钮两组同时进入「测试中…」、互相禁用、结果行双份显示。拆为巩固/睡眠各持一份，互不影响。
- **睡眠路由显示「被重置」**：面板挂载时初始化草稿的键名单漏 `sleepProvider`/`sleepModel`——后端一直保存正常，但重挂载（切页签/退出重进）后下拉恒显「跟随默认路由」，看起来像设置丢失。补键后正常回填（历史已保存的值无需重填）。

## [0.7.27] - 2026-09-09

## 🐛 修复

- **v0.7.26 端点遗漏补齐（发版树缺端点分支）**：v0.7.26 的 CHANGELOG/Release 已宣告 `llm-providers` / `test-model` 两个设置面板端点，但承载它们的 `fix/dream-effort-trap` 分支未合入 main——发版树里面板「级联下拉 + 测试连通性」调用会 404。本版将该分支 rebase 到 main 后合入（PR #100），端点实际落地；与 main 已合内容重复的提交（docs 及 effort 陷阱修复等价补丁）rebase 时自动丢弃。

## [0.7.26] - 2026-09-09

## 🐛 修复

- **记忆巩固 `UNSUPPORTED_REASONING_EFFORT` 根治（defaultEffort 陷阱）**：harness 在调用方省略 effort 参数时注入 `reasoning.defaultEffort`（模型声明的最低档），若该默认档位本身不被模型支持（如火山 coding 适配器声明 `defaultEffort="low"` 而模型只收某固定档位），则任何重试策略都无效——换 effort 或去掉 effort 都会被同一个理由拒绝。修复：新增 `resolveDreamEffort`，在发流**前**经 `ctx.llm.resolveModelInfo()` 探测路由模型支持的 effort 档位，再发送受支持的档位——
  - 配置档位（`dreamReasoningEffort` / `sleepReasoningEffort`）被支持 → 原样发送；
  - 配置档位不被支持 → 自动换用模型声明的 `defaultEffort`（若也支持）或首个支持档位，并 `logger.warn` 留痕；
  - 模型声明无 reasoning 能力 → 省略 effort 字段（发送普通补全请求）；
  - `resolveModelInfo` 查询失败 → 按配置原样发送（fail-open，不因探测失败卡死巩固）。
  - 影响面：autoDream（`dream.js`）与 sleep（`dream/sleep.js`）两条路径共用该 helper。
- **设置面板巩固/睡眠模型字段选型提示**：`dreamProvider`/`dreamModel`/`dreamReasoningEffort`/`sleepProvider`/`sleepModel`/`sleepReasoningEffort` 6 字段补 `.description()`——引导选非思考模型（思考模型可能烧光 token 预算返回空体导致巩固失败），并说明 effort 不支持时会自动换档。

## ✨ 新增

- **巩固/睡眠模型连通性测试（Web 设置面板配套后端）**：
  - `GET /api/dsh-mneme/llm-providers`：宿主侧 LLM provider/model 发现（`ctx.llm.listProviders()`/`listModels()`，逐 provider best-effort），返回 `{ providers: [{ provider, models: [{ id, name }] }] }`，无 `ctx.llm` 时 501；**密钥仅存宿主侧，不经插件侧、不入本端点**。
  - `POST /api/dsh-mneme/test-model`：`{ provider?, model?, reasoningEffort? }` 连通性探测——最小流式调用（maxTokens 16）实测模型真实可通。**空 body = 按巩固路由解析**（`dreamProvider/dreamModel > agent 默认模型`，解析不出返回 400 `no-route`）；部分输入（有 provider 缺 model）400 `missing-provider-or-model`；成功 200 `{ ok:true, durationMs, modelId }`（+`reply` 预览），失败 502 `{ ok:false, error, durationMs, modelId }`；requireAuth 鉴权。

## 🏗️ 工程

- **测试清理**：`client.test.js` 移除 identity `.replace()`（CodeQL `js/identity-replacement` 告警 #1，测试死代码）。
- 732 测试全绿。

## [0.7.25] - 2026-09-09

## 🆕 新增

- **`memory_get` 工具（第 8 个模型工具）**：按 id 读取单条记忆完整正文，用于 memory_search / memory_list 命中后读取全文。
- **`memory_search` / `memory_list` 输出内容预览**：render 现在嵌入命中条目标题、ID/type/importance 元数据与正文预览（不再只输出「命中 N 条」计数）——宿主只透传 render 文本时，模型也能直接读到记忆内容。
- **记忆巩固模型选型引导**：config 注释与 README 增加巩固模型分类声明（非思考模型 / 思考模型差异与建议），设置面板换巩固模型有据可依。

## 🐛 修复

- **`memory_get` 执行崩溃：`userExecute is not a function`**：memory_get 的 execute 被误嵌套进 output 属性内（defineTool 拿不到 options.execute），模型调用必报错；此前测试只数工具名未执行该工具，714 全绿掩盖。已移回 defineTool 顶层 + 补回归测试。
- **工具重复注册（DSH live patch reload）**：热补丁重载同一 registry 时 `tool "memory_search" is already registered`——新增按 registry 的 WeakMap 工具名去重，重复跳过并告警。
- **Standalone API 端口冲突（EADDRINUSE）**：多 DSH profile / 实例共用默认端口时 API 永久不可用——新增 listenWithRetry（最多 20 次递增 + 最终落 OS 分配端口 0），实际绑定端口回传调用方。
- **client inject 声明与实际消费不一致**：声明 `["slots","locale","layout","connection"]`，实际只消费 slots/locale——对齐为 `["slots","locale"]`。
- **better-sidebar 集成加固**：peer 依赖 `*` → `^0.18.0`（仍可选）；registerTab 前 getTab 查重跳过重复 tab；注册失败告警并降级回原生侧边栏入口，不再直接报错。

## 🏗️ 工程

- 718 测试全绿（+4 回归测试：memory_get 执行 / 缺失 id、memory_search / memory_list render 内容嵌入）。

## [0.7.24] - 2026-09-09

## 🐛 修复

- **DSH Desktop 插件树加载崩溃（v0.7.23 回归）：`cannot get property "webServer" without inject`**：v0.7.23 把 webServer 从 inject 声明中去掉想支持 headless，但 cordis 4 的 ctx 是 Proxy——**直接访问未在 inject 声明的属性会抛错而非返回 undefined**，`if (ctx.webServer)` 守卫因此失效；且去掉 inject 后 cordis 不再等待宿主 webServer 服务就绪，Windows 桌面端重启即插件树加载失败。修复两处：
  - **恢复 webServer 到 inject 声明**：cordis 等宿主服务激活后再 apply，路由注册不落时序（回退到 v0.7.22 已知正确行为）。
  - **apply/register 守卫改 `ctx.reflect.get`**（cordis 免 inject 读取，未提供返回 undefined 不抛错）：即使未来把 webServer 移出 inject 支持 headless，apply 也安全跳过 API 注册而不崩。
  - **真实 cordis + dsh-host-webserver 插件本地实测**：API 路由真实注册（GET /api/dsh-mneme/list → 200 JSON）、未知路径 404 JSON、headless 无 webServer 时静默不激活。
- **回归测试（真实 cordis Context 两种宿主形态）**：有 webServer 时插件 boot 且注册 exact 路由 / 无 webServer 时不抛错——直接覆盖本次崩溃根因，防止再犯。

## 🏗️ 工程

- 714 测试全绿（+2 回归测试）。

## [0.7.23] - 2026-09-09

## 🐛 修复

- **记忆沉淀「反复失败」根治：consolidation 合法空数组 `[]` 不再误判失败**：CONSOLIDATION_PROMPT 明确允许「无问题的条目无需输出」，模型在记忆库无冗余时输出合法 JSON `[]`（**不是**空体/截断）——`validateDecisions` 却硬判 `decision list must be a non-empty array` → runDream 整单 failed、审计表反复记失败，**记忆越健康越容易「失败」**。与 sleep 空模式（skipped no-op）语义不一致，且**与模型无关**（任何遵守 prompt 的模型都会踩中，ChatGPT/Claude 同样）。修复：对空数组显式短路 `{ok:true, applied:0}` no-op（不可简单放行——隐式 keep 的覆盖率检查 0%<50% 会拦截）。Linux 本地真实 LLM（火山 coding OpenAI 端点）实测验证：无冗余场景 `ok:true applied:0 summary:true`，审计记 ok。
- **空体修复第二段：`dreamMaxTokens` 默认 8192→32768**：思考型模型（v4 系）默认推理全开，8192 预算被 reasoning 烧光正文为空 → 默认预算翻四倍给推理留余量；上限 131072 不变，非思考模型实际用量远低无成本影响；设置面板可调。
- **skipInvalid 恢复代码 splice 残留 bug（v0.6.9 原版就带，issue #89 回归路径）**：`decisions.splice` 守卫用长度相等代理「内容一致」——当「被跳非法决策数 == 隐式补齐 keep 数」时长度回等但内容已变，被跳决策残留进 apply/audit（重复 claim 的 merge 会被照样应用）→ 改无条件 splice。由本次新增的 skipInvalid 全量测试揪出。

## 🏗️ 工程

- **skipInvalid 恢复路径全量测试补全**（12 条：逐原因跳过 + 全局闸门交互 + runDream e2e）。
- **合法空数组 e2e**：consolidation 返回 `[]` → run ok / applied 0 / summary 照跑 / audit+receipt 记 ok。
- ~~**webServer 可选化**：inject 声明去掉必填 webServer（headless/无 UI 宿主兼容），API 注册改运行时守卫。~~ ⚠️ **失败已回退**：cordis 4 直接访问未注入属性抛错（`if (ctx.webServer)` 守卫失效）+ 去掉 inject 后 cordis 不再等待宿主 webServer 服务 → **桌面端插件树加载崩溃**，见 [0.7.24] 修复。
- **712 测试全绿**。

## [0.7.22] - 2026-09-09

## 🐛 修复

- **恢复 v0.6.9 的 skipInvalid 宽容校验路径（issue #89 回归，v0.7.11 重写丢失）**：v0.6.9（issue #26）实现的 `dreamSkipInvalid`（单条非法决策跳过 + 合法子集应用 + run 记 degraded）与 `allowCrossTypeMerge` 开关在 v0.7.11 近重写时丢失，README Fail-safe 一节承诺的宽容行为自此与代码错讹；qwen3.8-flash 等弱模型决策合规抖动下 4/4 全败，整单拒绝白烧 LLM 调用。恢复三件：
  - **`decisions.js` 原样移植 skipInvalid 双轨结构**：单条错误进 local，skipInvalid 时记入 skipped 并从 decisions 原地剔除、不 claim 任何 id；严格模式（不传开关）行为不变，sleep 路径维持严格。
  - **`allowCrossTypeMerge` 显式放宽跨类型合并**；全局上限/覆盖率下限仍整单拒绝（刷爆上限=模型坏了，不是轻微 schema 漂移）。
  - **`dream.js` 透传 config 开关**：skipped 非空时 run 状态如实记为 degraded（ok:true 保持基线刷新语义），跳过明细进 warn 日志。
- **autoDream 最小触发间隔（issue #89 请求 2）**：新增 `dreamMinIntervalMinutes`（0-10080，默认 0=不限）；`minIntervalMs` 节流——失败/degraded run 也占用间隔（节流目的正是防失败调用连发），间隔内触发静默跳过。

## 🏗️ 工程

- 三个新 feature flags（`dreamSkipInvalid` 默认 true / `allowCrossTypeMerge` 默认 false / `dreamMinIntervalMinutes` 默认 0）入白名单，**34 键**。
- 696 测试全绿（+8：v0.6.9 五用例移植 + degraded/严格 e2e + 节流 + 白名单计数）。

## [0.7.21] - 2026-09-08

## 🐛 修复

- **autoDream/sleep 的 effort 回退在流式路径上是死代码（v0.7.16 补的 catch 式回退不生效）**：dsh-llm rc.1 的 `adapterStream` 把 adapter 阶段异常（含 `resolveCallWithInfo` 抛出的 `UNSUPPORTED_REASONING_EFFORT`）转成终态 error finish chunk，不再向上抛出；`streamText` 丢弃 `chunk.reason.failure`，导致配置 `dreamReasoningEffort`/`sleepReasoningEffort` 后巩固/睡眠请求被 provider 即时拒绝（tok=0、duration≈0）时，catch 式回退永远不触发，`llm_audit` 只记笼统的 `llm stream aborted or errored`。修复三处：
  - **`streamText`（dream.js 与 sleep.js 两份）捕获 finish-chunk 失败原因**：新增 `describeStreamFailure` 把 `chunk.reason.failure` 归一化为 `{code, message}` 并导出。
  - **`withEffortFallback` 增加 `getStreamError` 访问器**：结果为 `undefined` 且原因匹配 `reasoning effort` / `UNSUPPORTED_REASONING_EFFORT` 时去掉 effort 重试一次（流式路径与 catch 路径同等对待）。
  - **`runAuditedLlm` 支持 `spec.streamError`**：audit 行 `error_message` 携带真实原因（如 `llm stream aborted or errored (UNSUPPORTED_REASONING_EFFORT: ...)`）；`run.error` 保持稳定的 `"llm failed"` 不变（对外契约不动）。

## 🏗️ 工程

- 688 测试全绿（+3：dream/sleep 流级 effort 拒绝触发去 effort 重试；非 effort 流失败不盲目重试且真实原因进审计行）。

## [0.7.20] - 2026-09-08

## 🆕 新功能

- **heat 热度模型回归（issue #87 社区反馈）**：v0.7.11 近重写时与 Wiki-Link/tag 等一并被移除的 v0.7.0「自进化记忆 heat 热度模型」完整找回：
  - `src/heat.js` 纯函数模块恢复：幂律衰减 `H=1/(1+λΔt)^α` + per-type 差异化半衰期（`TYPE_DECAY`，preference/pattern/summary 免疫 λ=0）
  - 配置恢复：`heatEnabled` / `heatGlobalAlpha` / `heatTypeDecay` / `sleepHeatThreshold` / `recallRecordDefault` / `recallRetentionDays`
  - **sleep 降级热联合双保护**：phaseDemotion 需「时间窗冷 + heat<阈值 + importance<5」才降级，免疫类型永不因 sleep 降级；ref 语义恢复 `last_accessed_at ?? created_at`（updated_at 不算访问）
  - **touchRecalled 门控**由 `heatEnabled` 接管；**实体热投影**回归（ego 图谱节点 heat 字段 + 前端 nodeRadius/fillOpacity 随热度缩放）
  - **recall_runs 默认记录**恢复（`recallRecordDefault: true`）
- **阶段二前端（验收清单完成）**：/list 在 `heatEnabled=true` 时逐条下发 heat 投影（`heat.js` 纯函数，λ=0 免疫类型恒 1.0；字段缺省前端自动隐藏）；HeatBadge 三档徽章（Lucide flame + 整数百分比：热≥66% 橙 / 温 33-66% / 冷<33% 弱化藏百分比，卡片页脚与详情抽屉共用）；状态页热度分布卡（采样最近 200 条三档统计，自门控）；**order=heat 页内排序**——热度是运行时投影无存储序、SQL 排不了且分页切片后页内非全局序，走前端页内排：卡片网格对已加载条目按 heat 降序、时间树保持 chrono 不受影响；「热度优先」chip 自门控，时间线视图开启时自动切卡片视图

## ⚠️ 行为变更（验收清单落地）

- **heatEnabled 默认关**（`false`）：v0.7.12 起用户已习惯无 heat 行为，默认开=全员行为变更。默认关时 sleep 降级退回纯时间分层（v0.7.12 行为），touch 零写入。
- **feature_flags 白名单接线**：`heatEnabled` 加入 `FEATURE_FLAG_BOOLEANS`（现成 30 键机制的 31 键）——面板可启停 = 线上回滚开关，首次线上事故无需回滚版本。
- **lightMode 联动关停**：`heatEnabled` 加入 `LIGHT_MODE_OFF`，轻量模式不开热计算。
- **sleep 降级审计暴露**：`/api/dsh-mneme/dream-status` 返回 `run_type` + `demotion {demoted, archived}` 计数（数据来自 runSleep 已写入 dream_runs 的 `decisions.demotion`）——状态页工作动态可展示「降级 N 条 / 归档 M 条」，自动改记忆留痕。
- **updated_at ⊥ last_accessed_at 契约**：heat/sleep ref 永不 fallback 到 `updated_at`（只用 `last_accessed_at ?? created_at`）；heat 是运行时投影不写盘；heat 加权不进入 `order=chrono`（记忆库分页/月份树/无限滚动稳定序不受影响）。

## 🐛 修复

- **better-sidebar 软集成无 bs 环境启动失败（issue #88，用户打不开文件）**：根因是模块级/manifest 的 `inject: ['betterSidebar']` 声明被 loader 硬等待——未安装 `dsh-better-sidebar` 的环境整个 entry pending（`'1 entry did not activate'` → Failed to load plugins）。改为 dsh-server-deck 同款双模式：外层入口零 inject 立即激活（独立模式保底），tab 注册挪进 `ctx.plugin({ inject: ['betterSidebar'] })` 内层动态子插件由 cordis 原生等待——bs 未装时内层 fiber 永远 INACTIVE，静默无害；模块与 manifest（`package.json dsh.client.inject`）同步移除。

## 🏗️ 工程

- 685 测试全绿（heat 后端 +15、阶段二前端 +2：/list heat 投影契约 + client HeatBadge/分布卡结构断言；better-sidebar 修复改结构断言锁定内层子插件模式）

## 📝 历史补记与勘误（issue #87 全仓审计）

- **删除版本勘误**：v0.7.11（发布提交 `ce4658e`）近重写时移除了一批 v0.6.x/v0.7.0 实验功能（Wiki-Link、tag 系统/目录/tag 加权、user/fact 分层类型、前缀 id 解析、/stats 与 /directory 端点、heat、内置面板 client.js 内联面板）——此前本 CHANGELOG 与 README 中英 archival note 把删除归因于 v0.7.12，已统一勘误。v0.7.11 与 v0.7.12 同日发布，v0.7.12 相对其父提交未删除任何文件。
- **静默丢失补记**（此前全文档零记载，本次如实补录，**不找回**）：
  1. **provenance 出生会话溯源（`session_id`）**：v0.6.1 引入，v0.7.11 连测试一并删除；`source` 字段与 `epistemic_status` 来源分级仍保留
  2. **会话生命周期（`session_disposed_at` 软隐藏）**：v0.6.0 引入，v0.7.11 从存活的 store/service 静默剥离；README 死文档与死配置键（`sessionLifecycleEnabled`/`showSidebarTrigger`）已清理；留待 issue #47 无痕会话重做
  3. **normalizeDecisions 决策字段归一化**：v0.5.3 引入，v0.7.11 删除，功能由「提示词硬规范字段名 + extractJsonArray 解包」取代

## [0.7.18] - 2026-09-08

## 🆕 新功能

- **better-sidebar 软集成（生态第一步）**：声明 `betterSidebar` inject + optional peer `dsh-better-sidebar`，运行时软探测注册「记忆库」tab（id `dsh-mneme:memory`，复用记忆库/实体/状态/设置四视图，10×1s 重试兜服务时序）；未安装时安全跳过，独立入口（侧边栏 sheet）完整保留。`.mneme-x` 加 container-type:inline-size，`@container ≤640px` 隐藏卡片/时间线 seg 防窄容器重叠。双模式真机实测：无 bs 环境回退完好，有 bs 环境经「+」菜单进入四视图正常。
- **记忆库沉淀/归档筛选**：新增 `GET /list?deposited=only`——沉淀视图 = receipt_chain 的 merge/update live verdict（record_id 即保留/更新目标）∪ source="dream" 直写，total 同过滤，conflict 不算沉淀；筛选栏「来源」分组新增「沉淀」「已归档」chip，可与类型/重要性/时间筛选叠加（deposited ∩ archived 组合有效）。

## ✨ 优化

- **状态页仪表盘化**：沉淀/归档长列表收敛为「小页预览 + 服务端 total + 查看全部」，点击跳转记忆库并预置对应筛选——查询收敛到有搜索与分页的浏览视图，状态页保持轻量。
- **详情抽屉「恢复」**：归档记忆在抽屉内一键回主列表，与「归档」操作对称。

## 🧪 测试

- deposited 视图组合过滤（∪ source=dream、∩ archived=only、默认列表不受影响）+ client 结构断言（chip/跳转/恢复/服务端 total）；667 测试全绿。

## [0.7.17] - 2026-09-08

## ✨ 优化

- **侧边栏入口持续对齐宿主**：入口按钮的类名此前在挂载时刻快照一次，宿主/皮肤异步改写「新会话」按钮类名后会停留在旧类上（宽度/对齐失配）。改为 MutationObserver 监听类名变化持续同步，并加 `width:100%` 与宿主行同宽；去掉自作的 label 左对齐覆盖（`flex:1; text-align:left`），交还原生居中。
- **重要性星级改为星形图标**：内联 Lucide v1.42 star 路径数据（morphicons 官方配套的数据包；插件运行时禁止 require 第三方库，沿用既有内联惯例），新增 `ImportanceStars` 实心/空心星形组件，替换详情抽屉与卡片页脚的文本 ★（编辑态 `<option>` 保留文本形式，SVG 无法渲染进 option）。
- **导出/导入菜单不再被吸顶月份头遮挡**：`.mneme-xtools` 的 `transform` 会自建层叠上下文，菜单自身的 `z-index` 出不去、被时间线吸顶月份头（z-index:2）盖住。z-index 提升到容器（3：高于吸顶头、低于详情抽屉 6），下拉菜单与导入对话框随容器整体上浮。

## 🧪 测试

- 新增 client 结构断言：宿主类名持续同步（MutationObserver + attributeFilter）、入口宽度与对齐、工具栏容器 z-index、星形组件与文本 ★ 的保留范围；合并远端补测（API 路由空白 + lib 运行时冒烟）；664 测试全绿。

## [0.7.16] - 2026-09-08

## 🐛 修复

- **autoDream 在 thinking 模型上输出预算被推理吞掉、整单 failed**：consolidation 走主模型（volcano deepseek-v4-flash，v4 系默认开推理）且 `dreamReasoningEffort` 默认 `none`（不带 reasoning 控制）时，推理会耗尽 `dreamMaxTokens` 预算、正文返回空体，5 次连续 failed（`no json array in llm output`）。三处配套修复：
  - **路由优先级恢复 config-first（Issue #25）**：v0.7.11 曾把 `resolveRoute`/`resolveSleepRoute` 改回 agent 默认模型优先，导致 `dreamProvider`/`dreamModel`（设置面板「巩固模型」）在标准 DSH 安装下恒为死代码——设置页把 dream 指到非思考型模型根本不会生效。恢复「显式 config 优先、agent 默认回退」，README §config 契约与代码重新一致。
  - **reasoningEffort 被拒时回退重试一次**：配置的 effort 被 provider 拒收（volcano 实测连 `off` 都报 `UNSUPPORTED_REASONING_EFFORT`）原本整单失败；现自动去掉该字段重试一次，effort 配置（low/medium/high）可安全实测——接受就封顶推理、拒绝则退化 provider 默认并打日志。
  - **解析失败如实记账 + 原始输出日志**：`runAuditedLlm` 新增 `auditError` 检查器，「流式成功但输出不可解析」不再假记 `success`（此前 llm_audit 全是 success 却 run failed），`no json array` 时带原始输出前 300 字节日志便于定位。

## 🏗️ 工程

- 662 测试全绿（+17：config-first 路由、解析失败 audit 记 error、effort 被拒回退重试，另补 API 路由空白 /delete·/entities·/external-api 与 lib 运行时冒烟）。

## [0.7.15] - 2026-09-08

## 🆕 新功能

- **记忆库面板重设计（桌面端适配）**：面板从「挤在对话里的 tab」升级为独立交互页面——撤 `conversation.view` tab，改为居中非全屏 sheet（上限 1240×920，背板 Esc / 点击关闭）；侧边栏入口上移到工作区上方，运行时借用宿主「新会话」按钮原生类名对齐盒模型（wrapper `display:contents`），展开态与收起态（rail）都和原生图标零位移对齐；`sidebar.footer.action` 注册保留为锚点与失效回退。
- **卡片视图 / 时间线双视图**：卡片网格（类型色点 / 标题 / 摘要 / 星级 / 来源 / 相对时间）与月度时间树一键切换，偏好本地记住；无限滚动两视图通用。
- **详情抽屉与手动操作**：右侧滑出抽屉展示全文、来源、质量分、标签与**关联实体**（`GET /memories/entities?memoryId=`）；支持直接**编辑**（`POST /update`，content_history 语义不变、镜像自动重渲染）、**归档**、复制全文与两步删除；操作提示升级为 sheet 级 toast。
- **功能开关（0.7.13/0.7.14 后端能力首次上 UI）**：`GET/PUT /api/dsh-mneme/features` 30 键白名单（布尔 / 整数 / 字符串 / URL / 枚举，含 `memoryQualityFilter.enabled`、`llmAudit.enabled` 两个嵌套键与 `ollamaBaseUrl` 协议白名单），设置页分组展示（核心 / 记忆增强 / 巩固与睡眠 / 高级折叠）；**巩固模型**与 **embedding 提供方**（openai/local/ollama）可配；启动按「用户开关 > 轻量预设 > bundle 配置」合并。429 调速器参数、`distillMaxChars` 等调优项留在配置文件不上 UI。
- **状态页工作台**：新增「最近巩固」「待确认冲突」卡（`GET /dream-status`）；**工作动态流**展示 autoDream/autoSummarize 每次后台调用的状态、token 与沉淀条数；**沉淀的记忆**按 audit 关联 id 解析标题；**已归档的记忆**一键恢复。
- **导入 / 导出**：`GET /export?format=json|markdown`（Markdown 与磁盘镜像字节同构，可被导入直接吃回）+ `POST /import`（`parseHumanEdits` 重构为纯函数后复用）；面板「更多操作」菜单直达。
- **时间范围筛选**：`/list` 支持 `updatedFrom`/`updatedTo` 闭区间（date-only 归一化到整天）与 `archived=only` 归档视图，list/count 同过滤保证分页 total 一致。

## 🔒 安全

- **外部 API Token 面板默认遮蔽**：只显示首尾少量字符（显示/隐藏切换），完整值仅经「复制」通道离开面板，不再明文铺在页面上。

## 🐛 修复

- 新记忆类型 `rejected_solution` / `pitfall` / `constraint` 标签与配色补齐（此前浏览 / 筛选 / 详情里显示原始英文 key）。
- 模型工具严格输出 schema 不受面板字段扩展影响：`archived` / `quality_score` 只在 HTTP 层补充 wire DTO，`toApiList` 保持精简。

## 🧪 测试

- 645 全绿（+28：feature flags 全类型校验与嵌套键、update 往返与 404/400、entities 映射、export→import 黄金闭环、dream-status、archived=only 与默认列表互斥、面板结构断言重写）。

## [0.7.14] - 2026-09-08

## 🐛 修复

- **蒸馏不再采集私有推理块（安全，CWE-200）**：`collectMessages` 原会把 `assistant/message` 里的 `reasoning` block 作为「助手思考」送进蒸馏上下文，生成的记忆可能沉淀模型私有思考链；现只采集公开 `text` 块，私有推理不进记忆库。CodeRabbit 评审（PR #76）指出后修复。

## 🏗️ 工程

- 617 测试全绿（+1：私有 reasoning 块不进入蒸馏上下文，公开文本照常蒸馏）。

## [0.7.13] - 2026-09-08

## 🆕 新功能

- **编码记忆蒸馏（`codingRetrospect`，默认关）**：turn/end 蒸馏改用**完整转录**（用户输入 + 助手思考/回复 + 工具调用/结果 + 代码执行）提炼原子记忆，蒸馏模型能看到工具报错与调试全过程，不再只盯着用户打了什么字。新增三种编码专属记忆类型，专治重复踩坑 / 遗忘被否决方案 / 丢失工程约束：
  - `rejected_solution`（被否决/废弃的实现方案：方案简述 + 被否决原因 + 最终采用方案）
  - `pitfall`（调试踩坑记录：现象/报错 + 根因 + 解决/规避方法）
  - `constraint`（项目工程约束：约束描述 + 来源）
  - 读取侧按需加权：`isCodingTask` 判定编码任务（`codingKeywords` 关键词命中），命中时编码类记忆注入排序权重 ×`codingBoostFactor`（默认 2，封顶 5）；普通闲聊检索不到编码记忆，不污染通用召回。`tools.js` 的 `memory_save/search/list/update` 类型枚举同步扩到 7 种。
- **智能调速器（429 保护）**：对话一多时 turn/end 会批量触发蒸馏，多个 LLM 请求「一拥而上」正是 429 的来源。所有蒸馏调用进**全局串行队列**（`distillRateLimitIntervalMs` 默认 1000ms 分批放行，单次蒸馏零延迟），命中 429 按 `distillRateLimitBaseDelayMs`（默认 1000ms）**指数退避**（1s→2s→4s…）自动重试 `distillRateLimitRetries`（默认 3）次，全程对用户透明，不把 429 错误码抛出去。
- **语义保留（原子记忆）**：蒸馏 prompt 改为「每条记忆只装一个独立事实/偏好/决策，短小、自带完整上下文（数字/名字/路径/结论保留原文），宁可拆成多条也绝不合并丢细节」；完整转录上限由 `distillMaxChars`（默认 24000，可调大）控制。

## 🐛 修复

- **v0.7.12 CI 回归**：v0.7.11（ce4658e）移除 c8 与 `test:coverage` 脚本但 `test.yml` 仍调用 → 两版测试工作流 `Missing script: "test:coverage"` 直接红；恢复 `c8@^12.0.0` devDependency + `test:coverage` 脚本，覆盖率流水线复原。

## 🏗️ 工程

- 616 测试全绿（+4）：蒸馏全局串行队列、429 指数退避重试（`distillRateLimitRetries:3` 实测 3 次退避）、完整转录原子记忆 prompt、`codingRetrospect` 落库 `rejected_solution`（tags 空数组，读取侧靠 `m.type` 门控）。

## [0.7.12] - 2026-09-08

## 🆕 新功能

- **独立外部 API（生态集成）**：插件可启动自己的 HTTP 服务（默认 `127.0.0.1:8790`，仅回环绑定），其他插件/CLI/桌面工具经 Bearer token 读写记忆，不再依赖 DSH 内部端口。路由：`GET /health`（免鉴权）、`GET /status`、`GET/POST/DELETE /memories`、`GET /memories/:id`、`GET /search`；token 首次启用自动生成并持久化（设置面板可查看复制）。配置：`externalApiEnabled/externalApiPort/externalApiHost` + 面板设置持久化（重启生效）；非回环绑定的安全责任由操作者承担。
- **CLI 工具 `dsh-mneme`**：零依赖命令行（`bin/cli.mjs`）——`status` / `list` / `search` / `get` / `add` / `delete` / `config set|show|path`，配置优先级 参数 > 环境变量（DSH_MNEME_URL/TOKEN）> `~/.dsh-mneme/cli.json`；`--json` 机器输出。
- **轻量模式（lightMode）**：面向非技术用户的简化预设——只保留核心的记忆读写与自动注入（autoInject/autoSummarize/hot memory/质量过滤），关闭 autoDream 巩固、实体抽取、语义搜索、rerank、bm25、选择性注入等重资源项；`applyLightModePreset` 纯函数 + `panel_mode` 持久化（持久化优先于 bundle 配置），设置面板一键切换（重启生效）。
- **设置面板新卡片**：「运行模式」（轻量/标准）与「外部访问 API」（开关/地址端口/Token 复制），中英文案齐备。

## 🏗️ 工程

- 612 测试全绿（+17）：独立 API 10 例（401/health/CRUD 闭环/搜索/400 校验）、mode 路由 3 例、external_api kv 2 例、light 预设与 config 用例；`store.count` 支持 minImportance/source 后 total 与行一致。

## [0.7.11] - 2026-09-08

## 🆕 新功能

- **记忆库面板改版（可扩展性 + 实时性）**：
  - **按月分页 + 无限滚动**：记忆浏览从一次性 `limit=500`（超限即静默丢失）改为 100 条/页的时间序分页（`list?order=chrono`，`store.list` 新增 `order` 参数、`/api/dsh-mneme/list` 透传），滚动到底自动拉下一页（IntersectionObserver 哨兵 + 「加载更多」按钮兜底），底栏常显 `已加载/总数`。
  - **月份默认折叠**：仅最新一个月展开，历史月份收起为一行标题（带条目计数），月份表头吸顶；几千条记忆也只渲染少量 DOM。
  - **搜索全局化**：关键词/语义搜索都改走服务端（`mode=keyword|vector`），命中全库而不仅已加载页；`type` 过滤在搜索结果上继续生效。
  - **数据实时性**：记忆子视图激活时即刷新第一页，打开期间每 30s 静默刷新（页面不可见时暂停），新记忆无需手动刷新即可出现；图跳转的记忆若在未加载页，以单条结果呈现并选中。
  - **图标与视觉**：内联 Lucide 风格 stroke 图标（路径数据打包进 bundle，运行时零依赖；与 morphicons 消费的 lucide 数据同源），替换文字箭头/子 tab 图标/搜索/刷新/复制等；月份表头、加载更多、空态样式梳理。
- **bundle 默认开启实体抽取**：`cordis.patch.yml` 增加 `entityExtractionEnabled: true`（此前默认 false，图谱实体只在显式配置过的环境增长）。新记忆落库即自动抽取实体/关系，图谱随对话自动生长。
- **记忆库「状态」子页**：记忆总数（含分类型小计）、实体计数（含分类型小计）、向量索引开关状态、近 7 天 LLM 调用/消耗四张卡片，分区独立加载互不阻塞。
- **记忆删除（两步确认）**：详情面板新增红色「删除」按钮——首次点击变为实心红「确认删除？」+「取消」，确认后走新增的 `POST /api/dsh-mneme/delete`（`{id}`，复用 requireAuth 围栏；400 缺 id / 404 不存在），本地列表与计数同步移除。
- **重要性过滤**：分类栏新增 全部/★3+/★4+/★5 服务端过滤芯片（`list?minImportance=`），`store.count` 同步接受过滤参数使分页 total 与行一致；浏览分页、加载更多、自动刷新共用同一过滤态。
- **双语 README**：新增 `README.en.md`（与中文版逐节对齐），两版互挂语言切换链接。

## 🐛 修复

- **Issue #72：窗口最大化后图谱节点不可见**：力导向模拟此前以 SVG 元素的 CSS 宽度（`clientWidth`）为布局边界——最大化窗口下元素宽达上千 CSS px，重心（`clientWidth/2`）与钳制区间都落到 380×300 viewBox 之外，节点整体被裁剪出画布（窗口较小时两个空间近似重合，所以一切正常）。现在模拟全程在 viewBox 用户单位（`VIEW_W`/`VIEW_H`）中运行，与绘制空间严格一致；浏览器把 viewBox 等比缩放到元素实际尺寸，小窗、隐藏 tab、最大化均可见、可拖拽，布局不再依赖挂载时的容器测量。
- **Issue #59：DSH ≥0.1.2-rc 上 autoSummarize 从不执行**：DSH 0.1.2-rc 起移除了 `Session.events` 属性，事件只能经 `snapshotEvents()` 获取——`collectMessages()` 拿到的恒为空数组导致 `summarize()` 直接退出，`llm_audit_logs` 全空、从未发起 LLM 调用。`summarize.js` 与 `inject.js`（`lastUserQuery` / `extractRounds`）三处统一改为 `session.snapshotEvents?.() ?? session.events ?? []` 兼容垫片：新 DSH 走 snapshot 方法，老版本回退 `.events`，两边都不破坏。

## 🏗️ 工程

- 595 测试全绿：新增 snapshotEvents 回归 2 例——summarize（仅暴露 `snapshotEvents()`、无 `.events` 的会话必须触发 LLM 调用并入库 2 条记忆）与 inject（无 `.events` 会话下「短期上下文」热记忆块照常渲染）。

## [0.7.10] - 2026-09-07

## 🆕 新功能

- **记忆类型色点体系**：新增 `MEMORY_TYPE_COLORS` 调色板（preference 琥珀 / project 绿 / decision 蓝 / summary 紫 / user 琥珀 / fact 绿 / history 灰，与图谱实体色同一风格的中饱和固定色相，明暗主题均可读）与 `.mneme-xdot` 色点组件，贯穿三处——类型筛选行（「全部」为空心环保持对齐）、时间树每一行、详情 meta。同一颜色在任何位置都代表同一记忆类型，扫视时间树即可分辨构成。分类计数改为 `margin-left:auto` 右对齐，色点不挤计数。
- **图谱画布平移 + 滚轮缩放 + 重置视图**：此前画布仅有节点拖拽，`cursor: grab` 暗示的画布拖动从未实现。新增 `viewRef`（translate+scale）视口状态与 `<g transform>` 包裹层——空白处按住拖动平移整图；滚轮缩放以光标为锚点（0.5x–3x，native 非 passive wheel 监听，React 合成 `onWheel` 为 passive 无法 `preventDefault`）；节点 `mousedown` 增加 `stopPropagation` 防止误触发平移；节点拖拽灵敏度按缩放系数换算，放大后拖节点不再"飘"；图谱工具栏新增「重置视图」一键复原；画布高度提升至 320px；操作提示更新为「拖拽节点调整布局 · 空白处拖动平移 · 滚轮缩放」。
- **设置页分区重排（借鉴 Claude App 设置排版）**：设置内容改为 `.mneme-set-sec` 分区呈现——用户画像 → 规则 → 自定义指令 → 自动打标签 → 侧边栏入口 → 向量搜索 → API Token（高级项移至最后），每区标题 + 一句话说明 + 细分隔线；规则行重做：编号圆点 + 圆角行 + 悬停浮现删除按钮，输入框回车直接添加；命令行 `/名称` 主题蓝高亮；全部输入控件统一 `.mneme-set-input`（聚焦品牌蓝描边）与 `.mneme-btn`。中英文提示全部重写为口语化文案（如规则区"给 Agent 立下必须遵守的规矩，随时增删，下一轮即生效"）。0.7.3 引入的自动打标签与侧边栏入口开关功能原样保留，仅归入新排版。
- **详情 meta 精排**：来源 `session:<uuid>` 截断为 200px 省略（完整值悬停可见），创建时间只显日期、更新时间改相对时间（超一周回退日期，完整时间戳保留在 tooltip），meta 恢复单行。
- **新增只读端点 `GET /api/dsh-mneme/entities`**：实体清单（名称/类型/提及次数/首末见时间，`limit` 上限 1000），为实体目录 UI 与后续视图供数；exact 路由 19 → 20 条。

## 🐛 修复

- **侧边栏入口同标签冲突**：会话 tab 在 DOM 上不带注册 id，旧激活逻辑取"文档中第一个文字匹配的 `[role=tab]`"——安装其他插件后，同名标签或隐藏的设置分页会被误激活（表现为点击「记忆」无反应或跳错视图）。现改为 `findExplorerTabs` 多候选：先以 `offsetParent` 过滤不可见面板，点击后验证 `.mneme-x` 确实渲染才算成功，失败自动尝试下一个候选，全部失败仍回退全屏覆盖层。`test/client.test.js` 新增两条契约断言（渲染验证 + 隐藏面板过滤）。

## 🏗️ 工程

- `scripts/e2e-dsh.js` 的路由数断言从失真的 9 条修正为与 `src/api.js` 返回值一致的 20 条；client 测试同步适配新激活契约。
- 全套 **815 测试通过**（含 client 激活契约 2 个新断言）。

## [0.7.9] - 2026-09-06

### 🐛 修复：v0.7.8 的 rc.1 snapshotEvents 适配未同步到 lib/（issue #65）

- **现象**：v0.7.8 为兼容 DSH 0.1.2-rc.1（`Session.events` → `snapshotEvents()`）只改了 `src/inject.js` 与 `src/summarize.js`，发布产物 `lib/` 从未同步——npm 包实际加载的是 `lib/`（`main` 指向 `lib/index.js`），用户在 rc.1 下安装 0.7.8 运行的仍是未适配代码。因代码带 `?.` / `?? []` 容错，**不报错但热记忆注入与会话摘要静默失效**。
- **修复**：将 src 的兼容垫片同步到 `lib/`（两文件 3 处），`src/` 与 `lib/` 逐文件一致。
- **防再犯（双保险）**：
  - 新增 `scripts/check-sync.js`：断言 `src/` 与 `lib/` 一致性，root `prepack` 钩子调用——发布前不一致直接 fail；
  - 新增 `test/lib-smoke.test.js`：从 `lib/` 直接导入复跑 snapshotEvents 关键用例 + 静态断言 src→lib 逐文件一致，CI 每次全量测试拦截。
- 新增 3 个用例（lib 版 snapshotEvents 注入/摘要 + 一致性断言），全套 **815 通过**。

## [0.7.8] - 2026-09-06

### 🐛 修复：DSH 0.1.2-rc.1 兼容（issues #58 #59）

- **现象**：DSH 0.1.2-rc.1 起官方移除 `Session.events` 属性、改为 `snapshotEvents()` 方法。autoSummarize（会话摘要）与 hot-context（短期上下文）注入都依赖 `session.events` 读取会话事件，升级后取到 undefined 而**静默失效**——会话摘要不再落库、短期上下文块不再渲染。
- **修复**：`src/summarize.js` 与 `src/inject.js` 两处取事件统一改为兼容垫片 `session.snapshotEvents?.() ?? session.events`——0.1.2-rc.1 及以后走新方法，更早 0.1.x 仍走 `.events`，**新旧 DSH 通吃**。
- **说明**：兼容垫片，老版本 DSH（0.1.x 早期）行为完全不受影响，无需任何配置改动。
- 新增 2 个回归用例（会话只提供 `snapshotEvents()` 时 hot-context 渲染与会话摘要均恢复），全套 **812 通过**。

## [0.7.7] - 2026-09-05

### 🆕 issue #23：sleep 批量实体抽取回填实体图谱

- **背景**：写路径抽取（index.js）只有 `entityExtractionEnabled` 开启才触发——每次写入一次 LLM 调用，是刻意的成本取舍——所以默认安装下记忆从不累积实体，这正是 issue #23 报的"实体图谱面板一片空白"（用户明明有很多记忆）。
- **新增 sleep 批量抽取 phase**：默认关 `sleepEntityExtractionEnabled`，开睡循环时按**最老优先**把没有实体属性的记忆逐条过 `extractEntities`（每轮上限 `sleepEntityExtractionMaxPerRun` 默认 20）。
- **下沉为有界 SQL 查询**：新增 `store.listForEntityExtraction({limit, offset})`，`WHERE` 只留行级条件（未归档/未遗忘/非 summary/内容非空/`metadata.entity_extracted_at` 为空），`ORDER BY created_at LIMIT ? OFFSET ?` 分页取最老候选；实体是否已存在是跨表检查（`getAttrsByMemory`），由 JS 在每页上过滤。不再 `service.all()` 全表加载。
- **幂等防重**：抽取前先 stamp `metadata.pending_extracted_at`，成功后替换为 `entity_extracted_at`，失败清除 pending——一条记忆不会被并发/崩溃重复抽取，失败的下轮重试。
- **metadata 合并不覆盖**：`store.setMemoryMetadata` 改为 merge 语义，打实体时间戳不会抹掉其他路径刚写入的 metadata 字段。
- **失败不阻断**：单条抽取失败只跳过该条、记入 `failed` 计数，整轮状态由 `deriveStatus` 正确折叠 `failed`——一次 LLM 抖动不会 abort 整个 sleep 周期。
- **node:sqlite 兼容修复**：初版实现用 better-sqlite3 的 `.pluck()`（node:sqlite 不存在），改为 `.all().map(row => getById(row.id))`；`listForEntityExtraction` 的 `forgotten IS NULL` 条件与 `save` 硬编码写入的 `forgotten=0` 永不匹配导致查询恒空，修正为 `(forgotten = 0 OR forgotten IS NULL)`（与 archived 同构）。
- 新增 9 个用例（禁用/跳过、stamp 不重复、无实体也 stamp、backfill、失败重试、metadata merge、pending 清除、failed 状态折叠、分页最老优先），全套 **810 通过**。

## [0.7.6] - 2026-09-02

### 🐛 issue #48：截断的短 id 也能精确操作

- **现象**：`memory_update` / `memory_delete` / `memory_forget` / `memory_archive` 此前对 id 做**严格精确匹配**（`WHERE id = ?`，无任何前缀/模糊逻辑）。若宿主上下文压缩或手抄把 36 位 UUID 截断，`memory_delete` 会静默返回 `{deleted:false}`（无 warn、无日志），其余三个工具抛错——对用户都表现为"操作不进也不出"。
- **新增 `service.resolveMemoryId`**：精确命中优先，否则把传入值当 id 前缀解析（主键前缀走索引，无性能问题）；命中多条 → 拒绝操作并列出候选完整 id，**绝不瞎猜**。
- **四工具统一接入**：`memory_update` / `memory_forget` / `memory_archive` 未命中抛错并提示"请传完整 id（`memory_list` / `memory_search` 输出均为完整 id）"；`memory_delete` 保持幂等返回 `{deleted:false}`，未命中补 `logger.warn` 留痕，可被服务日志定位。
- 完整 id 直连不受影响（精确命中优先，不会因"恰好是另一条的前缀"被误判歧义）。
- 复验加固：纯通配符 id（`%`/`_`）剥空后按无匹配处理，杜绝退化成 `LIKE '%'` 全表误删单条记忆；id 首尾空白自动 trim。
- 补 11 个用例（前缀删除/更新/归档/遗忘、歧义拒绝、未命中兜底、精确优先、通配符兜底、空白 trim、warnMiss 日志），全套 **801 通过**。

### 🧹 工程：client.js 改为 src 正源

- Web 面板 bundle `client.js` 历史上是 lib/ 下**手写、无 src 副本**的唯一例外（重蹈过 v0.6.7 源码漏提交）；现补 `src/client.js` 为唯一正源，`npm run sync` 统一同步出 `lib/client.js`，guard 测试改为断言两文件字节一致，杜绝 drift。

## [0.7.5] - 2026-09-02

### 🆕 新功能：分层记忆类型 user/fact

- 借鉴 meow-memory 的七层分层概念，贴合 dsh-mneme 单表 `memories` + `type` 字段架构，只补最轻量的两个分层，不动表结构：
  - **`user`** — 用户画像（身份/背景/偏好档案）
  - **`fact`** — 原子事实（不随时间漂移的客观事实）
- 全链路打通：`store.TYPES` / `tools` 工具枚举与描述 / `summarize` VALID 集合与提炼 prompt / `quality-filter` 标签 / `mirror` 镜像文件（`user.md` / `facts.md`）/ `service.INJECT_TYPES` 注入（user 与 preference 同级常注入，fact 按重要性阈值注入）
- Web 面板「总览」视图：记忆分层卡片（六类型+summary/pattern）+ 用户画像卡 + 类型分布面板 + 近 7 天创建趋势

### 🆕 新功能：stats 统计端点

- `GET /api/dsh-mneme/stats?days=N`：按类型分布 + 近 N 天（默认 7，夹紧 1..30）逐日创建趋势，SQL 聚合不受 list 50 条限制，排除归档/遗忘/会话销毁

### 🔧 复验修复（kimi-k2.7-code）

- `days` 参数整数化：`?days=7.5` 不再产生 8 个趋势点（`parseInt` 夹紧 + store 层防御）
- store 单次 `Date.now()` 读取，避免趋势窗口跨天边界不一致
- 前端趋势图 0 值天渲染 0 高度柱（不再伪装成有数据）；INJECT_TYPES 注入注释说明"常注入 vs 按重要性阈值"

### 测试

- 新增 8 个测试（分层类型/镜像/提炼/list 过滤/stats 分布+趋势/归档遗忘排除/days 夹紧与整数化），全套 **790 通过**

## [0.7.4] - 2026-09-01

### 🐛 修复（issue #40）

- **记忆内容含 `{{...}}` 模板语法时整轮崩溃**：DSH 核心 `interpolate()` 会把 `{{name}}` 当 prompt 变量严格校验（变量名须匹配 `/^[a-z][a-z0-9_]*$/`），记忆/画像/规则里合法的模板语法（灰机 wiki 的 `{{hl|}}`、`{{黑幕}}`、学习占位符 `{{挖空}}`、`{{关键词}}`）因非法变量名直接 throw，整轮对话失败。修复：注入边界 **run-based 花括号转义**（连续 2+ 个花括号之间插 `\`：`{{a}}`→`{\{a\}\}`），**奇数连续括号（如 `{{{a}}}`）也不残留字面 `{{`**，`interpolate()` 不再扫描到；覆盖 memory 块 / 短期上下文 / 用户设置三处注入出口。新增配置 `escapePromptVariables`（默认开，关闭时原样透传）

### 🐛 修复（issue #41）

- **记忆窗口关闭按钮重叠无法关闭**：`MemoryOverlay` 全屏覆盖层顶栏右侧的关闭按钮与宿主窗口标题栏控制按钮（最小化/最大化/关闭）落在同一区域，宿主控制按钮浮在 web 内容最上层抢走点击热区。修复：顶栏改左对齐（标题 + 关闭按钮并排），关闭按钮离开右上角宿主控制按钮区，任何窗口尺寸下都可见可点

### 测试

- 新增 6 个回归测试（inject 5 + config 1，含 `{{{a}}}` 奇数括号回归），全套 **782 通过**

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
