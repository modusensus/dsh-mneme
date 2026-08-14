# dsh-mneme：给 DeepSeek Harness 写一个会「做梦」的记忆插件

> 一个跨会话记忆插件从 0 到发布 6 个版本的全过程：架构、踩坑、测试与发布流水线。

- 日期：2026-08-14
- 版本线：v0.1.0 → v0.1.6
- 仓库：github.com/modusensus/dsh-mneme
- 技术栈：Cordis 4 · Node 24+ · `node:sqlite` · DeepSeek Harness（DSH）

---

## 缘起：Agent 的「失忆症」

用 AI 编程助手的日常是美好的，除了一个老问题——**它不记得你**。你告诉过它你的代码风格、项目的架构决策、某次调试的结论，换个会话全忘了。每次都要重新交代一遍，像希腊神话里的记忆女神 Mnemosyne 被迫失忆。

DeepSeek Harness（DSH）是一个 Cordis 插件化的 Agent 框架，天然支持扩展。于是我动了念头：**给它装一个「跨会话记忆」**，让 Agent 记住你、记住项目、自动整理记忆。这就是 `dsh-mneme`。

名字来自希腊语 *Mneme*（Μνήμη）——记忆女神 Mnemosyne 之名，掌管记忆与**梦境**。后者是点睛之笔：这个插件不只存储记忆，还会像 Claude 的 Dream 机制一样，在后台自动巩固记忆。

---

## 第一版：地基与踩坑

### 架构：SQLite + Markdown 镜像

核心设计理念是**「机器存储，人可编辑」**：

- **SQLite 主存储**（`~/.dsh/memory/memory.db`），用 Node 24+ 内置的 `node:sqlite`，**零原生依赖**——这在依赖地狱的 JS 生态里是巨大的省心。
- **Markdown 镜像**：`preferences.md` / `projects.md` / `decisions.md` / `history.md` / `summary.md` 五个人类可读的文件，**人工修改优先**合并回库。Agent 写库 → 镜像同步；你手改镜像 → 下次启动合并回库。

4+1 种记忆类型：`preference`（偏好）、`project`（项目）、`decision`（决策）、`history`（历史）、`summary`（总览）。

对外暴露 6 个模型工具：`memory_save` / `memory_search` / `memory_list` / `memory_update` / `memory_delete` / `memory_forget`。

### 踩坑 1：ModuleLoader 注册 id 必须等于包名

第一个坑在 Web 客户端。插件在 DSH 前端注册 UI 时，报了一个诡异错误：

```
Failed to load plugins ... loaded without registering '@modusensus/dsh-mneme' via __ModuleLoader__.load
```

原因是 `lib/client.js` 里 `__ModuleLoader__.load({ id: ... })` 的 id 写成了 `dsh-mneme`，而模块加载器要求**必须等于 package.json 里的完整包名** `@modusensus/dsh-mneme`。一行修复，却花了不少时间排查——因为错误信息只在特定启动路径才出现。后来我给 `test/client.test.js` 加了回归断言：注册 id 必须与包名一致。

### 踩坑 2：FTS5 名不副实

最初 README 和描述里写着「SQLite + FTS5 全文搜索」，但代码审查发现**根本没有 FTS 表**，实际是 `LIKE '%keyword%'` 全表扫描。

这其实是**有意的选择**：中文没有天然分词，FTS5 默认 tokenizer 对 CJK 子串匹配无能为力，而记忆库通常很小，全表扫描性能完全够用。真正的 FTS5 得配 `trigram` tokenizer 才能处理 CJK，属于「未来优化」。审查的结论是：不急着实现，先把**误导性的文档改对**。诚实面对实现比硬撑门面重要。

### 踩坑 3：人工编辑丢失的竞态

这是审查发现的最严重 bug。启动时按类型循环「读取人工编辑 → 合并回库」，但**合并成功会重写全部镜像文件**，于是：

```
读 preferences.md → 合并 → 重写全部 5 个镜像文件
读 projects.md（已被上一步覆盖！）→ 合并... 你的编辑已经丢了
```

修复方案很朴素：**先全量读取所有类型的编辑到 Map，再一次合并**。一个顺序问题，差点让用户的手工笔记灰飞烟灭。

