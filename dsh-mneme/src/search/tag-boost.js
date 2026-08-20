// v0.6.4 Tag-weighted re-rank helpers.
// Query tags come from `#hashtags` in the query plus any known tags the query
// mentions; candidates whose tags overlap the query tags or the session's
// hot-memory tags get their score boosted before the final top-K cut.

/**
 * Extract tags from a query: explicit `#hashtags` (CJK allowed) plus known
 * tags whose lowercase form appears in the query. Deduped, order-preserving.
 */
export function extractQueryTags(query, knownTags = []) {
  if (typeof query !== "string" || !query) return [];
  const set = new Set();
  const re = /#([a-zA-Z0-9_一-龥-]+)/g;
  let m;
  while ((m = re.exec(query)) !== null) set.add(m[1]);
  const q = query.toLowerCase();
  for (const t of knownTags) {
    if (typeof t === "string" && q.includes(t.toLowerCase())) set.add(t);
  }
  return Array.from(set);
}

function hasOverlap(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const setB = new Set(b);
  return a.some((x) => setB.has(x));
}

/**
 * Boost candidate scores by tag overlap with the query and/or session tags.
 * Each candidate is expected to carry a `tags` array (enriched by the caller).
 * Returns a new array sorted by boosted score descending; candidates that were
 * boosted are marked `tagBoost: true`. Unchanged candidates keep their
 * relative order (stable).
 */
export function applyTagBoost(
  candidates,
  { queryTags = [], sessionTags = [], factor = 1.15, sessionFactor = 1.08 }
) {
  const boosted = candidates.map((c) => {
    const tags = c.tags ?? [];
    let score = typeof c.score === "number" ? c.score : 0;
    let didBoost = false;

    if (queryTags.length && hasOverlap(tags, queryTags)) {
      score = Math.min(1, score * factor);
      didBoost = true;
    }
    if (sessionTags.length && hasOverlap(tags, sessionTags)) {
      score = Math.min(1, score * sessionFactor);
      didBoost = true;
    }

    const out = { ...c, score };
    if (didBoost) out.tagBoost = true;
    return out;
  });

  boosted.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return boosted;
}
