/**
 * Wiki-Link parser (v0.6.1). Given a memory's content, extract explicit
 * cross-memory links of the form [[target]] or [[显示|target]]:
 *   [[target]]      → { display: "target", target: "target" }
 *   [[显示|target]] → { display: "显示",  target: "target" }
 *
 * Unclosed / empty-target / multi-pipe / bracket-nested markers are treated as
 * illegal and ignored. Pure module: no store, no side effects — resolution is a
 * separate step (resolveWikiLink) that needs a store handle.
 */

/** @returns {{display: string, target: string}[]} in source order. */
export function parseWikiLinks(content) {
  if (typeof content !== "string" || content.length === 0) return [];
  const links = [];
  // [^\[\]]* keeps a single match from crossing `]]`; an unclosed `[[` never
  // matches, and `[[a [[b]] c]]` only yields the inner `[[b]]`.
  const re = /\[\[([^\[\]]*)\]\]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const inner = m[1];
    const parts = inner.split("|");
    if (parts.length > 2) continue; // 多管道 → 非法，忽略
    const rawTarget = (parts.length === 2 ? parts[1] : parts[0]).trim();
    if (!rawTarget) continue; // 空目标 → 非法，忽略
    const rawDisplay = parts[0].trim();
    links.push({ display: rawDisplay || rawTarget, target: rawTarget });
  }
  return links;
}

/** Resolve a wiki-link target title to a memory row via a case-insensitive
 *  exact title match (store.findByTitle). Returns undefined when absent or the
 *  store exposes no such lookup. */
export function resolveWikiLink(store, title) {
  if (!store || typeof title !== "string" || !title.trim()) return undefined;
  return store.findByTitle?.(title.trim());
}
