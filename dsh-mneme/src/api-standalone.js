// Standalone HTTP API (v0.7.12): a plain node:http server for ecosystem
// integrations that live outside the DSH host and cannot reach the plugin's
// internal webServer routes (/api/dsh-mneme/*). Mirrors the JSON semantics of
// those routes but with mandatory Bearer-token auth on everything except
// GET /health, so the store can be exposed safely on loopback.
//
// Security: the default bind host is 127.0.0.1. Pointing externalApiHost at a
// non-loopback address exposes the whole memory store to the network — that is
// the operator's explicit responsibility (documented in README).
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { TYPES } from "./store.js";

const DEFAULT_PORT = 8790;
const DEFAULT_HOST = "127.0.0.1";
// Hardcoded release version (package.json is bumped at publish time and may
// lag the code that ships in between).
const VERSION = "0.7.12";

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/** True when the request carries the configured token. */
function isAuthorized(req, apiToken) {
  const raw = req.headers?.authorization ?? req.headers?.["x-dsh-mneme-token"] ?? "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw.trim();
  if (token === "" || token.length !== apiToken.length) return false;
  // Constant-time comparison: no timing oracle on the token.
  return timingSafeEqual(Buffer.from(token), Buffer.from(apiToken));
}

/** Collect the request body as text (tolerant of transport errors). */
function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(""));
  });
}

/**
 * Create (and start) the standalone API server.
 * Accepts { service, store, config, logger, settings, port, host }:
 *   - token: persisted settings kv "external_api" wins; auto-generated
 *     (crypto.randomBytes(24).toString("base64url")) and persisted when empty.
 *   - port:  explicit arg > persisted settings > config.externalApiPort > 8790.
 *   - host:  explicit arg > config.externalApiHost > "127.0.0.1".
 * Returns { server, port, host, token, ready }: `port` is the effective bound
 * port (updated to the OS-assigned one after `ready` resolves when asked to
 * bind port 0), `ready` resolves once listening and rejects if the bind fails.
 */
