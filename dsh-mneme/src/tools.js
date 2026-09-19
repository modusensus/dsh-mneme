import { defineTool } from "@deepseek-ai/dsh-tools";
import { createScopeResolver, normalizeExplicitScope } from "./scope.js";
import { describeLocalRuntime, resolveRuntimeEntry } from "./runtime/loader.js";
import { defaultRuntimeDir } from "./runtime/layout.js";
import { hostModulesDir, loadRuntimeManifest, provisionRuntime } from "./runtime/provision.js";
import { matchesPlatform } from "./runtime/closure.js";
import { verifyPayload } from "./runtime/verify.js";
import { TOOL_GUIDE } from "./guide.js";

const TEXT_OUTPUT = (text) => [{ type: "text", text }];
// Per-registry tool-name registry: guards against duplicate registration on
// live patch reload (DSH Desktop `patchReload: "live"`) where a plugin may be
// re-applied on the same tools registry without an intervening unregister.
const REGISTERED_TOOLS = new WeakMap();

// Wire shape emitted by service.toApiList: shared by memory_search and
// memory_list so their output schemas always declare every key the runtime
// value carries (additionalProperties: false would reject undeclared keys).
const MEMORY_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", required: true },
    type: { type: "string", required: true },
    title: { type: "string", required: true },
    content: { type: "string", required: true },
    tags: { type: "array", items: { type: "string" } },
    importance: { type: "integer", required: true },
    source: { type: "string" },
    // v0.8.0 A2：scope 标注与事件发生时间随行透出（未标注时缺省，可选属性）。
    // v0.8.1 底座：scope 来源（auto/explicit）与决策时间随行透出（同样可选）。
    agent_scope: { type: "string" },
    workspace_scope: { type: "string" },
    agent_scope_source: { type: "string" },
    workspace_scope_source: { type: "string" },
    scope_decided_at: { type: "string" },
    sensitivity: { type: "string" },
    occurred_at: { type: "string" },
    // #230：document 指针行的文件定位——「全文按需读」的入口；普通行缺省。
    doc_path: { type: "string" },
    created_at: { type: "string", required: true },
    updated_at: { type: "string", required: true }
  }
};
// 导出供回归测试断言 memory_get 与共享 schema 同源（#184 防漂移护栏）。
export { MEMORY_ITEM_SCHEMA };

// v0.8.0 A2：occurred 时间窗参数 → store 过滤选项（list/count 同口径）；
// 未传参返回空对象，既有调用方不受影响。（A3 复核：此处入参仅含 occurred 边界。）
function occurredWindow(args) {
  const from = args?.occurred_from ?? null;
  const to = args?.occurred_to ?? null;
  return from !== null || to !== null ? { occurredFrom: from, occurredTo: to } : {};
}

// v0.8.0 A3：strictScope 硬过滤的 visibility 选项（store.list/count 同口径）。
// flag 关或会话 scope 未解析出（flag 关时解析器返回 null）→ 空对象不过滤；
// scope 为 {null,null}（匿名会话）时照传——store 侧 fail-closed 只放行未标注行。
function strictVisibility(config, scope) {
  if (config?.strictScope !== true || !scope) return {};
  return { visibility: { agentScope: scope.agent_scope, workspaceScope: scope.workspace_scope } };
}

// v0.8.0 A2：检索结果的 provenance 附加段——只在有标注时出现，未标注行渲染
// 与 A2 前逐字节一致。
const MEMORY_PROVENANCE = (m) => {
  const parts = [];
  if (m.occurred_at) parts.push(`occurred: ${m.occurred_at}`);
  if (m.agent_scope || m.workspace_scope) {
    parts.push(`scope: ${m.agent_scope ?? "global"} / ${m.workspace_scope ?? "global"}`);
  }
  if (m.sensitivity) parts.push(`sensitivity: ${m.sensitivity}`);
  return parts.length ? ` | ${parts.join(" | ")}` : "";
};

