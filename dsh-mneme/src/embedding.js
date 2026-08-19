// OpenAI-compatible embedding client for vector search. DSH's LLM service is
// chat-only, so dsh-mneme calls an external `/embeddings` endpoint itself.
// Works with OpenAI, SiliconFlow, Zhipu, local Ollama (via OpenAI-compatible
// proxy) and any provider exposing the standard embeddings API.
const DEFAULT_TIMEOUT_MS = 15000;

/** djb2 — stable, fast fingerprint for a provider/model string. Mirrors the
 *  hash used by the local embedders so all backends share one fingerprint
 *  format (model#hex) for vector_meta consistency checks. */
function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** Full provider+model fingerprint used for index-consistency checks. */
function modelHashOf(model) {
  return `${model}#${hashString(model)}`;
}

/** Normalize a configured baseUrl into the full embeddings endpoint URL. */
function embeddingsUrl(baseUrl) {
  const base = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) return "";
  // Accept both "https://host/v1" and a full path ending in /embeddings.
  if (/\/embeddings$/i.test(base)) return base;
  return `${base}/embeddings`;
}

/**
 * Call the embeddings API for one text. Resolves to a Float64 array, or null
 * when the provider is not configured, the call fails, or the response is
 * unusable. Never throws: failures degrade to keyword search.
 */
export async function embedText({ baseUrl, apiKey, model }, text) {
  const url = embeddingsUrl(baseUrl);
  if (!url || !apiKey || !model || !text) return null;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, input: String(text).slice(0, 8000) }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const vec = body?.data?.[0]?.embedding;
  return Array.isArray(vec) && vec.length ? Array.from(vec) : null;
}

/**
 * Embedder bound to the current settings + store: on each write it re-embeds
 * the row's title+content and stores the vector. Failures are swallowed so a
 * flaky embedding endpoint never breaks memory writes.
 *
 * `vectorIndex` (optional) is the vector_meta fingerprint holder: after any
 * successful embed the model that produced the vectors is recorded, so the
 * index can detect drift and the auto-reindex backfill knows what to rebuild.
 */
export function createEmbedder({ store, settings, logger, vectorIndex }) {
  // Dimension of the most recent successful embed, exposed for fingerprinting.
  let _dimension = 0;

  /** Record the producing model fingerprint in vector_meta (best-effort). */
  function markModel(cfg, dimension) {
    if (!vectorIndex || typeof vectorIndex.markModel !== "function") return;
    try {
      vectorIndex.markModel(modelHashOf(cfg.model), dimension);
    } catch { /* metadata write is best-effort */ }
  }

  async function embedFor(id, title, content) {
    const cfg = settings.getVectorConfig();
    if (!cfg?.enabled || !cfg.baseUrl || !cfg.apiKey || !cfg.model) return;
    const text = [title, content].filter(Boolean).join("\n");
    const vector = await embedText(cfg, text);
    if (vector) {
      store.setEmbedding(id, vector);
      _dimension = vector.length;
      // Bug3: record which model produced the current vectors so the index can
      // detect drift and skip a redundant backfill when nothing changed.
      markModel(cfg, vector.length);
      logger?.info?.(`[dsh-mneme] embedded memory ${id} (dim=${vector.length})`);
    }
  }

  return {
    /** Fire-and-forget re-embed of a memory after any write. */
    schedule(memory) {
      if (!memory?.id) return;
      embedFor(memory.id, memory.title, memory.content).catch(() => {});
    },

    /** Embed one text and return its vector (null on failure/disabled). */
    async embed(query) {
      const cfg = settings.getVectorConfig();
      if (!cfg?.enabled || !cfg.baseUrl || !cfg.apiKey || !cfg.model) return null;
      const vector = await embedText(cfg, query);
      if (vector) _dimension = vector.length;
      return vector;
    },

    // Bug1: single-text adapter. Local/ollama embedders expose embedSingle
    // natively; the legacy OpenAI-compatible client only has embed. This
    // adapter unifies the interface so vector-index rebuildIndex (which guards
    // on `typeof embedder.embedSingle === "function"`) accepts this embedder.
    async embedSingle(text) {
      if (typeof this.embed === "function") return this.embed(text);
      return null;
    },

    /** Model fingerprint (model#hex), or undefined when not configured. */
    get modelHash() {
      const cfg = settings.getVectorConfig();
      return cfg?.enabled && cfg.model ? modelHashOf(cfg.model) : undefined;
    },

    /** Dimension of the last successful embed (0 when never embedded). */
    get dimension() {
      return _dimension || undefined;
    },

    /** Batch re-index rows still missing an embedding. */
    async reindexMissing(limit = 50) {
      const cfg = settings.getVectorConfig();
      if (!cfg?.enabled) return { indexed: 0, skipped: 0 };
      const rows = store.needsEmbedding(limit);
      let indexed = 0;
      for (const row of rows) {
        const text = [row.title, row.content].filter(Boolean).join("\n");
        const vector = await embedText(cfg, text);
        if (vector) {
          store.setEmbedding(row.id, vector);
          _dimension = vector.length;
          indexed++;
        }
      }
      if (indexed > 0) markModel(cfg, _dimension || undefined);
      return { indexed, skipped: rows.length - indexed };
    }
  };
}