### 踩坑 4：卸载时访问已关闭的数据库

插件卸载时，dream（后台整理）可能还在跑，而 store 已经被 close 了，于是异步竞态。修复：让 `dream.dispose()` 变 async，跟踪 `inFlight` promise，**等当前一轮跑完再关库**。Cordis 卸载时会 `await runDisposable`，所以 async disposer 是被支持的——但前提是 apply 必须写成**箭头函数**而不是 `function`，因为 Cordis 4 会把带 prototype 的函数当成类构造器 `new apply(...)` 并丢弃返回值，导致 disposer 永远不执行。这个坑值得单独记一笔。

---

## 升级：autoDream——让记忆「越用越精炼」

只存不整理，记忆库会变成垃圾场。于是加了 autoDream：

- **触发**：记忆数 > 10 条或总字符 > 5000 时，异步自动触发（不阻塞写入）。
- **决策清单式整理**：让 LLM 输出 `keep` / `merge` / `archive` / `conflict` 决策清单，服务端校验后逐条应用：
  - `merge`：合并主题相近条目
  - `archive`：归档过时/冗余（可恢复，不物理删除）
  - `conflict`：裁决矛盾信息，胜者保留、败者归档并追加溯源注释
- **摘要生成**：整理后产出「记忆库总览」，下次会话优先注入。
- **Fail-safe**：LLM 输出非法（未知 id / 非法 action / 跨类型合并 / 越界 importance）就**拒绝整单**，绝不破坏记忆库。

---

## 设置面板：画像、规则与自定义命令

第一版只有模型工具，用户没法直接告诉 Agent「我是谁」。于是加了**用户画像 + 行为规则**：一段自由文本描述自己，加上 Agent 必须遵守的规则列表，**每轮注入**系统提示，通过独立的 `[用户设置]` 注入区块（优先级高于记忆库）。

再进一步，支持**自定义斜杠命令**：用户注册 `/名称`，触发时把预设指令交给 Agent。命令持久化到 SQLite，启动自动注册、增删实时生效。命令名有严格校验（`^[a-z][a-z0-9_-]*$`），因为要映射到 DSH 的命令注册表。

UI 方面踩了一个「过度设计」的坑：最初在侧边栏加了一组「记忆 / 设置」按钮，后来发现 DSH 官方设置面板本身就支持 `settings.section` 插槽——**深度集成进官方设置**远比自定义侧边栏按钮优雅，于是把侧边栏入口整个移除，只保留官方设置面板里的「记忆库设置」区块。

### 踩坑 5：readBody 必须 return

写 HTTP 路由时踩了个隐蔽的坑：PUT/POST 的 handler 里 `readBody(req).then(...)` 如果不 `return`，测试里 `await handler()` 会**提前返回**，body 还是空的。因为 handler 返回的是 undefined 而不是 promise。所有异步 handler 都必须返回 promise，否则外部 `await` 形同虚设。

### 踩坑 6：EADDRINUSE 与「改了但没生效」

调试时最迷惑的一类问题：**改了代码重启，但路由还是旧的**。查了半天，发现 `dsh web` 启动时报 `EADDRINUSE: 127.0.0.1:3080`——**旧进程还活着**，新进程根本没起来，3080 端口上跑的还是老代码。解决：先 `Stop-Process` 占用 3080 的旧 PID，再重启。

还有个关联坑：DSH 用 pnpm 安装 `file:` 依赖时，**源码改了但 node_modules 副本不自动更新**，必须删掉副本再 `pnpm install --force`。于是形成固定流水线：改代码 → `npm run sync`（src→lib）→ 同步到 DSH 源码目录 → 删副本重装 → 重启。

---

## 向量搜索：语义召回 + rerank 陷阱

用户提出「搜索记忆的时候建议添加向量搜索」。调研后发现 DSH 的 LLM 服务只提供聊天接口，**没有 embedding**，需要外部接入 OpenAI 兼容的 embeddings API。

实现方案：

