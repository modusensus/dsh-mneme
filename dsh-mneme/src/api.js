import { URL } from "node:url";
import { timingSafeEqual } from "node:crypto";

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/**
 * Mask an API key for client display: keep a recognizable prefix and suffix,
 * hide the middle. Empty keys stay empty; short keys are fully hidden.
 * The mask only exists in the API layer — storage keeps the real key.
 */
function maskApiKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "***";
  return `${key.slice(0, 3)}***${key.slice(-4)}`;
}

/** True when the request carries the configured apiToken (or no token is set). */
function isAuthorized(req, apiToken) {
  if (!apiToken) return true;
  const raw = req.headers?.authorization ?? req.headers?.["x-dsh-mneme-token"] ?? "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw.trim();
  if (token === "" || token.length !== apiToken.length) return false;
  // Constant-time comparison: avoid leaking the token via timing when the API
  // is exposed beyond loopback.
  return timingSafeEqual(Buffer.from(token), Buffer.from(apiToken));
}

/**
 * Reject a request with 401 when auth is enabled and the token is missing or
 * wrong. Returns true when the request may proceed.
 */
function requireAuth(req, res, apiToken) {
  if (isAuthorized(req, apiToken)) return true;
  sendJson(res, 401, { error: "unauthorized" });
  return false;
}

/** Collect the request body as text (tolerant of empty/invalid bodies). */
function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(""));
  });
}

