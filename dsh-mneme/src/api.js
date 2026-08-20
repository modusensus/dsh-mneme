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
        const limit = Number(url.searchParams.get("topK") ?? url.searchParams.get("limit") ?? 20);
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
        // Return the chain so awaiting callers (tests/health checks) observe the
        // finished response rather than racing the async backfill.
        return task.then((result) => {
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

  // --- LLM audit trail (Bug8): paginated read + aggregate stats ---
  // Read-only endpoints, so like list/search/semantic they stay open even when
  // apiToken is set. The stats aggregate budget by source over the last N days.
  register({
    kind: "exact",
    path: "/api/dsh-mneme/semantic/llm-audit",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
        const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get("pageSize") ?? 50) || 50));
        const source = url.searchParams.get("source") ?? undefined;
        const items = service.listLlmAudits?.({ limit: pageSize, offset: (page - 1) * pageSize, source }) ?? [];
        const total = service.countLlmAudits?.({ source }) ?? items.length;
        sendJson(res, 200, { items, total, page, pageSize });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  register({
    kind: "exact",
    path: "/api/dsh-mneme/semantic/llm-audit/stats",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days") ?? 7) || 7));
        const stats = service.getLlmAuditStats?.({ days }) ?? null;
        sendJson(res, 200, stats ?? { error: "unavailable" });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- ego graph: 1-2 hop neighborhood of one entity (graph panel P1) ---
  // Read-only like list/search/semantic, so it stays open when apiToken is set.
  // BFS from the root entity over entity_relations (both directions; the
  // idx_relations_from/to indexes keep a 2-hop walk in the tens of ms even
  // for a few thousand nodes). `distance` on each node is the hop count from
  // the root so the UI can shade the frontier. The API is graph-traversal
  // only — nodes carry no attr payload; hover summaries come from
  // /semantic/graph/entity-attrs.
  register({
    kind: "exact",
    path: "/api/dsh-mneme/semantic/graph/ego",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const name = (url.searchParams.get("entity") ?? "").trim();
        if (!name) {
          sendJson(res, 400, { error: "missing-entity" });
          return;
        }
        const root = service.findEntityByName?.(name);
        if (!root) {
          sendJson(res, 404, { error: "entity-not-found" });
          return;
        }
        const depth = Math.max(1, Math.min(2, Number(url.searchParams.get("depth") ?? 1) || 1));
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 40) || 40));

        const nodes = new Map([[root.id, { ...root, distance: 0 }]]);
        let frontier = [root.id];
        for (let d = 1; d <= depth && nodes.size < limit; d++) {
          const next = [];
          for (const id of frontier) {
            for (const rel of service.getRelations?.(id) ?? []) {
              const other = rel.from_entity === id ? rel.to_entity : rel.from_entity;
              if (nodes.has(other) || nodes.size >= limit) continue;
              const entity = service.findEntityById?.(other);
              if (!entity) continue;
              nodes.set(other, { ...entity, distance: d });
              next.push(other);
            }
          }
          frontier = next;
        }

        // Collect every relation whose endpoints both survived the limit cut;
        // each edge is visited twice (once per endpoint) so dedupe by id.
        const edgeMap = new Map();
        for (const id of nodes.keys()) {
          for (const rel of service.getRelations?.(id) ?? []) {
            if (nodes.has(rel.from_entity) && nodes.has(rel.to_entity)) {
              edgeMap.set(rel.id, rel);
            }
          }
        }

        sendJson(res, 200, {
          root: { id: root.id, name: root.name, type: root.type ?? null, mention_count: root.mention_count ?? 1 },
          nodes: [...nodes.values()].map((n) => ({
            id: n.id,
            name: n.name,
            type: n.type ?? null,
            mention_count: n.mention_count ?? 1,
            distance: n.distance
          })),
          edges: [...edgeMap.values()].map((e) => ({
            id: e.id,
            from: e.from_entity,
            to: e.to_entity,
            relation_type: e.relation_type,
            memory_id: e.memory_id ?? null,
            created_at: e.created_at
          }))
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- entity attrs: current valid attrs for one entity (graph hover panel) ---
  // Read-only; mirrors getCurrentAttrs (valid_until IS NULL). Also used as the
  // graph panel's fallback list when the ego graph is too sparse to draw.
  register({
    kind: "exact",
    path: "/api/dsh-mneme/semantic/graph/entity-attrs",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const name = (url.searchParams.get("entity") ?? "").trim();
        if (!name) {
          sendJson(res, 400, { error: "missing-entity" });
          return;
        }
        const entity = service.findEntityByName?.(name);
        if (!entity) {
          sendJson(res, 404, { error: "entity-not-found" });
          return;
        }
        const attrs = service.getCurrentAttrs?.(entity.id) ?? [];
        sendJson(res, 200, {
          entity: { id: entity.id, name: entity.name, type: entity.type ?? null, mention_count: entity.mention_count ?? 1 },
          attrs: Array.isArray(attrs)
            ? attrs.map((a) => ({
                key: a.attr_key,
                value: a.attr_value,
                confidence: a.confidence ?? null,
                valid_from: a.valid_from ?? null
              }))
            : []
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- wiki-link back links (v0.6.1) --------------------------------------
  // Read-only like the graph endpoints, so it stays open when apiToken is set.
  // GET /api/dsh-mneme/wikilinks/backlinks?id=<memoryId> → memories whose
  // content carries a [[wiki-link]] resolving to the given memory.
  register({
    kind: "exact",
    path: "/api/dsh-mneme/wikilinks/backlinks",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const id = (url.searchParams.get("id") ?? "").trim();
        if (!id) {
          sendJson(res, 400, { error: "missing-id" });
          return;
        }
        const memory = service.getById?.(id) ?? null;
        const backlinks = (service.getBacklinks?.(id) ?? []).map(({ source, relation }) => ({
          id: source.id,
          title: source.title,
          type: source.type,
          created_at: relation.created_at
        }));
        sendJson(res, 200, {
          memoryId: id,
          memory: memory ? { id: memory.id, title: memory.title, type: memory.type } : null,
          backlinks
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- wiki-link forward links (v0.6.1) -----------------------------------
  // GET /api/dsh-mneme/wikilinks/forward?id=<memoryId> → memories the given
  // memory explicitly links to. Unresolved target titles surface with id:null.
  register({
    kind: "exact",
    path: "/api/dsh-mneme/wikilinks/forward",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const id = (url.searchParams.get("id") ?? "").trim();
        if (!id) {
          sendJson(res, 400, { error: "missing-id" });
          return;
        }
        const memory = service.getById?.(id) ?? null;
        const links = (service.getForwardLinks?.(id) ?? []).map(({ target, relation }) => ({
          id: target?.id ?? null,
          title: target?.title ?? relation.to_entity,
          type: target?.type ?? null,
          created_at: relation.created_at
        }));
        sendJson(res, 200, {
          memoryId: id,
          memory: memory ? { id: memory.id, title: memory.title, type: memory.type } : null,
          links
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- wiki-link resolve (v0.6.1) -----------------------------------------
  // GET /api/dsh-mneme/wikilinks/resolve?title=<title> → case-insensitive exact
  // title match against the memories table (the resolution used when writing
  // links_to relations). 404 when no memory matches.
  register({
    kind: "exact",
    path: "/api/dsh-mneme/wikilinks/resolve",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const title = (url.searchParams.get("title") ?? "").trim();
        if (!title) {
          sendJson(res, 400, { error: "missing-title" });
          return;
        }
        const memory = service.resolveWikiLink?.(title) ?? null;
        if (!memory) {
          sendJson(res, 404, { error: "memory-not-found", title });
          return;
        }
        // Note: no `source` field — it may carry file paths/internal host info
        // and this endpoint is read-only without auth when apiToken is set.
        sendJson(res, 200, {
          title,
          memory: {
            id: memory.id,
            title: memory.title,
            type: memory.type
          }
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- health: mirror sync state (F-NEW-03 / v0.3.6) ---
  // Auth-gated; only returns a sanitized error code (never raw last_error which
  // may leak paths/token-like strings/internal hosts). On state read failure it
  // reports unknown/degraded (fail-closed) instead of a false dirty=false.
  register({
    kind: "exact",
    path: "/api/dsh-mneme/health",
    handler(req, res) {
      if (!requireAuth(req, res, apiToken)) return;
      let state = null;
      try {
        state = service.getMirrorHealth?.() ?? null;
      } catch {
        // read failure is itself a health signal: do not report a false clean
        sendJson(res, 200, { mirror: { dirty: null, status: "unknown", last_error: null, last_attempt: null, success_at: null } });
        return;
      }
      if (!state) {
        sendJson(res, 200, { mirror: { dirty: null, status: "unknown", last_error: null, last_attempt: null, success_at: null } });
        return;
      }
      // Real read failure surfaces as dirty === null (peer blocker 5): report
      // unknown explicitly instead of collapsing into a false "ok"/"degraded".
      if (state.dirty === null) {
        sendJson(res, 200, {
          mirror: { dirty: null, status: "unknown", last_error: null, last_attempt: null, success_at: null }
        });
        return;
      }
      // Sanitized: boolean dirty + coarse status only; error string is mapped to
      // a bounded code, never echoed verbatim.
      let code = null;
      if (state.last_error) {
        const e = String(state.last_error);
        code = /enospc|no space/i.test(e) ? "no-space" : /permission|eacces/i.test(e) ? "permission" : "sync-failed";
      }
      sendJson(res, 200, {
        mirror: {
          dirty: state.dirty === true,
          status: state.dirty === true ? "degraded" : (code ? "degraded" : "ok"),
          last_error: code,
          last_attempt: state.last_attempt ?? null,
          success_at: state.success_at ?? null
        }
      });
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
    routes: 11,
    dispose: () => {
      for (const dispose of disposers) dispose();
    }
  };
}