export function createStandaloneApi({ service, store, config = {}, logger, settings, port, host }) {
  const persisted = settings?.getExternalApi?.() ?? {};

  let token = typeof persisted.token === "string" ? persisted.token : "";
  if (!token) {
    token = randomBytes(24).toString("base64url");
    // Persist only the token; enabled/port keys stay as they are (merge).
    try {
      settings?.setExternalApi?.({ token });
    } catch (error) {
      logger?.warn?.(`[dsh-mneme] standalone API token persistence failed: ${String(error)}`);
    }
  }

  // Persisted host (set from the panel) wins over the bundle config, same
  // precedence as port; the explicit argument still wins over both.
  const boundHost = host
    ?? (typeof persisted.host === "string" && persisted.host ? persisted.host : undefined)
    ?? config.externalApiHost
    ?? DEFAULT_HOST;
  const persistedPort = Number(persisted.port);
  const boundPort = port
    ?? (Number.isInteger(persistedPort) && persistedPort > 0 ? persistedPort : undefined)
    ?? config.externalApiPort
    ?? DEFAULT_PORT;

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;

      // Health is the single unauthenticated probe (monitor checks).
      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Everything else requires the Bearer token.
      if (!isAuthorized(req, token)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      // --- GET /status: version + store shape + uptime -----------------------
      if (req.method === "GET" && pathname === "/status") {
        const byType = {};
        for (const type of TYPES) byType[type] = service.count(type);
        let entities = 0;
        try {
          entities = store.db.prepare("SELECT count(*) AS c FROM entities").get().c;
        } catch { /* entities storage unavailable → 0 */ }
        sendJson(res, 200, {
          version: VERSION,
          memories: { total: service.count(), byType },
          entities,
          uptime_s: Math.floor(process.uptime())
        });
        return;
      }

      // --- GET /memories: paged + filtered list (same semantics as the
      //     internal /api/dsh-mneme/list) ------------------------------------
      if (req.method === "GET" && pathname === "/memories") {
        const type = url.searchParams.get("type") ?? undefined;
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const order = url.searchParams.get("order") ?? undefined;
        const minRaw = url.searchParams.get("minImportance");
        const minImportance = minRaw !== null && minRaw !== "" && !Number.isNaN(Number(minRaw))
          ? Number(minRaw)
          : undefined;
        const source = url.searchParams.get("source") || undefined;
        const items = service.toApiList(service.list({ type, limit, offset, order, minImportance, source }));
        // Total honors the same filters so pager math stays correct.
        sendJson(res, 200, { items, total: service.count(type, { minImportance, source }) });
        return;
      }

      // --- GET/DELETE /memories/:id ------------------------------------------
      const idMatch = pathname.match(/^\/memories\/([^/]+)$/);
      if (idMatch) {
        let id = idMatch[1];
        try { id = decodeURIComponent(id); } catch { /* keep raw */ }
        if (req.method === "GET") {
          const row = service.getById(id);
          if (!row) {
            sendJson(res, 404, { error: "not-found" });
            return;
          }
          sendJson(res, 200, service.toApiList([row])[0]);
          return;
        }
        if (req.method === "DELETE") {
          // store.remove deletes silently — precheck for a distinguishable 404.
          if (!service.getById(id)) {
            sendJson(res, 404, { error: "not-found" });
            return;
          }
          service.remove(id);
          sendJson(res, 200, { ok: true });
          return;
        }
        sendJson(res, 404, { error: "not-found" });
        return;
      }

      // --- POST /memories: save with title-dedupe (safer than raw save) ------
      if (req.method === "POST" && pathname === "/memories") {
        void readBody(req).then((text) => {
          let body;
          try {
            body = JSON.parse(text || "{}");
          } catch {
            sendJson(res, 400, { error: "invalid-json" });
            return;
          }
          if (body === null || typeof body !== "object" || Array.isArray(body)) {
            sendJson(res, 400, { error: "invalid-body" });
            return;
          }
          // Pre-validate what store.save would throw on, so clients get a
          // clean 400 instead of a leaked SQLite error.
          if (!TYPES.has(body.type)) {
            sendJson(res, 400, { error: "invalid-type" });
            return;
          }
          if (typeof body.title !== "string" || !body.title.trim()) {
            sendJson(res, 400, { error: "missing-title" });
            return;
          }
          if (typeof body.content !== "string") {
            sendJson(res, 400, { error: "missing-content" });
            return;
          }
          if (body.tags !== undefined && !Array.isArray(body.tags)) {
            sendJson(res, 400, { error: "tags-must-be-an-array" });
            return;
          }
          try {
            const { action, memory } = service.saveWithDedupe({
              type: body.type,
              title: body.title,
              content: body.content,
              importance: body.importance,
              tags: body.tags,
              source: body.source
            });
            sendJson(res, action === "created" ? 201 : 200, service.toApiList([memory])[0]);
          } catch (error) {
            logger?.warn?.(`[dsh-mneme] standalone API save failed: ${String(error)}`);
            sendJson(res, 500, { error: "internal" });
          }
        });
        return;
      }

      // --- GET /search: unified recall pipeline (keyword + vector + BM25) ----
      if (req.method === "GET" && pathname === "/search") {
        const q = url.searchParams.get("q") ?? "";
        const limit = Number(url.searchParams.get("topK") ?? url.searchParams.get("limit") ?? 20);
        const mode = url.searchParams.get("mode") ?? "auto";
        const rerank = url.searchParams.get("rerank") !== "false";
        const query = q.trim();
        if (!query) {
          sendJson(res, 200, { items: [], mode: "keyword" });
          return;
        }
        // Any vector/rerank failure degrades to keyword inside searchMemories.
        void Promise.resolve(
          service.searchMemories(query, { mode, topK: limit, useRerank: rerank })
        ).then((rows) => {
          const used = rows.some((m) => m.vector === true) ? "vector" : "keyword";
          sendJson(res, 200, { items: service.toApiList(rows), mode: used });
        }).catch(() => {
          sendJson(res, 200, { items: service.toApiList(service.search(query, { limit })), mode: "keyword" });
        });
        return;
      }

      sendJson(res, 404, { error: "not-found" });
    } catch {
      sendJson(res, 500, { error: "internal" });
    }
  });

  // A permanent error listener keeps an EADDRINUSE / runtime socket error from
  // crashing the host process; `ready` still surfaces the first bind failure.
  server.on("error", (error) => {
    logger?.warn?.(`[dsh-mneme] standalone API error: ${String(error)}`);
  });
  const ready = new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.listen(boundPort, boundHost);
  ready.then(() => {
    const address = server.address();
    if (address && typeof address === "object") {
      logger?.info?.(`[dsh-mneme] standalone API listening on http://${address.address}:${address.port}`);
    }
  }).catch(() => { /* already logged by the error handler above */ });

  const api = { server, port: boundPort, host: boundHost, token, ready };
  // After the OS assigns the real port (bind port 0), reflect it for callers.
  ready.then(() => {
    const address = server.address();
    if (address && typeof address === "object") api.port = address.port;
  }).catch(() => { /* bind failed: port stays as configured */ });
  return api;
}