function parseBody(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

export function createApi(ctx, service, settings, commands, embedder, semantic = null, apiToken = "") {
  const disposers = [];

  // Ensure the service has an embedder when the API layer was handed one
  // (tests wire the embedder through the API instead of index.js). Without
  // this, /api/dsh-mneme/search would silently degrade to keyword-only.
  if (embedder && typeof service.setEmbedder === "function") {
    service.setEmbedder(embedder);
  }

  const register = (route) => {
    disposers.push(ctx.webServer.register(route));
  };

  // /api/dsh-mneme prefix fallback → 404 JSON for unknown sub-paths
  register({
    kind: "prefix",
    path: "/api/dsh-mneme",
    handler(req, res) {
      sendJson(res, 404, { error: "not-found" });
    }
  });

  register({
    kind: "exact",
    path: "/api/dsh-mneme/list",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const type = url.searchParams.get("type") ?? undefined;
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const items = service.toApiList(service.list({ type, limit, offset }));
        sendJson(res, 200, { items, total: service.count(type) });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  register({
    kind: "exact",
    path: "/api/dsh-mneme/search",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const q = url.searchParams.get("q") ?? "";
        const limit = Number(url.searchParams.get("limit") ?? 20);
        // mode selects the recall strategy (defaults to auto):
        //   auto    (default) keyword first, vector fills remaining slots
        //   hybrid  vector first, keyword fills remaining slots; scores of
        //           memories hit by both sides are weight-blended
        //   vector  vector only, falls back to keyword when the vector path
        //           is unavailable (no embedder or a throwing one)
        //   keyword literal text only; never queries the embedder
        // rerank=false disables the cross-encoder reorder for this request;
        // the response `mode` field reports which path actually produced rows.
        const mode = url.searchParams.get("mode") ?? "auto";
        const rerank = url.searchParams.get("rerank") !== "false";
        const query = q.trim();
        if (!query) {
          sendJson(res, 200, { items: [], mode: "keyword" });
          return;
        }
        // Route through the unified semantic pipeline; any vector/rerank
        // failure degrades to keyword results inside searchMemories. The
        // returned promise lets the test double await the async search.
        return Promise.resolve(
          service.searchMemories(query, { mode, topK: limit, useRerank: rerank })
        ).then((rows) => {
          // mode reflects what actually happened: rows marked `vector` came
          // through the semantic path, everything else is keyword fallback.
          const used = rows.some((m) => m.vector === true) ? "vector" : "keyword";
          sendJson(res, 200, { items: service.toApiList(rows), mode: used });
        }).catch(() => {
          sendJson(res, 200, { items: service.toApiList(service.search(query, { limit })), mode: "keyword" });
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- user profile ---
  register({
    kind: "exact",
    path: "/api/dsh-mneme/profile",
    handler(req, res) {
      try {
        if (req.method === "PUT" || req.method === "POST") {
          if (!requireAuth(req, res, apiToken)) return;
          return readBody(req).then((text) => {
            const body = parseBody(text);
            settings.setProfile(typeof body.profile === "string" ? body.profile : "");
            sendJson(res, 200, { profile: settings.getProfile() });
          });
        }
        sendJson(res, 200, { profile: settings.getProfile() });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- rules ---
  register({
    kind: "exact",
    path: "/api/dsh-mneme/rules",
    handler(req, res) {
      try {
        if (req.method === "PUT" || req.method === "POST") {
          if (!requireAuth(req, res, apiToken)) return;
          return readBody(req).then((text) => {
            const body = parseBody(text);
            settings.setRules(Array.isArray(body.rules) ? body.rules : []);
            sendJson(res, 200, { rules: settings.getRules() });
          });
        }
        sendJson(res, 200, { rules: settings.getRules() });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- vector search config ---
  register({
    kind: "exact",
    path: "/api/dsh-mneme/vector-config",
    handler(req, res) {
      try {
        // Secret-bearing endpoint: fully protected when apiToken is set.
        if (!requireAuth(req, res, apiToken)) return;
        if (req.method === "PUT" || req.method === "POST") {
          return readBody(req).then((text) => {
            const body = parseBody(text);
            // An empty apiKey, or one that already looks masked (round-trips
            // through maskApiKey unchanged), means "keep the existing key".
            // Only a fresh, unmasked key is treated as a real replacement.
            const prev = settings.getVectorConfig();
            const incoming = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
            const isMaskedOrEmpty = incoming === "" || maskApiKey(incoming) === incoming;
            const key = isMaskedOrEmpty
              ? (prev?.apiKey ?? "")
              : incoming;
            const cfg = settings.setVectorConfig({
              enabled: body.enabled,
              baseUrl: body.baseUrl,
              apiKey: key,
              model: body.model
            });
            sendJson(res, 200, { config: { ...cfg, apiKey: maskApiKey(cfg.apiKey) } });
          });
        }
        const cfg = settings.getVectorConfig() ?? { enabled: false, baseUrl: "", apiKey: "", model: "" };
        sendJson(res, 200, { config: { ...cfg, apiKey: maskApiKey(cfg.apiKey) } });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- vector re-index (backfill embeddings for rows missing them) ---
  register({
    kind: "exact",
    path: "/api/dsh-mneme/vector-reindex",
    handler(req, res) {
      try {
        if (!requireAuth(req, res, apiToken)) return;
        if (!embedder) {
          sendJson(res, 200, { indexed: 0, skipped: 0, error: "vector-unavailable" });
          return;
        }
        const url = new URL(req.url, "http://localhost");
        const limit = Number(url.searchParams.get("limit") ?? 100);
        // Unified re-index entry: works for both the legacy OpenAI embedder and
        // the new local/ollama backends (which have no reindexMissing method).
        const viaIndex = semantic?.vectorIndex && semantic?.vectorIndex.rebuildIndex;
        const task = viaIndex
          ? semantic.vectorIndex.rebuildIndex(embedder, { limit })
          : embedder.reindexMissing ? embedder.reindexMissing(limit) : Promise.resolve({ indexed: 0, skipped: 0, error: "vector-unavailable" });
        task.then((result) => {
          sendJson(res, 200, result);
        }).catch(() => {
          sendJson(res, 200, { indexed: 0, skipped: 0, error: "vector-failed" });
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- semantic pipeline status (model, index, reranker) ---
  register({
    kind: "exact",
    path: "/api/dsh-mneme/semantic",
    handler(req, res) {
      try {
        const stats = semantic?.vectorIndex?.getStats?.() ?? null;
        sendJson(res, 200, {
          embedProvider: embedder ? (embedder.constructor?.name ?? "unknown") : null,
          modelHash: embedder?.modelHash ?? null,
          dimension: embedder?.dimension ?? null,
          reranker: semantic?.reranker ? "ready" : null,
          index: stats
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- health: mirror sync state (F-NEW-03) ---
  register({
    kind: "exact",
    path: "/api/dsh-mneme/health",
    handler(req, res) {
      try {
        const state = service.getMirrorHealth?.() ?? null;
        sendJson(res, 200, {
          mirror: state
            ? { dirty: state.dirty === true, last_error: state.last_error ?? null, last_attempt: state.last_attempt ?? null, success_at: state.success_at ?? null }
            : null
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- custom commands ---
  register({
    kind: "exact",
    path: "/api/dsh-mneme/commands",
    handler(req, res) {
      try {
        if (req.method === "POST") {
          if (!requireAuth(req, res, apiToken)) return;
          return readBody(req).then((text) => {
            const body = parseBody(text);
            try {
              const command = commands.add({
                name: body.name,
                description: body.description,
                instruction: body.instruction
              });
              sendJson(res, 200, { command });
            } catch (error) {
              sendJson(res, 400, { error: error.message });
            }
          });
        }
        if (req.method === "DELETE") {
          if (!requireAuth(req, res, apiToken)) return;
          const url = new URL(req.url, "http://localhost");
          const id = url.searchParams.get("id");
          const removed = id ? commands.remove(id) : false;
          sendJson(res, 200, { removed });
          return;
        }
        sendJson(res, 200, { commands: commands.list() });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  return {
    routes: 7,
    dispose: () => {
      for (const dispose of disposers) dispose();
    }
  };
}
