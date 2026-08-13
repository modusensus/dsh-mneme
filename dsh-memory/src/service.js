const INJECT_TYPES = new Set(["preference", "project", "decision"]);

export function createService({ store, mirror, config }) {
  /**
   * Save a memory, merging into an existing one when title matches within the same type.
   * @returns {{action: "created"|"merged", memory: object}}
   */
  function saveWithDedupe(memory) {
    const existing = store
      .list({ type: memory.type, limit: 100 })
      .find((m) => m.title.trim() === String(memory.title).trim());
    if (existing) {
      const merged = store.update(existing.id, {
        content: memory.content ?? existing.content,
        importance: memory.importance ?? existing.importance,
        tags: memory.tags ?? existing.tags,
        title: memory.title ?? existing.title
      });
      if (mirror) mirror.sync(store.all());
      return { action: "merged", memory: merged };
    }
    const created = store.save({
      type: memory.type,
      title: memory.title,
      content: memory.content,
      tags: memory.tags ?? [],
      importance: memory.importance ?? 3,
      source: memory.source ?? "manual"
    });
    if (mirror) mirror.sync(store.all());
    return { action: "created", memory: created };
  }

  /**
   * Candidate memories for automatic context injection:
   * all preferences + non-forgotten items with importance >= threshold.
   * History is never auto-injected.
   */
  function injectCandidates({ maxItems = 5, threshold = 3 } = {}) {
    const items = store.list({ limit: 200, includeForgotten: false })
      .filter((m) => INJECT_TYPES.has(m.type) && !m.forgotten && (m.type === "preference" || m.importance >= threshold))
      .sort((a, b) => (a.type === "preference" ? -1 : 1) || b.importance - a.importance);
    return items.slice(0, maxItems);
  }

  /**
   * Merge human edits parsed from a mirror file back into the store.
   * Only content/title are taken; structure fields stay machine-owned.
   */
  function mergeHumanEdits(type, edits) {
    for (const edit of edits) {
      const existing = store.getById(edit.id);
      if (!existing || existing.type !== type) continue;
      const patch = {};
      if (typeof edit.title === "string" && edit.title.trim()) patch.title = edit.title.trim();
      if (typeof edit.content === "string" && edit.content.trim()) patch.content = edit.content.trim();
      if (Object.keys(patch).length) store.update(edit.id, patch);
    }
    if (mirror && edits.length) mirror.sync(store.all());
    return edits.length;
  }

  function toApiList(rows) {
    return rows.map((m) => ({
      id: m.id,
      type: m.type,
      title: m.title,
      content: m.content,
      tags: m.tags,
      importance: m.importance,
      source: m.source,
      created_at: m.created_at,
      updated_at: m.updated_at
    }));
  }

  return {
    saveWithDedupe,
    injectCandidates,
    mergeHumanEdits,
    toApiList,
    // passthroughs used by tools and api layers
    search: (q, o) => store.search(q, o),
    list: (o) => store.list(o),
    all: () => store.all(),
    count: () => store.count(),
    getById: (id) => store.getById(id),
    remove: (id) => store.remove(id),
    update: (id, p) => store.update(id, p),
    setForget: (id, f) => store.setForget(id, f)
  };
}
