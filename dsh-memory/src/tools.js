const TEXT_OUTPUT = (text) => [{ type: "text", text }];

function define({ name, description, parameters, outputSchema, render, execute }) {
  return {
    name,
    description,
    parameters,
    output: { schema: outputSchema, render },
    execute
  };
}

export function createTools(ctx, service, config) {
  const tools = [
    define({
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
        importance: { type: "integer", minimum: 1, maximum: 5, description: "1-5; >= threshold auto-injects into future sessions" },
        source: { type: "string", description: "Optional provenance" }
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", required: true, enum: ["created", "merged"] },
          id: { type: "string", required: true }
        }
      },
      render: (_args, value) => TEXT_OUTPUT(`memory ${value.action}: ${value.id}`),
      async execute(args) {
        const { action, memory } = service.saveWithDedupe({
          type: args.type,
          title: args.title,
          content: args.content,
          tags: args.tags ?? [],
          importance: args.importance ?? 3,
          source: args.source ?? "tool"
        });
        return { action, id: memory.id };
      }
    }),

    define({
      name: "memory_search",
      description: "Full-text search the cross-session memory store. Use when you need past context: how a problem was solved, user preferences, project decisions. Returns matching entries with source and timestamps.",
      parameters: {
        query: { type: "string", required: true, description: "Search text; substring match over title/content/tags" },
        limit: { type: "integer", description: "Max results (default 20)" }
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          items: {
            type: "array", required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                type: { type: "string", required: true },
                title: { type: "string", required: true },
                content: { type: "string", required: true },
                importance: { type: "integer", required: true },
                updated_at: { type: "string", required: true },
                source: { type: "string" }
              }
            }
          }
        }
      },
      render: (_args, value) => TEXT_OUTPUT(`Found ${value.items.length} memory entr${value.items.length === 1 ? "y" : "ies"}.`),
      async execute(args) {
        const rows = service.toApiList(service.search(args.query, { limit: args.limit ?? 20 }));
        return { items: rows };
      }
    }),

    define({
      name: "memory_list",
      description: "List memory entries by type, newest/high-importance first, paginated.",
      parameters: {
        type: { type: "string", enum: ["preference", "project", "decision", "history"], description: "Filter by type; omit for all" },
        limit: { type: "integer", description: "Page size (default 50)" },
        offset: { type: "integer", description: "Page offset (default 0)" }
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          items: {
            type: "array", required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                type: { type: "string", required: true },
                title: { type: "string", required: true },
                content: { type: "string", required: true },
                importance: { type: "integer", required: true },
                updated_at: { type: "string", required: true }
              }
            }
          },
          total: { type: "integer", required: true }
        }
      },
      render: (_args, value) => TEXT_OUTPUT(`${value.items.length} memory entries (of ${value.total}).`),
      async execute(args) {
        const rows = service.toApiList(service.list({ type: args.type, limit: args.limit ?? 50, offset: args.offset ?? 0 }));
        return { items: rows, total: service.count() };
      }
    }),

    define({
      name: "memory_update",
      description: "Modify an existing memory entry (title, content, type, tags, importance).",
      parameters: {
        id: { type: "string", required: true, description: "Memory id" },
        title: { type: "string" },
        content: { type: "string" },
        type: { type: "string", enum: ["preference", "project", "decision", "history"] },
        tags: { type: "array", items: { type: "string" } },
        importance: { type: "integer", minimum: 1, maximum: 5 }
      },
      outputSchema: {
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
      render: (_args, value) => TEXT_OUTPUT(`Updated memory ${value.memory.id}: ${value.memory.title}`),
      async execute(args) {
        const memory = service.update(args.id, {
          title: args.title,
          content: args.content,
          type: args.type,
          tags: args.tags,
          importance: args.importance
        });
        return { memory: { id: memory.id, title: memory.title, content: memory.content } };
      }
    }),

    define({
      name: "memory_delete",
      description: "Permanently delete a memory entry.",
      parameters: {
        id: { type: "string", required: true }
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { deleted: { type: "boolean", required: true } }
      },
      render: (_args, value) => TEXT_OUTPUT(value.deleted ? "Memory deleted." : "Memory not found."),
      async execute(args) {
        const existed = service.getById(args.id) !== undefined;
        if (existed) service.remove(args.id);
        return { deleted: existed };
      }
    }),

    define({
      name: "memory_forget",
      description: "Stop a memory from being auto-injected into future sessions without deleting it. Use for outdated or irrelevant memories you still want searchable.",
      parameters: {
        id: { type: "string", required: true }
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          memory: {
            type: "object",
            additionalProperties: false,
            properties: { id: { type: "string", required: true }, forgotten: { type: "boolean", required: true } }
          }
        }
      },
      render: (_args, value) => TEXT_OUTPUT(`Memory ${value.memory.id} injection ${value.memory.forgotten ? "suppressed" : "restored"}.`),
      async execute(args) {
        const memory = service.setForget(args.id, true);
        return { memory: { id: memory.id, forgotten: memory.forgotten } };
      }
    })
  ];

  for (const tool of tools) {
    ctx.tools.register(tool);
  }

  return tools;
}
