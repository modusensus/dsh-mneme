// Adaptive vector threshold (v0.5.0 召回率优化 1.2): replaces the fixed
// vectorSearchThreshold=0.65 with a query-aware cutoff.
//   entity:/attr: prefixes → 0.5  (entity recall is name-driven; loosen)
//   very short queries      → 0.7  (<5 chars match almost anything; tighten)
//   very long queries       → 0.6  (semantically specific; loosen a little)
//   head-gap rule           → when the top-1 vs top-5 candidate gap exceeds
//                             0.3 the head is decisive — loosen to 0.5 so
//                             the tail still reaches the reranker
//   otherwise               → 0.65 (the legacy default)
// Pure and total: same inputs, same cutoff, no store access.
export function adaptiveThreshold(query, candidates = []) {
  const q = String(query ?? "");
  if (q.startsWith("entity:") || q.startsWith("attr:")) return 0.5;
  if (q.length > 0 && q.length < 5) return 0.7;
  if (q.length > 50) return 0.6;
  const scores = (Array.isArray(candidates) ? candidates : [])
    .map((c) => (typeof c?._score === "number" ? c._score : typeof c?.score === "number" ? c.score : 0))
    .filter((s) => s > 0)
    .sort((a, b) => b - a);
  if (scores.length >= 5 && scores[0] - scores[4] > 0.3) return 0.5;
  return 0.65;
}
