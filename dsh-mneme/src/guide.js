// #249（第一批）：能力说明——写给模型的「怎么用这套记忆」，不是给用户的文案。
//
// 为什么英文、且只留一份正本：注入指引的参照实现全部用英文（ACP 的
// ACP_SYSTEM_PROMPT + HOW_TO_COMPRESS_RULES、mnemon 的 ROUTING_GUIDANCE、
// 宿主压缩摘要规则），仓库既有先例也是 src/tools.js 的工具描述硬编码英文。
// src/lang.js 的 memory.language 管的是「生成出来的记忆内容与块内标题」，与本
// 模块是两件事，故不并入 STR、不做 zh/en 双写（双写只会让两份文本日后漂移）。
//
// 两个承载位（#249 §5）：①工具描述——常驻、零注入成本，放「何时用这个工具」
// 这类单工具指引（TOOL_GUIDE）；②系统提示段 order 150——放工具描述装不下的
// 总则（优先序、何时查 / 何时写 / 何时 no-op）。该段必须同会话内稳定，否则
// 每轮变化会作废其后的前缀缓存，因此这里全是常量，不含任何运行时插值。
//
// 前缀 `[dsh-mneme memory]` 是机械校验用的：测试按它断言「只在开时出现、且不
// 逐轮复读」，也让维护者能一眼认出这段文本的归属。

const SECTION_LINES = [
  "[dsh-mneme memory] Read once; it applies to every turn of this session.",
  "1. Precedence: the current instruction and the repository's actual state outrank any stored memory. " +
    "When a memory contradicts either, check the instruction or the repository itself before relying on it — memory_search " +
    "searches stored memories only, so it finds earlier context, never the present state. Never treat an old memory as current fact.",
  "2. Recall on demand: call memory_search when the task depends on earlier decisions, user preferences, or project history " +
    "that is not already in context. Do not search for facts you can read directly from the repository.",
  "3. Write back sparingly: use memory_save for durable, cross-session value — a preference, a decision with its rationale, " +
    "an engineering constraint, a pitfall with its root cause. Trivial single-turn work is not worth a memory.",
  "4. When unsure, do nothing. Not acting is a valid outcome: a useless memory is paid for by every future session.",
  "5. Prefer the reversible tools. memory_archive hides an entry and memory_forget only stops it being injected — both are " +
    "recoverable. memory_delete is permanent, so reach for it only when an entry is wrong or unwanted, not merely stale."
];

/** 系统提示段（order 150）的总则文本。常量：同会话内稳定是硬约束。 */
export const MEMORY_GUIDE_SECTION = SECTION_LINES.join("\n");

/** 单工具判断指引，追加到对应工具描述尾部（`injectGuidanceEnabled` 开启时）。 */
export const TOOL_GUIDE = {
  memory_search:
    " Use this when the task depends on earlier decisions, preferences, or project history that is not already in context, " +
    "or to look for a newer memory behind one that seems stale. " +
    "Skip it for facts you can read directly from the repository.",
  memory_save:
    " Save only durable, cross-session value (a preference, a decision with its rationale, an engineering constraint, " +
    "a pitfall with its root cause). Trivial single-turn work does not belong here, and when unsure it is correct to save nothing."
};