export function createTools(ctx, service, config, embedder) {
  const toolsRegistry = ctx.tools;
  let registeredTools = REGISTERED_TOOLS.get(toolsRegistry);
  if (!registeredTools) {
    registeredTools = new Set();
    REGISTERED_TOOLS.set(toolsRegistry, registeredTools);
  }
  // v0.8.0 A1/A2（issue #17）：会话 scope 解析（agentPreset + workspace 反查）。
  // flag 关闭时恒返回 null——写入不标注，检索不加权，行为与 A1 前完全一致。
  // logger 透传：registry 反查失败时 warnOnce 才有出口（否则静默降级无观测）。
  const resolveSessionScope = createScopeResolver({ ctx, config, logger: ctx.logger });
  // #249 第一批：能力说明（injectGuidanceEnabled）开启时，给「何时用」最有歧义
  // 的两个工具补一句判断指引。工具描述常驻、不进每轮上下文，这个位子零注入
  // 成本；关闭时描述逐字节不变，也不动其他工具的文案。
  const withToolGuide = (name, description) =>
    config?.injectGuidanceEnabled === true && TOOL_GUIDE[name] ? `${description}${TOOL_GUIDE[name]}` : description;

  // 复核项 4（issue #170）：strictScope 下他 scope（explicit）的行对工具侧按
  // 「不存在」处理——update/delete 与 memory_get 同款无存在性泄漏。strictScope
  // 关、或会话身份取不到（scope 为 null）时恒可见（与 get 的短路语义一致）。
  const visibleUnderStrictScope = (memory, exec) => {
    if (config?.strictScope !== true) return true;
    const scope = resolveSessionScope(exec);
    return !scope || service.isVisibleInScope(memory, scope);
  };
  // 在调用点以「展开恒为 undefined」的形态前置校验（抛错即中止写入）。
  const assertVisibleForTool = (id, exec) => {
    const memory = id ? service.getById(id) : undefined;
    if (!visibleUnderStrictScope(memory, exec)) throw new Error("memory not found");
    return undefined;
  };
  // delete 侧需要目标行本身判断存在性（不可见 = 视作不存在，不抛错）。
  const visibleForTool = (id, exec) => {
    const memory = id ? service.getById(id) : undefined;
    return visibleUnderStrictScope(memory, exec) ? memory : undefined;
  };
  const tools = [
    defineTool({
      name: "memory_save",
      description: withToolGuide(
        "memory_save",
        "Persist one memory entry for future sessions (user preferences, project state, decisions). " +
          "Call this when the user states a durable preference, a project decision is made, or a lesson is learned. " +
          "Merges into an existing entry of the same type when the title matches."
      ),
      parameters: {
        // document 不在此列（#230）：document 行只能经 memory_register_document
        // 铸造（注册校验 + doc_path + evidence），防止 memory_save 造出无指针
        // 无回链的伪行。
        type: { type: "string", required: true, enum: ["preference", "project", "decision", "history", "rejected_solution", "pitfall", "constraint"], description: "preference=user profile; project=project knowledge/state; decision=key decision; history=conversation summary; rejected_solution=rejected/abandoned implementation approach; pitfall=debugging lesson (symptom+root cause+fix); constraint=engineering constraint" },
        title: { type: "string", required: true, description: "Short unique title" },
        content: { type: "string", required: true, description: "Memory body" },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
        importance: { type: "integer", description: "1-5; >= threshold auto-injects into future sessions" },
        source: { type: "string", description: "Optional provenance" },
        sensitivity: { type: "string", description: "Optional sensitivity label (free-form, e.g. personal). Same-title entries with different sensitivity stay separate instead of merging." },
        occurred_at: { type: "string", description: "Optional ISO-8601 instant the remembered event happened (differs from write time). Invalid values are ignored." },
        agent_scope: { type: "string", description: "Optional explicit agent-scope declaration (issue #170): 'global' or '*' makes this memory visible to every agent; any other value narrows it to that label. Overrides the automatic carrier label for this write; honored even when automatic scope labeling is disabled." },
        workspace_scope: { type: "string", description: "Optional explicit workspace-scope declaration: 'global' or '*' makes this memory visible in every workspace; any other value narrows it to that label. Overrides the automatic carrier label for this write; honored even when automatic scope labeling is disabled." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", required: true, enum: ["created", "merged"] },
            id: { type: "string", required: true }
          }
        },
        render: (_args, value) => TEXT_OUTPUT(`memory ${value.action}: ${value.id}`)
      },
      async execute(args, exec) {
        // scope 标注（v0.8.1 底座，issue #170）：默认由会话身份解析（载体自动
        // 标注，盖 auto 章）；显式 agent_scope/workspace_scope 参数逐维覆盖并盖
        // explicit 章。解析绝不抛错、取不到落 NULL。
        // 复核项 2（#170）：scopeEnabled 只门控「自动标注」分支——显式声明与
        // 读取身份（search/list/get/注入经同一解析器）不受 flag 限制，否则
        // strictScope 硬墙会被 flag 静默拆掉（fail-open）。
        // （存储 NULL，由 source 列与「从未标注」区分）。非字符串参数在工具
        // 入参 schema 层即被拒（type: "string"）——脏值到不了归一化，无静默放宽。
        const scope = resolveSessionScope(exec);
        const autoStamping = config?.scopeEnabled === true;
        const agentLabel = args.agent_scope !== undefined
          ? { value: normalizeExplicitScope(args.agent_scope), source: "explicit" }
          : autoStamping && scope ? { value: scope.agent_scope, source: "auto" } : null;
        const workspaceLabel = args.workspace_scope !== undefined
          ? { value: normalizeExplicitScope(args.workspace_scope), source: "explicit" }
          : autoStamping && scope ? { value: scope.workspace_scope, source: "auto" } : null;
        const { action, memory } = service.saveWithDedupe({
          type: args.type,
          title: args.title,
          content: args.content,
          tags: args.tags ?? [],
          importance: args.importance ?? 3,
          source: args.source ?? "tool",
          ...(agentLabel ? { agent_scope: agentLabel.value, agent_scope_source: agentLabel.source } : {}),
          ...(workspaceLabel ? { workspace_scope: workspaceLabel.value, workspace_scope_source: workspaceLabel.source } : {}),
          ...(args.sensitivity !== undefined ? { sensitivity: args.sensitivity } : {}),
          ...(args.occurred_at !== undefined ? { occurred_at: args.occurred_at } : {})
        });
        return { action, id: memory.id };
      }
    }),

    defineTool({
      name: "memory_search",
      description: withToolGuide(
        "memory_search",
        "Search the cross-session memory store. Use when you need past context: how a problem was solved, user preferences, project decisions. Substring-matches title/content/tags, and augments results with semantic (vector) recall + optional rerank when an embeddings provider is configured. Returns matching entries with source and timestamps."
      ),
      // A2 检索接线：occurred 时间窗 + 会话 scope 加成（见 execute）。
      parameters: {
        query: { type: "string", required: true, description: "Search text; substring match over title/content/tags" },
        limit: { type: "integer", description: "Max results (default 20)" },
        mode: { type: "string", enum: ["auto", "keyword", "vector", "hybrid"], description: "auto (default) = keyword hits first + vector fill when enabled; keyword = text only; vector = semantic recall first (falls back to keyword); hybrid = vector leads, keyword fills remaining slots" },
        semantic: { type: "boolean", description: "Shorthand: enable semantic (vector) recall (same as mode=vector when true)" },
        rerank: { type: "boolean", description: "Run cross-encoder rerank over candidates when a local reranker is configured (default true)" },
        occurred_from: { type: "string", description: "Optional ISO date/timestamp lower bound on when the remembered event happened (occurred_at, falling back to created_at). Date-only values are inclusive from that day's 00:00Z." },
        occurred_to: { type: "string", description: "Optional ISO date/timestamp upper bound on occurred_at. Date-only values are inclusive through that day's 23:59:59.999Z." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            items: {
              type: "array", required: true,
              items: MEMORY_ITEM_SCHEMA
            }
          }
        },
        render: (_args, value) => {
          const items = value.items ?? [];
          if (items.length === 0) return TEXT_OUTPUT("No memory entries found.");
          const body = items
            .map((m, i) => {
              const preview = (m.content ?? "").replace(/\s+/g, " ").trim();
              const cut = preview.length > 200 ? `${preview.slice(0, 200)}…` : preview;
              return `[${i + 1}] ${m.title}\n    ID: ${m.id} | type: ${m.type} | importance: ${m.importance} | updated: ${m.updated_at}${MEMORY_PROVENANCE(m)}\n    ${cut}`;
            })
            .join("\n\n");
          return TEXT_OUTPUT(`Found ${items.length} memory entr${items.length === 1 ? "y" : "ies"}:\n\n${body}`);
        }
      },
      async execute(args, exec) {
        const limit = args.limit ?? 20;
        const mode = args.semantic === true && !args.mode ? "vector" : args.mode ?? "auto";
        // v0.8.0 A2（issue #17）：scope 检索加权 + occurred 时间窗的检索接线。
        // flag 关闭或解析不出 scope 时为 null，检索行为与 A2 前一致。
        const scope = resolveSessionScope(exec);
        const occurredFrom = args.occurred_from ?? null;
        const occurredTo = args.occurred_to ?? null;
        const rows = await service.searchMemories(args.query, {
          mode,
          topK: limit,
          useRerank: args.rerank !== false,
          ...(scope ? { scope } : {}),
          ...(occurredFrom !== null || occurredTo !== null ? { occurredFrom, occurredTo } : {})
        });
        return { items: service.toApiList(rows) };
      }
    }),

    defineTool({
      name: "memory_list",
      description: "List memory entries by type, high-importance first, then newest, paginated. Set include_archived=true to also list archived (hidden) entries so they can be located and restored.",
      parameters: {
        type: { type: "string", enum: ["preference", "project", "decision", "history", "rejected_solution", "pitfall", "constraint", "document"], description: "Filter by type; omit for all. 'document' (#230) = agent-registered document pointer rows" },
        limit: { type: "integer", description: "Page size (default 50)" },
        offset: { type: "integer", description: "Page offset (default 0)" },
        include_archived: { type: "boolean", description: "Include archived (hidden) entries so they can be found and restored (default false)" },
        occurred_from: { type: "string", description: "Optional ISO date/timestamp lower bound on when the remembered event happened (occurred_at, falling back to created_at). Date-only values are inclusive from that day's 00:00Z." },
        occurred_to: { type: "string", description: "Optional ISO date/timestamp upper bound on occurred_at. Date-only values are inclusive through that day's 23:59:59.999Z." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            items: {
              type: "array", required: true,
              items: MEMORY_ITEM_SCHEMA
            },
            total: { type: "integer", required: true }
          }
        },
        render: (_args, value) => {
          const items = value.items ?? [];
          if (items.length === 0) return TEXT_OUTPUT(`0 memory entries (of ${value.total}).`);
          const body = items
            .map((m, i) => `[${i + 1}] ${m.title} (type=${m.type}, importance=${m.importance})\n    ID: ${m.id} | updated: ${m.updated_at}${MEMORY_PROVENANCE(m)}`)
            .join("\n\n");
          return TEXT_OUTPUT(`${items.length} memory entries (of ${value.total}):\n\n${body}`);
        }
      },
      async execute(args) {
        const includeArchived = args.include_archived === true;
        const rows = service.toApiList(service.list({
          type: args.type,
          limit: args.limit ?? 50,
          offset: args.offset ?? 0,
          includeArchived,
          ...occurredWindow(args),
          // A3：strict 开启时按会话 scope 硬过滤（宿主按 (args, runContext) 调用，
          // 从 arguments 取第二参）。
          ...strictVisibility(config, resolveSessionScope(arguments[1]))
        }));
        return { items: rows, total: service.count(args.type, { includeArchived, ...occurredWindow(args), ...strictVisibility(config, resolveSessionScope(arguments[1])) }) };
      }
    }),

    defineTool({
      name: "memory_get",
      description: "Fetch one memory entry by ID and return its full content as text. Use after memory_list to read a specific entry.",
      parameters: {
        id: { type: "string", required: true, description: "Memory id" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            // 与 memory_search / memory_list 共用同一份 item schema——DTO 由
            // toApiList 统一产出，内联副本曾漏掉 v0.8.1 的 scope 来源三键，
            // 任何被标注过的行都过不了 in-process 校验（#184）。
            memory: MEMORY_ITEM_SCHEMA
          }
        },
        render: (_args, value) => {
          const m = value.memory;
          // #230：document 指针行把文件路径亮在首行——「全文按需读」从这里拿路径。
          const doc = m.doc_path ? ` | doc: ${m.doc_path}` : "";
          return TEXT_OUTPUT(`${m.title}\nID: ${m.id} | type: ${m.type} | importance: ${m.importance}${doc}${MEMORY_PROVENANCE(m)}\n\n${m.content}`);
        }
      },
      async execute(args) {
        const memory = service.getById(args.id);
        if (memory === undefined) throw new Error("memory not found");
        // v0.8.0 A3：strictScope 下他 scope 的行按不存在处理（无存在性泄漏）。
        // 宿主注册表按 (args, runContext) 两参调用处理器，从 arguments 取第二参。
        const runContext = arguments[1];
        const scope = resolveSessionScope(runContext);
        if (config.strictScope === true && scope && !service.isVisibleInScope(memory, scope)) {
          throw new Error("memory not found");
        }
        return { memory: service.toApiList([memory])[0] };
      }
    }),

    defineTool({
      name: "memory_update",
      description: "Modify an existing memory entry (title, content, type, tags, importance).",
      parameters: {
        id: { type: "string", required: true, description: "Memory id" },
        title: { type: "string" },
        content: { type: "string" },
        // document 不在此列（#230）：type 不许改入 document——既有 document 行
        // 的摘要修复（只改 content/title）不受影响。
        type: { type: "string", enum: ["preference", "project", "decision", "history", "rejected_solution", "pitfall", "constraint"] },
        tags: { type: "array", items: { type: "string" } },
        importance: { type: "integer", description: "1-5" },
        reason: { type: "string", description: "Optional context for the correction (what the user actually said/wanted), recorded for reflection" },
        agent_scope: { type: "string", description: "Optional explicit agent-scope correction (issue #170): 'global' or '*' widens visibility to every agent; any other value narrows it to that label. Omit to keep the current agent scope. Recorded as an explicit scope decision (audited)." },
        workspace_scope: { type: "string", description: "Optional explicit workspace-scope correction: 'global' or '*' widens visibility to every workspace; any other value narrows it to that label. Omit to keep the current workspace scope. Recorded as an explicit scope decision (audited)." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            memory: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                title: { type: "string", required: true },
                content: { type: "string", required: true }
              }
            }
          }
        },
        render: (_args, value) => TEXT_OUTPUT(`Updated memory ${value.memory.id}: ${value.memory.title}`)
      },
      async execute(args) {
        const memory = service.update(args.id, {
          title: args.title,
          content: args.content,
          type: args.type,
          tags: args.tags,
          importance: args.importance,
          // 复核项 4（#170）：strictScope 下他 scope 的行按「不存在」处理（与 get 对齐），
          // 展开恒为 undefined，仅承担写入前校验。
          ...(assertVisibleForTool(args.id, arguments[1])),
          ...(args.agent_scope !== undefined ? { agent_scope: args.agent_scope } : {}),
          ...(args.workspace_scope !== undefined ? { workspace_scope: args.workspace_scope } : {})
        }, { query: args.reason });
        return { memory: { id: memory.id, title: memory.title, content: memory.content } };
      }
    }),

    defineTool({
      name: "memory_delete",
      description: "Permanently delete a memory entry.",
      parameters: {
        id: { type: "string", required: true }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { deleted: { type: "boolean", required: true } }
        },
        render: (_args, value) => TEXT_OUTPUT(value.deleted ? "Memory deleted." : "Memory not found.")
      },
      async execute(args) {
        // 复核项 4（#170）：不可见（explicit 他 scope）= 视作不存在，无存在性泄漏。
        const target = visibleForTool(args.id, arguments[1]);
        if (target) service.remove(args.id);
        return { deleted: !!target };
      }
    }),

    defineTool({
      name: "memory_forget",
      description:
        "Stop a memory from being auto-injected and from appearing in searches and lists without deleting it. " +
        "The entry stays in storage; pass forgotten: false to restore it.",
      parameters: {
        id: { type: "string", required: true },
        forgotten: { type: "boolean", description: "Suppress (true, default) or restore (false) the entry's visibility" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            memory: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                forgotten: { type: "boolean", required: true }
              }
            }
          }
        },
        render: (_args, value) => TEXT_OUTPUT(`Memory ${value.memory.id} injection ${value.memory.forgotten ? "suppressed" : "restored"}.`)
      },
      async execute(args) {
        if (service.getById(args.id) === undefined) {
          throw new Error("memory not found");
        }
        const memory = service.setForget(args.id, args.forgotten ?? true);
        return { memory: { id: memory.id, forgotten: memory.forgotten } };
      }
    }),

    defineTool({
      name: "memory_archive",
      description:
        "Archive a memory (hide it from active lists, search, injection and dream consolidation) or restore it. " +
        "Archived entries stay in storage and are recoverable: pass archived=false to restore, and use memory_list with " +
        "include_archived=true to find archived entries.",
      parameters: {
        id: { type: "string", required: true, description: "Memory id" },
        archived: { type: "boolean", description: "Archive (true, default) or restore (false) the entry" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            memory: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                archived: { type: "boolean", required: true }
              }
            }
          }
        },
        render: (_args, value) => TEXT_OUTPUT(`Memory ${value.memory.id} ${value.memory.archived ? "archived" : "restored"}.`)
      },
      async execute(args) {
        if (service.getById(args.id) === undefined) {
          throw new Error("memory not found");
        }
        const memory = service.setArchived(args.id, args.archived ?? true);
        return { memory: { id: memory.id, archived: memory.archived } };
      }
    }),

    // #230（#164 设计稿评审线）：document 型记忆注册——agent 产长文档的指针
    // 行铸造口。写入权分离：全文归 agent（管线对文件零读零写零改），库里只
    // 存摘要 + doc_path + evidence 三样；C2 比对去重、supersede 记账在
    // service.registerDocument（src/document.js）内完成。判断指引：调研报告/
    // 设计稿/长整理产物「存外档」用本工具；原子事实（偏好/决策/教训）仍走
    // memory_save；tag 与章节名建议用英文（跨语言稳定键），摘要正文可多语言。
    defineTool({
      name: "memory_register_document",
      description:
        "Register an agent-authored document (research report, design doc, long digest) into memory as a pointer row. " +
        "Write-ownership split: the full text stays agent-owned on disk — the pipeline never reads or rewrites it; the DB " +
        "stores only the summary + doc_path + evidence. Validates the file exists (absolute path, non-empty regular file), " +
        "intersects evidence with real memory ids (all-fabricated evidence is rejected; unknown ids are dropped and the row " +
        "is tagged evidence_degraded), and dedupes: re-registering the same path or title supersedes the old row (the old " +
        "file is never touched; content_history stays traceable), while a merely near-duplicate summary of a different " +
        "document row is rejected — update that row instead. Use for 'where is the conclusion doc for this project?' " +
        "lookups; atomic facts still go to memory_save.",
      parameters: {
        path: { type: "string", required: true, description: "Absolute path of the document file (~ is expanded); must already exist as a non-empty regular file. The full text stays agent-owned — this pipeline never touches it." },
        title: { type: "string", required: true, description: "Short unique title (English recommended: it is the cross-language stable dedupe/supersede key)" },
        summary: { type: "string", required: true, description: "One-paragraph summary stored in the DB and used for injection (any language)" },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags (English recommended)" },
        importance: { type: "integer", description: "1-5 (default 3); the summary row injects at the next-priority tier within documentInjectBudget when importance >= threshold" },
        evidence: { type: "array", items: { type: "string" }, description: "Memory ids this document is grounded in; each is verified against the store (fabricated evidence is rejected; unknown/archived ids are dropped and the row is tagged evidence_degraded)" },
        source: { type: "string", description: "Optional provenance" },
        sensitivity: { type: "string", description: "Optional sensitivity label (free-form, e.g. personal). Part of the supersede matching key — same path/title with a different sensitivity stays a separate document." },
        agent_scope: { type: "string", description: "Optional explicit agent-scope declaration (issue #170): 'global' or '*' makes this document visible to every agent; any other value narrows it to that label. Overrides the automatic carrier label for this write; honored even when automatic scope labeling is disabled." },
        workspace_scope: { type: "string", description: "Optional explicit workspace-scope declaration (issue #170): 'global' or '*' makes this document visible in every workspace; any other value narrows it to that label. Overrides the automatic carrier label for this write; honored even when automatic scope labeling is disabled." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", required: true, enum: ["created", "superseded"] },
            id: { type: "string", required: true },
            superseded_id: { type: "string" },
            evidence_kept: { type: "integer", required: true },
            evidence_dropped: { type: "integer", required: true },
            degraded: { type: "boolean", required: true }
          }
        },
        render: (_args, value) => {
          const sup = value.superseded_id ? ` (supersedes ${value.superseded_id})` : "";
          const ev = ` | evidence: ${value.evidence_kept} kept, ${value.evidence_dropped} dropped${value.degraded ? " [degraded]" : ""}`;
          return TEXT_OUTPUT(`document ${value.action}: ${value.id}${sup}${ev}`);
        }
      },
      async execute(args, exec) {
        // scope 标注与 memory_save 同款（#170）：默认会话身份自动标注，显式
        // 参数逐维覆盖。校验/去重/supersede 全在 service.registerDocument。
        const scope = resolveSessionScope(exec);
        const autoStamping = config?.scopeEnabled === true;
        const agentLabel = args.agent_scope !== undefined
          ? { value: normalizeExplicitScope(args.agent_scope), source: "explicit" }
          : autoStamping && scope ? { value: scope.agent_scope, source: "auto" } : null;
        const workspaceLabel = args.workspace_scope !== undefined
          ? { value: normalizeExplicitScope(args.workspace_scope), source: "explicit" }
          : autoStamping && scope ? { value: scope.workspace_scope, source: "auto" } : null;
        // strictScope（#170 复核项 4 同款无存在性泄漏）：他 scope 的 evidence id
        // 按「不存在」处理——注册器用全局 getById 求交，看不见的行在这里先标出，
        // 与 unknown/archived 同落 dropped，不进持久化 evidence（不得为跨 scope
        // id 建立引用）。
        const hiddenEvidence = [];
        if (config?.strictScope === true && scope && Array.isArray(args.evidence)) {
          for (const raw of args.evidence) {
            const id = String(raw ?? "").trim();
            if (!id) continue;
            const row = service.getById(id);
            if (row && !service.isVisibleInScope(row, scope)) hiddenEvidence.push(id);
          }
        }
        const result = await service.registerDocument({
          path: args.path,
          title: args.title,
          summary: args.summary,
          tags: args.tags ?? [],
          ...(args.importance !== undefined ? { importance: args.importance } : {}),
          evidence: args.evidence ?? [],
          source: args.source ?? "tool",
          ...(args.sensitivity !== undefined ? { sensitivity: args.sensitivity } : {}),
          ...(agentLabel ? { agent_scope: agentLabel.value, agent_scope_source: agentLabel.source } : {}),
          ...(workspaceLabel ? { workspace_scope: workspaceLabel.value, workspace_scope_source: workspaceLabel.source } : {})
        }, { hiddenEvidenceIds: hiddenEvidence });
        return {
          action: result.action,
          id: result.memory.id,
          ...(result.superseded ? { superseded_id: result.superseded.id } : {}),
          evidence_kept: result.evidence_kept,
          evidence_dropped: result.evidence_dropped,
          degraded: result.degraded
        };
      }
    }),

    // 运行时口子（issue #131 / PR-C）。
    //
    // 为什么要有这个工具：mneme 的取向是「本体保持完善但轻量；重的功能存在、默认不开、不被依赖」。
    // 本地向量化就是那个重功能 —— 它需要额外一份运行时（解包后数百 MB）。面板上有按钮，但用户
    // 可能根本不看面板；这时 agent 需要一个入口，能先查状态、把代价告诉用户，再按需取回。
    //
    // 关于「要不要直接 provision」：它会联网、可能传几十到上百 MB、耗时数分钟。所以工具描述里
    // 明确要求先告知用户；只有在用户已经表示要本地向量化时才直接动手。
    defineTool({
      name: "memory_runtime",
      description:
        "Inspect or provision the LOCAL inference runtime that dsh-mneme's local (offline) embedding and rerank need: " +
        "the transformers + onnxruntime dependency closure, hundreds of MB unpacked. It is deliberately NOT a default " +
        "dependency — mneme's core stays lightweight and local vectorization is opt-in — so this tool is the hook that " +
        "makes the heavy capability available on demand. Use action=status first: it is read-only and reports whether " +
        "the runtime is ready plus what provisioning would cost. action=provision tries, in order: (1) adopting an " +
        "existing copy from this profile's node_modules (no network; hardlinked when on the same volume, so no extra " +
        "disk), (2) a configured local .tgz directory, (3) downloading from the npm registry against a pinned manifest, " +
        "verifying every tarball's sha512. Provisioning can transfer tens to hundreds of MB and take minutes: unless " +
        "the user has already asked for local vectorization, tell them that cost before calling it. action=verify loads " +
        "the runtime and runs one real inference (strictly offline, so the model must already be cached).",
      parameters: {
        action: { type: "string", enum: ["status", "provision", "verify"], required: true, description: "status = read-only; provision = fetch/adopt the runtime; verify = run one real inference" },
        overwrite: { type: "boolean", description: "provision only: replace an existing payload (use when repairing a broken one)" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            summary: { type: "string", required: true },
            status: { type: "string", required: true },
            cost: { type: "string", required: true },
            strategy: { type: "string" },
            payloadId: { type: "string" },
            packages: { type: "integer" },
            files: { type: "integer" },
            bytes: { type: "integer" },
            dimension: { type: "integer" },
            reason: { type: "string" }
          }
        },
        render: (_args, value) => TEXT_OUTPUT(value.summary)
      },
      async execute(args) {
        const runtimeDir = config?.runtimeDir ?? "";
        const manifest = loadRuntimeManifest();
        const forPlatform = Array.isArray(manifest?.packages) ? manifest.packages.filter((pkg) => matchesPlatform(pkg, process.platform, process.arch)) : null;
        const cost =
          `Local vectorization needs an extra local inference runtime (transformers + onnxruntime closure, ` +
          `hundreds of MB unpacked${forPlatform ? `, ${forPlatform.length} packages for this platform` : ""}). ` +
          `It is not a default dependency: provisioning adopts an existing copy when possible, otherwise downloads it.`;

        if (args.action === "provision") {
          const result = await provisionRuntime({
            hostModulesDir: hostModulesDir(import.meta.url),
            runtimeDir,
            localTarballDir: config?.runtimeTarballDir ?? "",
            mirror: config?.runtimeMirror ?? "",
            overwrite: args.overwrite === true,
            manifest
          });
          return {
            summary: result.ok
              ? `Runtime ${result.strategy === "download" ? "downloaded from npm" : "adopted from this machine"}: ` +
                `${result.packages} packages / ${result.files} files. Local embedding can be used after a DSH reload.`
              : `Could not provision the runtime: ${result.reason}`,
            status: result.ok ? "available" : "failed",
            cost,
            strategy: result.strategy,
            ...(result.payloadId ? { payloadId: result.payloadId } : {}),
            ...(result.packages === undefined ? {} : { packages: result.packages }),
            ...(result.files === undefined ? {} : { files: result.files }),
            ...(result.bytes === undefined ? {} : { bytes: result.bytes }),
            ...(result.reason ? { reason: result.reason } : {})
          };
        }

        if (args.action === "verify") {
          const candidate = resolveRuntimeEntry({ runtimeDir: runtimeDir || undefined });
          if (candidate === null) {
            return { summary: "No usable runtime payload to verify.", status: "missing", cost };
          }
          const report = await verifyPayload(candidate.dir, { cacheDir: config?.embedModelCacheDir || undefined });
          return {
            summary: report.ok
              ? `Runtime verified: real inference succeeded (dim ${report.functional.dim}, ${report.functional.rows} rows, ` +
                `${report.functional.elapsedMs}ms, offline). Integrity: ${report.integrity.status}.`
              : `Runtime verification failed — structural: ${report.structural.ok}, functional: ${report.functional.ok} (${report.functional.reason}).`,
            status: report.ok ? "verified" : "failed",
            cost,
            payloadId: candidate.payloadId,
            ...(report.functional.dim ? { dimension: report.functional.dim } : {}),
            ...(report.ok ? {} : { reason: report.functional.reason })
          };
        }

        // status：只读，且刻意不加载模型（那要几百毫秒且碰缓存）。报告要给到 agent 足够的信息去
        // 决定「要不要打扰用户」。
        const report = describeLocalRuntime({ runtimeDir: runtimeDir || defaultRuntimeDir() });
        return {
          summary:
            `Local inference runtime: ${report.status}` +
            (report.payloadId ? ` (${report.payloadId}, ${report.procedure ?? "?"}, ${report.materialize ?? "?"})` : "") +
            `. ${report.status === "available" ? "Local embedding/rerank can be used." : "Local embedding is unavailable — " + (report.hint ?? "")}`,
          status: report.status,
          cost,
          ...(report.payloadId ? { payloadId: report.payloadId } : {}),
          ...(forPlatform ? { packages: forPlatform.length } : {}),
          ...(report.reason ? { reason: report.reason } : {})
        };
      }
    })
  ];

  for (const tool of tools) {
          if (registeredTools.has(tool.name)) {
        ctx.logger?.warn?.(`[dsh-mneme] tool "${tool.name}" already registered, skipping duplicate`);
        continue;
      }
      registeredTools.add(tool.name);
      ctx.tools.register(tool);
  }

  return tools;
}
