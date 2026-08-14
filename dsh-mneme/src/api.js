import { URL } from "node:url";

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
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

export function createApi(ctx, service, settings, commands, embedder, semantic = null) {
  const disposers = [];

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
        // mode: auto (default) | keyword | vector | hybrid
        const mode = url.searchParams.get("mode") ?? "auto";
        const query = q.trim();
        if (!query) {
          sendJson(res, 200, { items: [], mode: "keyword" });
          return;
        }
        // Keyword results (existing behavior) always computed; used as a
        // fallback and as the primary ranking when vector is unavailable.
        const keyword = service.toApiList(service.search(query, { limit }));
        if (mode === "keyword" || !embedder) {
          sendJson(res, 200, { items: keyword, mode: "keyword" });
          return;
        }
        const cfg = settings.getVectorConfig();
        if (mode === "vector" && !cfg?.enabled) {
          sendJson(res, 200, { items: keyword, mode: "keyword", error: "vector-disabled" });
          return;
        }
        // Try vector search; on any failure fall back to keyword results.
        return embedder.embed(query).then(async (vector) => {
          let items = keyword;
          let used = "keyword";
          if (vector) {
            const scored = service.toApiList(service.searchVector(vector, { limit }));
            if (mode === "hybrid") {
              // hybrid: vector recalls lead, keyword fills remaining slots
              const seen = new Set(scored.map((m) => m.id));
              const merged = [...scored.slice(0, limit)];
              for (const m of keyword) {
                if (merged.length >= limit) break;
                if (!seen.has(m.id)) { seen.add(m.id); merged.push(m); }
              }
              items = merged;
              used = "vector";
            } else {
              // auto/vector: keyword exact hits first (the user's literal
              // words), then vector results fill the remaining slots, deduped.
              const seen = new Set(keyword.map((m) => m.id));
              const merged = [...keyword];
              for (const m of scored) {
                if (merged.length >= limit) break;
                if (!seen.has(m.id)) {
                  seen.add(m.id);
                  merged.push(m);
                }
              }
              items = merged;
              used = "vector";
            }
          }
          sendJson(res, 200, { items, mode: used });
        }).catch(() => {
          sendJson(res, 200, { items: keyword, mode: "keyword" });
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
        if (req.method === "PUT" || req.method === "POST") {
          return readBody(req).then((text) => {
            const body = parseBody(text);
            const cfg = settings.setVectorConfig({
              enabled: body.enabled,
              baseUrl: body.baseUrl,
              apiKey: body.apiKey,
              model: body.model
            });
            sendJson(res, 200, { config: cfg });
          });
        }
        sendJson(res, 200, { config: settings.getVectorConfig() ?? { enabled: false, baseUrl: "", apiKey: "", model: "" } });
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
        if (!embedder) {
          sendJson(res, 200, { indexed: 0, skipped: 0, error: "vector-unavailable" });
          return;
        }
        const url = new URL(req.url, "http://localhost");
        const limit = Number(url.searchParams.get("limit") ?? 100);
        embedder.reindexMissing(limit).then((result) => {
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

  // --- custom commands ---
  register({
    kind: "exact",
    path: "/api/dsh-mneme/commands",
    handler(req, res) {
      try {
        if (req.method === "POST") {
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