- `memories` 表加 `embedding` 列（ALTER TABLE 迁移），存 JSON 向量。
- 写入记忆时 fire-and-forget 自动嵌入；`/vector-reindex` 一键为存量记忆补建。
- 搜索时：`/search?mode=vector` 对 query 嵌入 → 余弦相似度检索（记忆量小，暴力扫描即可）→ 与关键词结果合并去重；**API 失败自动回退关键词**，绝不阻塞。
- 记忆面板加「语义」切换按钮，工具 `memory_search` 同步支持 `semantic: true`。

### 踩坑 7：rerank ≠ embedding

用户一开始给的模型是 `qwen3-vl-rerank`——实测 `/embeddings` 直接报 `model_not_supported`。因为它是 **rerank 模型**，走的是独立的 `/rerank` 端点（且兼容模式根本没这个端点，得走阿里云原生 DashScope 地址，body 结构也不同：`input: { query, documents }`）。

结论：**「向量模型」≠「embedding 模型」**。最终改用 `text-embedding-v3`（1024 维），在用户自己的阿里云专属端点实测可用，语义检索效果惊艳：一个与任何记忆字面都不匹配的查询，关键词 0 命中，向量检索 8 条全部召回且最相关的排第一。

### 隐私红线

向量搜索要填 API Key。隐私处理是三重的：Key 只存本机 `memory.db` 的 `user_settings` 表（**不写入代码、不进 git、不进 npm 包**）；`embedding.js` 日志只打维度不打 Key；`.gitignore` 增加 `.env*` / `*.secret` / `*credential*` / `*.pem` / `*.key` / `*.db` 等一整套隐私模式，从源头防误提交。提交前用 `git grep` 全仓库扫了一遍 Key 片段，确认零残留。

---

## 测试与质量：140 个测试的底气

- **单元测试**：`node:test`，从最初的 106 个一路涨到 **140 个**，覆盖存储、镜像、服务、工具、注入、dream、摘要、API、设置、命令、向量检索。
- **Schema 校验测试**：对 DSH 工具的输出 schema 做编译后校验，防止 `additionalProperties` 与运行时数据不一致。
- **E2E 演示**：`scripts/e2e-dsh.js` 用真实 Cordis 装载插件，模拟完整会话流（工具注册 → 保存 → 注入 → 摘要 → autoDream → API），LLM 用 mock 流。
- **代码审查**：每个阶段跑一遍专业审查，发现的 bug（人工编辑竞态、dream 卸载竞态、误导性文档）都转成了回归测试。

---

## 现场演示：一分钟跑通完整会话流

空口无凭，直接放一段**真实运行**的输出。仓库自带端到端演示脚本 `dsh-mneme/scripts/e2e-dsh.js`：用 Cordis 搭一个最小 DSH 环境，真实装载插件，LLM 用 mock 流（离线可跑、零 Key），一口气走完「装载 → 保存 → 注入 → 摘要 → autoDream → API → 画像/命令」的完整流程：

```bash
cd dsh-mneme && npm run e2e
```

```text
══════ dsh-mneme 端到端演示 ══════
记忆目录：…\Temp\dsh-mneme-e2e-a1PDg2

【1】插件装载
  ✅ 注册 6 个模型工具
  ✅ 注册 2 个注入上下文
  ✅ 注册 8 条 API 路由
  工具：memory_save, memory_search, memory_list, memory_update, memory_delete, memory_forget

【2】memory_save 保存记忆
  memory created: c0f95dfb-… / 1942a0de-… / ad759616-… / 3d66127a-… / b148e805-…
  memory merged: c0f95dfb-…
  同标题二次保存 → 触发 merge ✓

【3】memory_search / memory_list
  搜索 "SQLite" → 2 条
  preference 共 3 条

【4】自动注入（新会话上下文）
  [记忆库] 来自 dsh-mneme 的跨会话记忆（用户偏好与高优先级项目/决策）：
  - [preference] 语言（重要性 5）：用户用中文交流，偶尔英文
  - [preference] 工作时段（重要性 4）：9-18 点在线，上午深度工作
  - [preference] 工作习惯（重要性 3）：习惯上午处理复杂任务
  - [decision] 存储选型（重要性 5）：确定使用 node:sqlite
  - [project] 记忆插件（重要性 4）：dsh-mneme 用 SQLite + Markdown 镜像

【5】会话摘要（模拟 turn/end）
  摘要入库：2 条命中（source: session）

【6】autoDream（阈值触发 → LLM 决策 → merge + 摘要）
  注入中出现"记忆库总览"：是 ✅
  dream merge 后 preference 条目：1（dream 时 4 条相近项，merge 成 1 条）

【7】Web 面板 API（/api/dsh-mneme/list）
  HTTP 200，project 条目 1 条

【8】用户画像 / 规则 / 自定义命令
  注入含用户画像：✅
  注入含规则：✅
  自定义命令 /review 已注册：✅
  命令触发返回：请按项目规范审查当前代码…

══════ 汇总 ══════
  LLM 调用：summarization → compaction → compaction
  记忆文件：…\Temp\dsh-mneme-e2e-a1PDg2
  当前可注入条目：4
══════ 演示结束 ══════
```

