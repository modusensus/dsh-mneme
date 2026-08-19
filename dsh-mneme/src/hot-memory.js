// Session-scoped hot memory (v0.5.0 召回率优化 1.3): a short-term buffer of
// the latest dialogue rounds, kept strictly apart from the long-term memory
// store. The injector renders it ahead of the long-term recall block so the
// agent sees "what we were just talking about" without those rounds ever
// being persisted as memories. Bounded two ways: maxRounds (count) and
// maxTokens (budget) — whichever evicts first.

// CJK-aware token estimate: one Chinese character ≈ 0.6 tokens (clustering
// behavior of mainstream tokenizers), one ASCII char ≈ 0.25.
export function estimateTokens(text) {
  const s = String(text ?? "");
  let cjk = 0;
  for (const ch of s) if (ch >= "\u4e00" && ch <= "\u9fff") cjk++;
  return Math.ceil(cjk * 0.6 + (s.length - cjk) * 0.25);
}

/**
 * @param {{maxRounds?: number, maxTokens?: number}} opts
 * @returns {{add(round: {query: string, response?: string}): void,
 *            getContext(): string,
 *            rounds(): Array, clear(): void}}
 */
export function createHotMemory({ maxRounds = 5, maxTokens = 2000 } = {}) {
  // Entry defense: a non-positive or non-integer maxRounds (0, -1, 1.5, NaN,
  // null, "2") would make the eviction while-loop unbounded — the buffer can
  // never shrink below `buffer.length > maxRounds`, so `add` would spin forever.
  // Fall back to the defaults so a hostile/buggy caller can never wedge the
  // hot-memory buffer in an infinite loop.
  maxRounds = (Number.isInteger(maxRounds) && maxRounds > 0) ? maxRounds : 5;
  maxTokens = (Number.isFinite(maxTokens) && maxTokens > 0) ? maxTokens : 2000;
  const buffer = [];

  function totalTokens() {
    return buffer.reduce(
      (sum, r) => sum + estimateTokens(`Q: ${r.query}\nA: ${r.response ?? ""}`),
      0
    );
  }

  return {
    add(round) {
      if (!round?.query) return;
      buffer.push({ query: String(round.query), response: String(round.response ?? "") });
      while (buffer.length > maxRounds) buffer.shift();
      while (buffer.length > 1 && totalTokens() > maxTokens) buffer.shift();
    },
    getContext() {
      return buffer.map((r) => `Q: ${r.query}\nA: ${r.response ?? ""}`).join("\n\n");
    },
    rounds: () => [...buffer],
    clear() { buffer.length = 0; }
  };
}
