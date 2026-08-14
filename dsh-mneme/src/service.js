const INJECT_TYPES = new Set(["preference", "project", "decision", "summary"]);

export function createService({ store, mirror, config, onWrite }) {
  // Optional dream scheduler hook, installed via setDreamHook after creation
  // (the scheduler holds a reference back to the service, so it cannot be
  // passed in the constructor). Fired on the same write events as onWrite.
  let dreamHook = null;

  // Optional vector embedder, installed via setEmbedder after creation. After
  // any content write it fire-and-forgets a re-embed of the row so vector
  // search stays in sync; failures are swallowed inside the embedder.
  let embedder = null;

  function scheduleEmbed(memory) {
    if (embedder && memory?.id) {
      try { embedder.schedule(memory); } catch { /* ignore */ }
    }
  }

  /**
   * Fire-and-forget write notification; errors are swallowed to keep write
   * paths clean. The store mutation has already committed, so a throwing
   * subscriber must not surface as a write failure. Archive/forget flags are
   * state toggles, not content writes, so they never notify.
   */
  function notifyWrite() {
    if (onWrite) {
      try { onWrite(); } catch { /* ignore */ }
    }
    if (dreamHook) {
      try { dreamHook(); } catch { /* ignore */ }
    }
  }

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
      syncMirror();
      notifyWrite();
      scheduleEmbed(merged);
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
    syncMirror();
    notifyWrite();
    scheduleEmbed(created);
    return { action: "created", memory: created };
  }

  /**
   * Candidate memories for automatic context injection:
   * summaries first, then all preferences, then non-forgotten items with
   * importance >= threshold. History is never auto-injected. Archived entries
   * are excluded (store.list already filters them by default; the extra
   * !m.archived check is kept as double insurance).
   */
  function injectCandidates({ maxItems = 5, threshold = 3 } = {}) {
    const items = store.list({ limit: 200, includeForgotten: false })
      .filter((m) => !m.archived && INJECT_TYPES.has(m.type) && !m.forgotten &&
        (m.type === "summary" || m.type === "preference" || m.importance >= threshold))
      .sort((a, b) => {
        const pa = a.type === "summary" ? 0 : a.type === "preference" ? 1 : 2;
        const pb = b.type === "summary" ? 0 : b.type === "preference" ? 1 : 2;
        return pa - pb || b.importance - a.importance;
      });
    return items.slice(0, maxItems);
  }

  /**
   * Merge human edits parsed from a mirror file back into the store.
   * Only content/title are taken; structure fields stay machine-owned.
   */
  function mergeHumanEdits(type, edits) {
    let applied = 0;
    for (const edit of edits) {
      if (!edit.id) continue; // corrupt/malformed edit: skip it, keep merging the rest
      const existing = store.getById(edit.id);
      if (!existing || existing.type !== type) continue;
      const patch = {};
      if (typeof edit.title === "string" && edit.title.trim()) patch.title = edit.title.trim();
      if (typeof edit.content === "string" && edit.content.trim()) patch.content = edit.content.trim();
      if (Object.keys(patch).length) {
        store.update(edit.id, patch);
        applied++;
      }
    }
    if (applied) {
      syncMirror();
      notifyWrite();
    }
    return applied;
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

  /**
   * Re-render the human-editable mirror after any store mutation. Only
   * non-forgotten memories are mirrored: forgotten entries must not reach the
   * human-editable file (a human "edit" could otherwise resurrect them).
   */
  function syncMirror() {
    if (mirror) mirror.sync(store.list({ limit: 500, includeForgotten: false }));
  }

  return {
    saveWithDedupe,
    injectCandidates,
    mergeHumanEdits,
    toApiList,
    setDreamHook(fn) { dreamHook = fn; },
    setEmbedder(emb) { embedder = emb; },
    // passthroughs used by tools and api layers; mutations keep the mirror in sync
    search: (q, o) => store.search(q, o),
    searchVector: (v, o) => store.searchVector(v, o),
    embeddedCount: () => store.embeddedCount(),
    list: (o) => store.list(o),
    all: () => store.all(),
    count: (type) => store.count(type),
    getById: (id) => store.getById(id),
    remove: (id) => {
      store.remove(id);
      syncMirror();
      notifyWrite();
    },
    update: (id, p) => {
      const updated = store.update(id, p);
      syncMirror();
      notifyWrite();
      scheduleEmbed(updated);
      return updated;
    },
    setForget: (id, f) => {
      const updated = store.setForget(id, f);
      syncMirror();
      return updated;
    },
    setArchived: (id, f) => {
      const updated = store.setArchived(id, f);
      syncMirror();
      return updated;
    }
  };
}
