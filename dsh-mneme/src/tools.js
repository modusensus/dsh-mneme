import { defineTool } from "@deepseek-ai/dsh-tools";

const TEXT_OUTPUT = (text) => [{ type: "text", text }];

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
    session_id: { type: "string" },
    created_at: { type: "string", required: true },
    updated_at: { type: "string", required: true }
  }
};

export function createTools(ctx, service, config, embedder) {
  const tools = [
    defineTool({
      name: "memory_save",
      description:
        "Persist one memory entry for future sessions (user preferences, project state, decisions). " +
        "Call this when the user states a durable preference, a project decision is made, or a lesson is learned. " +
        "Merges into an existing entry of the same type when the title matches.",
      parameters: {
        type: { type: "string", required: true, enum: ["preference", "project", "decision", "history"], description: "preference=user profile; project=project knowledge/state; decision=key decision; history=conversation summary" },
        title: { type: "string", required: true, description: "Short unique title" },
        content: { type: "string", required: true, description: "Memory body" },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
        importance: { type: "integer", description: "1-5; >= threshold auto-injects into future sessions" },
        source: { type: "string", description: "Optional provenance" }
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
        const { action, memory } = service.saveWithDedupe({
          type: args.type,
          title: args.title,
          content: args.content,
          tags: args.tags ?? [],
          importance: args.importance ?? 3,
          source: args.source ?? "tool",
          // Provenance: the session that issued the tool call. exec.agent is
          // set by the agent loop (undefined in unit tests / direct calls) —
          // absent a session, session_id stays null rather than fabricating one.
          session_id: exec?.agent?.session?.id ?? undefined
        });
        return { action, id: memory.id };
      }
    }),

    defineTool({
      name: "memory_search",
      description: "Search the cross-session memory store. Use when you need past context: how a problem was solved, user preferences, project decisions. Substring-matches title/content/tags, and augments results with semantic (vector) recall + optional rerank when an embeddings provider is configured. Returns matching entries with source and timestamps.",
      parameters: {
        query: { type: "string", required: true, description: "Search text; substring match over title/content/tags" },
        limit: { type: "integer", description: "Max results (default 20)" },
        mode: { type: "string", enum: ["auto", "keyword", "vector", "hybrid"], description: "auto (default) = keyword hits first + vector fill when enabled; keyword = text only; vector = semantic recall first (falls back to keyword); hybrid = vector leads, keyword fills remaining slots" },
        semantic: { type: "boolean", description: "Shorthand: enable semantic (vector) recall (same as mode=vector when true)" },
        rerank: { type: "boolean", description: "Run cross-encoder rerank over candidates when a local reranker is configured (default true)" }
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
        render: (_args, value) => TEXT_OUTPUT(`Found ${value.items.length} memory entr${value.items.length === 1 ? "y" : "ies"}.`)
      },
      async execute(args) {
        const limit = args.limit ?? 20;
        const mode = args.semantic === true && !args.mode ? "vector" : args.mode ?? "auto";
        const rows = await service.searchMemories(args.query, {
          mode,
          topK: limit,
          useRerank: args.rerank !== false
        });
        return { items: service.toApiList(rows) };
      }
    }),

    defineTool({
      name: "memory_list",
      description: "List memory entries by type, high-importance first, then newest, paginated. Set include_archived=true to also list archived (hidden) entries so they can be located and restored.",
      parameters: {
        type: { type: "string", enum: ["preference", "project", "decision", "history"], description: "Filter by type; omit for all" },
        limit: { type: "integer", description: "Page size (default 50)" },
        offset: { type: "integer", description: "Page offset (default 0)" },
        include_archived: { type: "boolean", description: "Include archived (hidden) entries so they can be found and restored (default false)" }
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
        render: (_args, value) => TEXT_OUTPUT(`${value.items.length} memory entries (of ${value.total}).`)
      },
      async execute(args) {
        const includeArchived = args.include_archived === true;
        const rows = service.toApiList(service.list({
          type: args.type,
          limit: args.limit ?? 50,
          offset: args.offset ?? 0,
          includeArchived
        }));
        return { items: rows, total: service.count(args.type, { includeArchived }) };
      }
    }),

    defineTool({
      name: "memory_update",
      description: "Modify an existing memory entry (title, content, type, tags, importance).",
      parameters: {
        id: { type: "string", required: true, description: "Memory id" },
        title: { type: "string" },
        content: { type: "string" },
        type: { type: "string", enum: ["preference", "project", "decision", "history"] },
        tags: { type: "array", items: { type: "string" } },
        importance: { type: "integer", description: "1-5" },
        reason: { type: "string", description: "Optional context for the correction (what the user actually said/wanted), recorded for reflection" }
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
          importance: args.importance
        }, { query: args.reason });
        return { memory: { id: memory.id, title: memory.title, content: memory.content } };
      }
    }),

    defineTool({
      name: "memory_delete",
      description: "Permanently delete a memory entry. Pass id for exact delete, or query to delete the single best-matching entry by text — lets the agent honor 'delete the memory about X' without a prior list/search round trip.",
      parameters: {
        id: { type: "string", description: "Exact memory id to delete (from memory_list/memory_search output)" },
        query: { type: "string", description: "Delete the best-matching entry for this text (searches title/content/tags; uses hybrid recall when an embedder is configured)" }
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
        if (args.id) {
          const existed = service.getById(args.id) !== undefined;
          if (existed) service.remove(args.id);
          return { deleted: existed };
        }
        if (args.query) {
          const [best] = await service.searchMemories(args.query, { mode: "auto", topK: 1, useRerank: true });
          if (best) {
            service.remove(best.id);
            return { deleted: true };
          }
        }
        return { deleted: false };
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
    })
  ];

  for (const tool of tools) {
    ctx.tools.register(tool);
  }

  return tools;
}
