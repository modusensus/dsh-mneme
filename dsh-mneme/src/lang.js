// 记忆语言（memory.language，src/config.js）：生成记忆、注入标题与后台 LLM
// 提示词所用语言，'zh'（默认，上游行为不变）/ 'en'。本模块无全局状态：每个
// 插件实例从自己的 config 取语言（langOf），逐层传给 inject / summarize /
// dream / sleep / mirror，多实例（如 agent preset 内挂载）互不影响。
// 各语言对经 STR.<key>[language] 索引取值。

/** 解析实例语言：config.language === "en" 用英文，其余（含缺席）一律中文。 */
export function langOf(config) {
  return config?.language === "en" ? "en" : "zh";
}

const PROMPTS = {
  "summary": {
    "zh": "你是记忆库提炼助手。根据下面的会话内容，提炼值得跨会话记住的原子记忆。\n原子记忆原则：每条记忆只装一个独立事实/偏好/决策，短小、自带完整上下文（把数字、名字、路径、结论等原始细节保留在 content 里，不要抽象概括）；宁可拆成多条也绝不合并丢细节。信息量一般提 2-4 条，信息密集的对话可提 4-8 条。\n只输出 JSON 数组，每项形如 {\"type\":\"preference|project|decision|history\",\"title\":\"简短标题\",\"content\":\"保留原始细节的一句话\",\"importance\":1-5}。\n不要输出任何其他文字。",
    "en": "You are the memory curation assistant. From the conversation content below, distill atomic memories worth remembering across sessions.\nAtomic-memory principle: each memory holds exactly one standalone fact/preference/decision — short and self-contained (keep raw details like numbers, names, paths, and conclusions verbatim in content; do not abstract or summarize them away). Prefer splitting into multiple entries over merging and losing detail. Extract 2-4 entries normally, 4-8 for information-dense conversations.\nWrite every title and content in English.\nOutput only a JSON array, each item shaped {\"type\":\"preference|project|decision|history\",\"title\":\"short title\",\"content\":\"one sentence preserving original detail\",\"importance\":1-5}.\nOutput no other text."
  },
  "codingSummary": {
    "zh": "你是记忆库提炼助手。根据下面的会话内容（含用户输入、助手回答、工具调用与结果），提炼值得跨会话记住的原子记忆。\n原子记忆原则：每条记忆只装一个独立事实/偏好/决策，短小、自带完整上下文（把数字、报错信息、命令、路径、结论等原始细节保留在 content 里，不要抽象概括）；宁可拆成多条也绝不合并丢细节。信息量一般提 2-4 条，信息密集的对话可提 4-8 条。\n只输出 JSON 数组，每项形如 {\"type\":\"preference|project|decision|history|rejected_solution|pitfall|constraint\",\"title\":\"简短标题\",\"content\":\"保留原始细节的一句话\",\"importance\":1-5}。\n若对话涉及编码/调试，可额外提取编码类记忆：\n- rejected_solution：被否决/废弃的实现方案（content 含方案简述 + 被否决原因 + 最终采用方案）\n- pitfall：调试踩坑记录（content 含现象/报错 + 根因 + 解决/规避方法）\n- constraint：项目工程约束（content 含约束描述 + 来源）\n普通闲聊、临时无关对话一律不提取编码类记忆。不要输出任何其他文字。",
    "en": "You are the memory curation assistant. From the conversation content below (including user input, assistant replies, tool calls and results), distill atomic memories worth remembering across sessions.\nAtomic-memory principle: each memory holds exactly one standalone fact/preference/decision — short and self-contained (keep raw details like numbers, error messages, commands, paths, and conclusions verbatim in content; do not abstract them away). Prefer splitting into multiple entries over merging and losing detail. Extract 2-4 entries normally, 4-8 for information-dense conversations.\nWrite every title and content in English.\nOutput only a JSON array, each item shaped {\"type\":\"preference|project|decision|history|rejected_solution|pitfall|constraint\",\"title\":\"short title\",\"content\":\"one sentence preserving original detail\",\"importance\":1-5}.\nIf the conversation involves coding/debugging, additionally extract coding-specific memories:\n- rejected_solution: implementation approaches that were rejected or abandoned (content: brief approach + why rejected + what was adopted instead)\n- pitfall: debugging pitfalls (content: symptom/error + root cause + fix or workaround)\n- constraint: project engineering constraints (content: constraint description + source)\nNever extract coding-specific memories from casual small talk or temporary unrelated conversations. Output no other text."
  },
  "dreamSummary": {
    "zh": "你是记忆库摘要助手。根据整理后的记忆，生成一段 150-200 字的记忆库总览，覆盖：用户偏好、活跃项目、关键决策。之后作为会话上下文注入。只输出摘要文本，不要其他内容。",
    "en": "You are the memory overview assistant. From the consolidated memories below, produce a 150-200 word memory-library overview covering: user preferences, active projects, key decisions. This will be injected as conversation context. Output only the summary text, nothing else."
  },
  "consolidation": {
    "zh": "你是记忆库整理助手。下面是全部记忆条目（id、类型、标题、内容、重要性、更新时间）。\n请执行记忆巩固（consolidation），输出一个决策 JSON 数组。\n\n【决策格式（必须严格遵守）】\n每个决策必须是对象，字段固定：\n- \"action\"：必填。取值只能是 \"keep\" / \"merge\" / \"archive\" / \"update\" / \"conflict\" 之一（字段名必须是 action，严禁写成 type）\n- \"ids\"：必填，数组，本决策涉及的记忆 id 列表\n- \"reason\"：可选，字符串，决策理由\n- \"importance\"：可选，整数 1-5\n- merge 额外字段：\"keepSource\"（单个 id 字符串，必须是 ids 之一）+ 合并后的 \"title\"、\"content\"\n- conflict 额外字段：\"winner\" 与 \"loser\"，都是【单个 id 字符串，不是数组】\n- update 额外字段：修正后的 \"title\" 和/或 \"content\"；\"ids\" 只能包含一个 id\n\n【决策 JSON 示例】\n[\n  { \"action\": \"merge\", \"ids\": [\"m1\", \"m2\"], \"keepSource\": \"m1\", \"title\": \"合并标题\", \"content\": \"合并后的摘要内容\", \"importance\": 4, \"reason\": \"主题相近\" },\n  { \"action\": \"conflict\", \"winner\": \"m3\", \"loser\": \"m4\", \"reason\": \"内容矛盾，保留更新的信息\" },\n  { \"action\": \"update\", \"ids\": [\"m5\"], \"content\": \"修正后的内容\", \"reason\": \"信息过时\" },\n  { \"action\": \"archive\", \"ids\": [\"m6\"], \"reason\": \"重复或过时\" }\n]\n\n【任务】\n1. 识别主题相近的条目 → merge（合并为更精炼的摘要，保留信息最完整的 id 作为 keepSource）\n2. 识别重复/过时信息 → archive\n3. 识别内容矛盾的条目 → conflict（按时间新旧、来源完整性、信息具体程度判断 winner/loser）\n4. 发现单条记忆中的信息过时、错误或遗漏 → update（直接修正内容）\n   - update 的 ids 只能包含一个 id\n   - 必须提供修正后的 title 和/或 content\n   - 仅当内容确实需要修正时才使用，不要滥用\n   - 每次整理最多输出 2 个 update\n   - 24 小时内新建的记忆不可 update\n5. 无问题的条目无需输出（未提及的条目将自动保留 keep）\n\n【硬性规则】\n- 字段名必须精确为 \"action\"，严禁写成 \"type\"；字段名统一用双引号\n- conflict 的 winner/loser、merge 的 keepSource 都是【单个 id 字符串，绝不是数组】\n- 每条记忆最多被 claim 一次：同一个 id 不能出现在多个决策中（同一 id 不能被 merge 和 conflict/archive 等重复占用）\n- 未在决策中提及的记忆将自动保留（keep），无需为每条记忆输出 keep\n- merge 的 keepSource 必须是 ids 之一\n- 仅合并同类型条目（type 相同）\n- 不要编造 ids；只使用提供的 id\n- 重要性 1-5，合并后取最高\n- 只输出 JSON 数组，不要其他文字",
    "en": "You are the memory consolidation assistant. Below are all memory entries (id, type, title, content, importance, updated time).\nPerform memory consolidation and output a JSON array of decisions.\n\n[Decision format (must be followed strictly)]\nEach decision must be an object with fixed fields:\n- \"action\": required. Value must be one of \"keep\" / \"merge\" / \"archive\" / \"update\" / \"conflict\" (the field name must be action, never type)\n- \"ids\": required, array, the list of memory ids involved in this decision\n- \"reason\": optional, string, rationale for the decision\n- \"importance\": optional, integer 1-5\n- merge extra fields: \"keepSource\" (a single id string, must be one of ids) plus the merged \"title\" and \"content\"\n- conflict extra fields: \"winner\" and \"loser\", each a [single id string, never an array]\n- update extra fields: the corrected \"title\" and/or \"content\"; \"ids\" may contain only one id\n\n[Decision JSON examples]\n[\n  { \"action\": \"merge\", \"ids\": [\"m1\", \"m2\"], \"keepSource\": \"m1\", \"title\": \"Merged title\", \"content\": \"Merged summary content\", \"importance\": 4, \"reason\": \"similar topics\" },\n  { \"action\": \"conflict\", \"winner\": \"m3\", \"loser\": \"m4\", \"reason\": \"content contradicts; keep the newer information\" },\n  { \"action\": \"update\", \"ids\": [\"m5\"], \"content\": \"corrected content\", \"reason\": \"information outdated\" },\n  { \"action\": \"archive\", \"ids\": [\"m6\"], \"reason\": \"duplicate or outdated\" }\n]\n\n[Task]\n1. Identify entries with similar topics -> merge (merge into a more refined summary; keep the id with the most complete information as keepSource)\n2. Identify duplicate/outdated information -> archive\n3. Identify entries with contradictory content -> conflict (judge winner/loser by recency, source completeness, and information specificity)\n4. Find outdated, wrong, or missing information in a single memory -> update (correct the content directly)\n   - update's ids may contain only one id\n   - must provide the corrected title and/or content\n   - use only when the content truly needs correction; do not abuse\n   - output at most 2 updates per consolidation run\n   - memories created within the last 24 hours must not be updated\n5. Entries without issues need no output (unmentioned entries are automatically kept)\n\n[Hard rules]\n- Field names must be exactly \"action\", never \"type\"; use double quotes for all field names\n- conflict winner/loser and merge keepSource are [single id strings, never arrays]\n- Each memory may be claimed at most once: the same id must not appear in multiple decisions (an id must not be claimed by both merge and conflict/archive, etc.)\n- Memories not mentioned in any decision are automatically kept (keep); no need to output keep for every memory\n- merge keepSource must be one of ids\n- Only merge entries of the same type (identical type)\n- Never invent ids; use only the provided ids\n- Importance is 1-5; after a merge take the highest\n- Write every title, content, and reason in English\n- Output only the JSON array, nothing else"
  },
  "conflict": {
    "zh": "你是记忆库冲突仲裁助手。下面是检测到的高相似度记忆对，可能内容矛盾或重复。\n对每一对输出一个 decision 对象：\n- 两条确实矛盾/重复 → { \"action\": \"conflict\", \"winner\": <保留的id>, \"loser\": <归档的id>, \"reason\": \"理由\" }\n- 两条只是主题相近、并无矛盾 → { \"action\": \"keep\", \"ids\": [<两个id>] }\n规则：\n- winner 应为信息更完整、更新或更可信的一条\n- 只使用提供的 id，不要编造\n- 每对必须输出一个 decision\n- 只输出 JSON 数组，不要其他文字",
    "en": "You are the memory conflict arbiter. Below are detected high-similarity memory pairs that may contradict or duplicate each other.\nFor each pair output one decision object:\n- The two entries genuinely contradict/duplicate -> { \"action\": \"conflict\", \"winner\": <id to keep>, \"loser\": <id to archive>, \"reason\": \"rationale\" }\n- The two entries are merely topically similar, no contradiction -> { \"action\": \"keep\", \"ids\": [<both ids>] }\nRules:\n- winner should be the more complete, newer, or more trustworthy entry\n- Use only the provided ids; never invent them\n- Every pair must produce exactly one decision\n- Write every reason in English\n- Output only a JSON array, no other text"
  },
  "pattern": {
    "zh": "你是记忆库模式发现助手。下面是最近的记忆条目（id、类型、标题、内容）。\n请发现跨条目的稳定模式：用户偏好的规律、反复出现的主题、可复用的工作流或项目规律。\n对每个模式输出一个 create decision：\n{ \"action\": \"create\", \"type\": \"pattern\", \"title\": \"模式一句话标题\", \"content\": \"模式详细描述（2-4句）\", \"importance\": 1-5, \"evidence\": [\"支持该模式的记忆id\"] }\n规则：\n- 只输出有据可依的模式，宁缺毋滥\n- evidence 必须是列表中真实存在的 id\n- 最多输出 N 个模式\n- 只输出 JSON 数组，不要其他文字",
    "en": "You are the memory pattern-discovery assistant. Below are recent memory entries (id, type, title, content).\nDiscover stable cross-entry patterns: regularities in user preferences, recurring themes, reusable workflows or project patterns.\nFor each pattern output one create decision:\n{ \"action\": \"create\", \"type\": \"pattern\", \"title\": \"one-sentence pattern title\", \"content\": \"detailed pattern description (2-4 sentences)\", \"importance\": 1-5, \"evidence\": [\"ids of memories supporting this pattern\"] }\nRules:\n- Only output well-evidenced patterns; prefer fewer over filler\n- evidence must contain ids that actually exist in the list\n- Output at most N patterns\n- Write every title, content, and reason in English\n- Output only a JSON array, no other text"
  },
  "freezeSuffix": {
    "zh": "\n\n当前为「冲突冻结」模式：检测到内容矛盾的条目时，仍请输出 conflict，并以 winner/loser 作为候选、reason 说明理由；冲突不会被自动裁决，而会冻结待人工确认。",
    "en": "\n\nConflict-freeze mode is active: when you detect entries with contradictory content, still output conflict — winner/loser are treated as candidates and reason explains the rationale; conflicts are not auto-adjudicated but frozen for human confirmation."
  }
};

