/**
 * Tag parser (v0.6.2). Given a memory's content, extract explicit hashtags of
 * the form `#标签`. The allowed character set is `[a-zA-Z0-9_一-龥-]+` (ASCII
 * letters/digits/underscore, CJK characters, and hyphen), so `#linux`,
 * `#deepseek` and `#考研` are all valid tags.
 *
 * Rules:
 *   - multiple tags on one line are all extracted, in source order;
 *   - duplicates collapse to the first occurrence;
 *   - tags longer than MAX_TAG_LENGTH (20) characters are dropped as illegal;
 *   - edge hyphens (leading/trailing, e.g. a sentence-terminating `#tag-`) are
 *     stripped; a tag that collapses to empty is dropped;
 *   - markdown `## heading` never matches (the second `#`/space is not in the
 *     allowed set).
 *
 * Pure module: no store, no side effects — persistence (store.setMemoryTags)
 * is a separate step. sanitizeTags shares the same validation so LLM-extracted
 * tag arrays (autoDream tag-extractor) are filtered identically.
 */

export const MAX_TAG_LENGTH = 20;

// `一` (U+4E00) .. `龥` (U+9FA5) is the CJK Unified Ideographs block (the
// rule's `一-龥`). Matching requires a tag character right after `#` so a bare
// `#` and markdown `## heading` are naturally excluded (#/space not in set).
const TAG_RE = /#[a-zA-Z0-9_一-龥-]+/g;
const EDGE_HYPHEN = /^-+|-+$/g;
const VALID_TAG = /^[a-zA-Z0-9_一-龥-]+$/;

/** Validate + dedupe an array of tag strings. Non-strings, blanks, over-long
 *  and illegal-character tags are dropped (fail-safe). A leading `#` is
 *  tolerated so raw LLM output can be passed through directly. */
export function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    if (typeof t !== "string") continue;
    let tag = t.trim();
    if (tag.startsWith("#")) tag = tag.slice(1);
    tag = tag.replace(EDGE_HYPHEN, "");
    if (!tag || tag.length > MAX_TAG_LENGTH) continue;
    if (!VALID_TAG.test(tag)) continue;
    if (seen.has(tag)) continue; // 去重（保留首次出现顺序）
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/** @returns {string[]} validated tags in source order, deduplicated. */
export function parseTags(content) {
  if (typeof content !== "string" || content.length === 0) return [];
  const raw = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(content)) !== null) raw.push(m[0]);
  return sanitizeTags(raw);
}
