const ACTIONS = new Set(["keep", "merge", "archive", "conflict"]);

/**
 * Validate a dream decision list against a snapshot of eligible memories.
 * @param decisions - LLM-produced decision list.
 * @param snapshot - Map<id, memory> of eligible (non-archived, non-summary) entries.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateDecisions(decisions, snapshot) {
  const errors = [];
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return { ok: false, errors: ["decision list must be a non-empty array"] };
  }
  const claimed = new Set();
  for (const [index, d] of decisions.entries()) {
    const at = `decision[${index}]`;
    if (!d || typeof d !== "object" || !ACTIONS.has(d.action)) {
      errors.push(`${at}: invalid action ${JSON.stringify(d?.action)}`);
      continue;
    }
    const ids = d.action === "conflict" ? [d.winner, d.loser] : (d.ids ?? []);
    if (d.action === "conflict") {
      if (!d.winner || !d.loser || d.winner === d.loser) {
        errors.push(`${at}: conflict needs distinct winner and loser`);
        continue;
      }
    } else if (!Array.isArray(d.ids) || d.ids.length === 0) {
      errors.push(`${at}: ${d.action} needs non-empty ids`);
      continue;
    }
    for (const id of ids) {
      const mem = snapshot.get(id);
      if (!mem) {
        errors.push(`${at}: unknown id ${JSON.stringify(id)}`);
      } else if (mem.archived || mem.type === "summary") {
        errors.push(`${at}: id ${JSON.stringify(id)} is archived or summary (not eligible)`);
      }
      if (claimed.has(id)) {
        errors.push(`${at}: id ${JSON.stringify(id)} claimed by multiple decisions`);
      }
      claimed.add(id);
    }
    if (d.action === "merge") {
      if (!d.keepSource || !d.ids.includes(d.keepSource)) {
        errors.push(`${at}: merge keepSource must be one of ids`);
      }
      if (typeof d.title !== "string" || !d.title.trim() || typeof d.content !== "string" || !d.content.trim()) {
        errors.push(`${at}: merge needs non-empty title and content`);
      }
      if (d.importance !== undefined && (!Number.isInteger(d.importance) || d.importance < 1 || d.importance > 5)) {
        errors.push(`${at}: merge importance must be an integer 1-5 when provided`);
      }
      // Merging across types would blur preference/project/decision boundaries
      // in the injected context; the snapshot carries each entry's type.
      const mergeTypes = new Set(d.ids.map((id) => snapshot.get(id)?.type));
      if (mergeTypes.size > 1) {
        errors.push(`${at}: merge ids span multiple types (${[...mergeTypes].join(", ")})`);
      }
    }
  }
  // Every snapshot id must appear in at least one decision
  for (const id of snapshot.keys()) {
    if (!claimed.has(id)) errors.push(`memory ${JSON.stringify(id)} missing from decisions`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Apply a validated decision list to the service. Caller must validate first.
 *
 * Note: merge is intentionally non-atomic — the keeper is updated before the
 * other sources are archived, so a failure between the two never loses content.
 *
 * @param decisions - validated decision list.
 * @param service - memory service (saveWithDedupe/getById/update/setArchived).
 * @param logger - optional logger ({ warn }); per-decision failures are logged.
 * @returns number of applied decisions (archive counts each archived memory as one).
 */
export function applyDecisions(decisions, service, logger = null) {
  let applied = 0;
  for (const [i, d] of decisions.entries()) {
    try {
      if (d.action === "keep") continue;
      if (d.action === "archive") {
        for (const id of d.ids) {
          const mem = service.getById(id);
          if (mem && !mem.archived) { service.setArchived(id, true); applied++; }
        }
      } else if (d.action === "merge") {
        const keeper = service.getById(d.keepSource);
        if (!keeper || keeper.archived) continue;
        service.update(d.keepSource, {
          title: d.title,
          content: d.content,
          importance: d.importance ?? Math.max(keeper.importance, ...d.ids.map((id) => service.getById(id)?.importance ?? 1))
        });
        for (const id of d.ids) {
          if (id !== d.keepSource) {
            const mem = service.getById(id);
            if (mem && !mem.archived) { service.setArchived(id, true); }
          }
        }
        applied++;
      } else if (d.action === "conflict") {
        const winner = service.getById(d.winner);
        const loser = service.getById(d.loser);
        if (!winner || !loser) continue;
        service.update(d.winner, {
          content: `${winner.content}\n\n（已否决旧信息：${[...loser.content].slice(0, 100).join("")}）`
        });
        service.setArchived(d.loser, true);
        applied++;
      }
    } catch (error) {
      // Skip individual bad decision; never corrupt the store. The optional
      // logger makes the failure visible instead of failing silently.
      logger?.warn?.(`dsh-mneme dream: failed to apply ${d.action} at index ${i}: ${error.message}`);
    }
  }
  return applied;
}
