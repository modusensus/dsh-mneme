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
    }
  }
  // Every snapshot id must appear in at least one decision
  for (const id of snapshot.keys()) {
    if (!claimed.has(id)) errors.push(`memory ${JSON.stringify(id)} missing from decisions`);
  }
  return { ok: errors.length === 0, errors };
}
