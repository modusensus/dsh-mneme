// BM25 sparse retrieval (v0.5.0 召回率优化 1.1): the third recall path beside
// vector search and the LIKE keyword scan. The LIKE path only matches full
// substrings, so a multi-term query ("rust 异步 tokio") misses rows whose
// terms are scattered. BM25 scores per-token overlap with IDF weighting,
// which is exactly the gap: identifiers, code fragments and mixed CJK/ASCII
// queries recall rows the substring scan cannot see.

// Tokenizer: ASCII words keep their shape (identifiers like "dsh-mneme" or
// "ZFS_4421" survive as whole tokens); CJK runs become sliding bigrams
// (unigram only for single characters), the standard workaround for BM25's
// whitespace tokenization on Chinese.
export function tokenize(text) {
  const raw = String(text ?? "").toLowerCase();
  const tokens = [];
  const ascii = raw.match(/[a-z0-9_]+/g) ?? [];
  tokens.push(...ascii);
  const cjkRuns = raw.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) { tokens.push(run); continue; }
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

const K1 = 1.5; // term-frequency saturation
const B = 0.75;  // length normalization

/**
 * Build a BM25 index over documents: [{id, title, content}].
 * Returns { score, search }:
 *   score(query, doc) — per-spec ad-hoc scoring (re-tokenizes the doc)
 *   search(query, {limit}) — precomputed-tf ranking, scores normalized to
 *     [0,1] by the max so BM25 hits can weight-blend with vector/keyword
 *     scores on one scale. Rows the query does not touch at all are dropped.
 */
export function createBM25Index(documents) {
  const docs = Array.isArray(documents) ? documents.filter(Boolean) : [];
  const N = docs.length;
  const df = new Map();
  const prepared = docs.map((doc) => {
    const tokens = tokenize(`${doc.title ?? ""} ${doc.content ?? ""}`);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return { doc, tf, len: tokens.length };
  });
  const avgLen = N ? prepared.reduce((s, p) => s + p.len, 0) / N : 0 || 1;

  const idf = (t) => {
    const n = df.get(t) ?? 0;
    return Math.log((N - n + 0.5) / (n + 0.5) + 1);
  };

  function scorePrepared(queryTokens, p) {
    let score = 0;
    for (const t of queryTokens) {
      const f = p.tf.get(t);
      if (!f) continue;
      const norm = p.len ? K1 * (1 - B + B * (p.len / avgLen)) : K1;
      score += idf(t) * ((f * (K1 + 1)) / (f + norm));
    }
    return score;
  }

  return {
    score(query, doc) {
      const tokens = tokenize(`${doc?.title ?? ""} ${doc?.content ?? ""}`);
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      const len = tokens.length;
      // Ad-hoc scoring can't see corpus df; fall back to tf-only saturation
      // (df is approximated as 1 so idf ≈ log(N - 0.5 + 1) is constant).
      let score = 0;
      for (const t of tokenize(query)) {
        const f = tf.get(t);
        if (!f) continue;
        const norm = len ? K1 * (1 - B + B * (len / avgLen)) : K1;
        score += idf(t) * ((f * (K1 + 1)) / (f + norm));
      }
      return score;
    },
    search(query, { limit = 20 } = {}) {
      const qTokens = tokenize(query);
      if (!qTokens.length || !N) return [];
      const scored = [];
      for (const p of prepared) {
        const s = scorePrepared(qTokens, p);
        if (s > 0) scored.push({ row: p.doc, raw: s });
      }
      scored.sort((a, b) => b.raw - a.raw);
      const top = scored.slice(0, limit);
      const max = top[0]?.raw || 1;
      return top.map(({ row, raw }) => ({ ...row, score: max ? raw / max : 0 }));
    }
  };
}