export const STR = {
  // --- inject.js：注入块标题 / 条目行 ---------------------------------------
  hotHeader: {
    zh: (rounds, body) => `[短期上下文] 最近对话（共 ${rounds} 轮）：\n${body}`,
    en: (rounds, body) => `[Short-term context] Recent conversation (${rounds} rounds):\n${body}`
  },
  memoryHeader: {
    zh: "[记忆库] 来自 dsh-mneme 的跨会话记忆（用户偏好与高优先级项目/决策）：",
    en: "[Memory] Cross-session memories from dsh-mneme (user preferences and high-priority project/decision entries):"
  },
  verified: { zh: "[verified] ", en: "[verified] " },
  entryTitle: {
    zh: (title, importance) => `${title}（重要性 ${importance}）`,
    en: (title, importance) => `${title} (importance ${importance})`
  },
  entryLine: {
    zh: (type, verified, title, content) => `- [${type}] ${verified}${title}：${content}`,
    en: (type, verified, title, content) => `- [${type}] ${verified}${title}: ${content}`
  },
  userSettingsHeader: {
    zh: "[用户设置] 来自 dsh-mneme 的用户画像与规则：",
    en: "[User settings] Profile and rules from dsh-mneme:"
  },
  profileLine: {
    zh: (profile) => `- 用户画像：${profile}`,
    en: (profile) => `- Profile: ${profile}`
  },
  ruleLine: {
    zh: (rule) => `- 规则：${rule}`,
    en: (rule) => `- Rule: ${rule}`
  },

  // --- summarize.js：蒸馏转录标签（进入 LLM 上下文） --------------------------
  transcriptUser: { zh: (t) => `用户：${t}`, en: (t) => `User: ${t}` },
  transcriptAssistant: { zh: (t) => `助手：${t}`, en: (t) => `Assistant: ${t}` },
  transcriptToolCall: {
    zh: (name, args) => `工具调用：${name}(${args})`,
    en: (name, args) => `Tool call: ${name}(${args})`
  },
  statusOk: { zh: "成功", en: "success" },
  statusFail: { zh: "失败", en: "failed" },
  transcriptToolResult: {
    zh: (status, out) => `工具结果（${status}）：${out}`,
    en: (status, out) => `Tool result (${status}): ${out}`
  },
  transcriptCode: {
    zh: (status, out) => `代码执行（${status}）：${out}`,
    en: (status, out) => `Code execution (${status}): ${out}`
  },

  // --- dream.js：聚类快照标记 -------------------------------------------------
  clusterHeader: { zh: (n) => `# 聚类 ${n}`, en: (n) => `# Cluster ${n}` },
  conflictMark: { zh: " | [潜在冲突]", en: " | [potential conflict]" },
  summaryTitle: { zh: "记忆库总览", en: "Memory library overview" },

  // --- dream/sleep.js：冲突候选列表 --------------------------------------------
  similarityReason: { zh: (s) => `相似度 ${s}`, en: (s) => `similarity ${s}` },
  candidateConflicts: {
    zh: (p) => `候选冲突：\nid=${p.a.id} | type=${p.a.type} | title=${p.a.title}\n${p.a.content}\n---\nid=${p.b.id} | type=${p.b.type} | title=${p.b.title}\n${p.b.content}\n（相似度 ${p.similarity.toFixed(2)}）`,
    en: (p) => `Candidate conflicts:\nid=${p.a.id} | type=${p.a.type} | title=${p.a.title}\n${p.a.content}\n---\nid=${p.b.id} | type=${p.b.type} | title=${p.b.title}\n${p.b.content}\n(similarity ${p.similarity.toFixed(2)})`
  },

  // --- dream/decisions.js：写回记忆的来源批注 ------------------------------------
  evidenceSuffix: {
    zh: (content, evidence) => `${content}\n\n[证据: ${evidence.join(", ")}]`,
    en: (content, evidence) => `${content}\n\n[Evidence: ${evidence.join(", ")}]`
  },
  supersededSuffix: {
    zh: (content, oldInfo) => `${content}\n\n（已否决旧信息：${oldInfo}）`,
    en: (content, oldInfo) => `${content}\n\n(superseded outdated info: ${oldInfo})`
  },

  // --- service.js：三方合并冲突批注（写入记忆内容） -----------------------------
  serviceConflictMarker: {
    zh: (ts, content) => `\n\n> ⚠️ 并发冲突：人工编辑 vs 记忆库并发更新（${ts}）\n> 记忆库版本：${content}`,
    en: (ts, content) => `\n\n> ⚠️ Concurrent conflict: human edit vs concurrent memory-library update (${ts})\n> memory-library version: ${content}`
  },

  // --- mirror.js：镜像文件标签（渲染随实例语言；解析两种语言都认） ----------------
  mirrorLabel: {
    zh: { type: "类型", importance: "重要性", tags: "标签", updated: "更新时间", source: "来源" },
    en: { type: "Type", importance: "Importance", tags: "Tags", updated: "Updated", source: "Source" }
  },
  mirrorHeader: {
    zh: (name) => `# ${name} — dsh-mneme 镜像\n\n<!-- 手工编辑此文件会被合并回记忆库（人工优先）。 -->\n\n`,
    en: (name) => `# ${name} — dsh-mneme mirror\n\n<!-- Manual edits to this file are merged back into the memory store (human edits win). -->\n\n`
  },

  prompts: PROMPTS
};