值得盯住的几个点：

- **【2】同标题二次保存 → merge**：同一主题再次保存自动合并，不堆积重复记忆。
- **【4】注入排序**：新会话注入按重要性排序，偏好与高优先级决策排最前。
- **【6】autoDream**：到达阈值后触发 LLM 决策，把 4 条相近偏好 merge 成 1 条，并产出「记忆库总览」供下轮优先注入。
- **【7】【8】**：Web 面板 API 和画像/规则/自定义命令全部真实走通。

想自己跑一遍？装好依赖后直接 `npm run e2e`，约 10 秒看到整段输出——LLM 是 mock 的，离线可跑、不需要任何 API Key。

---

## 发布流水线：小步快跑

版本迭代很快，从 0.1.2 到 0.1.6 一天内发了 5 个版本。流水线是：

```
改代码 → npm test（140 个）→ npm run sync（src→lib，prepack 自动）
→ 同步 DSH 部署副本 → 删副本重装 → 重启验证 → 升版本 → git commit
→ git push → npm publish
```

一个细节：`npm version patch` 在 Windows + 中文环境有编码坑，我统一用 `Set-Content -Encoding UTF8` 写 commit message 文件再 `git commit -F`，避免 commit message 变成乱码。

---

## 踩坑清单速查

| 坑 | 一句话解法 |
|----|-----------|
| ModuleLoader 注册 id 报错 | `__ModuleLoader__.load({ id })` 必须等于包名 `@modusensus/dsh-mneme` |
| FTS5 名不副实 | CJK 子串匹配用 LIKE，FTS5 需 trigram tokenizer，别吹牛 |
| 人工编辑丢失 | 先全量读所有类型编辑到 Map，再一次合并，别循环边读边写 |
| dream 卸载竞态 | dispose 变 async 并 await in-flight promise；apply 用箭头函数 |
| readBody 提前返回 | 异步 handler 必须 `return readBody(req).then(...)` |
| 改了代码不生效 | 旧 DSH 进程占着 3080，`Stop-Process` 旧 PID 再重启 |
| pnpm file: 副本不更新 | 删 node_modules 副本 + `pnpm install --force` |
| rerank ≠ embedding | 认清模型类型；rerank 走 /rerank，embedding 走 /embeddings |
| 中文 commit 乱码 | `git commit -F` + UTF-8 文件 |

---

## 尾声

从「探索一个现成插件」到「自己加功能、发 6 个版本」，最大的收获不是写了多少代码，而是：

1. **架构的克制**：零原生依赖、人工可编辑的镜像、fail-safe 的决策应用——每个选择都在降低运维和信任成本。
2. **踩坑的价值**：Cordis 的加载语义、Node 内置 SQLite 的边界、Windows 下的进程与编码——这些经验是文档里查不到的。
3. **测试的底气**：140 个测试 + 审查驱动的回归用例，让「改了不慌」成为可能。

现在，这个会「做梦」的记忆插件，已经能在 DSH 的设置面板里管理画像与规则、注册自定义命令、做语义检索，并在后台默默巩固每一段对话的记忆。

> *Mnemosyne 说：你忘记了，没关系，我记得。*

---

*附：本文由 dsh-mneme 插件开发过程整理。所有 Key 均已脱敏，未泄露任何凭据。*
