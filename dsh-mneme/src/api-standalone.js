// Standalone HTTP API (v0.7.12): a plain node:http server for ecosystem
// integrations that live outside the DSH host and cannot reach the plugin's
// internal webServer routes (/api/dsh-mneme/*). Mirrors the JSON semantics of
// those routes but with mandatory Bearer-token auth on everything except
// GET /health, so the store can be exposed safely on loopback.
//
// #181 (MCP stdio server, bin/dsh-mneme-mcp.mjs) rides on these routes as its
// data plane: the six-tool surface (memory_save/search/list/get/update/delete)
// is fully served here — PUT /memories/:id, the save passthrough fields
// (sensitivity / occurred_at / explicit scope) and the list/search archived +
// occurred-window filters exist for that parity, with tool-identical semantics.
//
// Security: the default bind host is 127.0.0.1. Pointing externalApiHost at a
// non-loopback address exposes the whole memory store to the network — that is
// the operator's explicit responsibility (documented in README).
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { TYPES } from "./store.js";
import { bootstrapFromDirectory } from "./bootstrap.js";

const DEFAULT_PORT = 8790;
const DEFAULT_HOST = "127.0.0.1";
// Hardcoded release version (package.json is bumped at publish time and may
// lag the code that ships in between).
const VERSION = "0.7.12";
const MAX_PORT_ATTEMPTS = 20;

/**
 * Listen with automatic EADDRINUSE recovery. Tries the configured port, then
 * the next MAX_PORT_ATTEMPTS-1 ports, and finally falls back to port 0 so the
 * OS assigns a free port. Multiple DSH profiles/instances sharing the default
 * port no longer leave the standalone API permanently unavailable.
 */
function listenWithRetry(server, startPort, host, logger) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (port) => {
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        resolve(address && typeof address === "object" ? address.port : port);
      };
      const onError = (error) => {
        server.off("listening", onListening);
        if (error?.code === "EADDRINUSE" && attempt < MAX_PORT_ATTEMPTS - 1) {
          attempt++;
          const next = startPort + attempt;
          logger?.warn?.(`[dsh-mneme] standalone API port ${port} in use, retrying ${next}`);
          tryListen(next);
          return;
        }
        if (error?.code === "EADDRINUSE") {
          logger?.warn?.(`[dsh-mneme] standalone API port ${port} still in use, falling back to OS-assigned port`);
          tryListen(0);
          return;
        }
        reject(error);
      };
      server.once("listening", onListening);
      server.once("error", onError);
      server.listen(port, host);
    };
    tryListen(startPort);
  });
}

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
 * PUT /memories/:id 的请求体处理（模块级函数便于在调用点被 try/catch 包住：
 * service 抛错绝不能变成未处理拒绝或悬着不回的请求）。校验与内部
 * /api/dsh-mneme/update 同风格：字段出现就必须合法，宁 400 不静默纠正；
 * content 改写按 human_override 入档；scope 修正归一化在 service 层做
 * （null=放宽到全局，字符串=收窄/改标），审计 actor 记 "tool"。
 */
async function handlePutBody(res, service, logger, id, text) {
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
  const patch = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) {
      sendJson(res, 400, { error: "invalid-title" });
      return;
    }
    patch.title = body.title.trim();
  }
  if (body.content !== undefined) {
    if (typeof body.content !== "string" || !body.content.trim()) {
      sendJson(res, 400, { error: "invalid-content" });
      return;
    }
    patch.content = body.content.trim();
  }
  if (body.type !== undefined) {
    if (!TYPES.has(body.type)) {
      sendJson(res, 400, { error: "invalid-type" });
      return;
    }
    patch.type = body.type;
  }
  if (body.importance !== undefined) {
    if (!Number.isInteger(body.importance) || body.importance < 1 || body.importance > 5) {
      sendJson(res, 400, { error: "invalid-importance" });
      return;
    }
    patch.importance = body.importance;
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || !body.tags.every((t) => typeof t === "string")) {
      sendJson(res, 400, { error: "invalid-tags" });
      return;
    }
    patch.tags = body.tags;
  }
  if (body.agent_scope !== undefined && body.agent_scope !== null && typeof body.agent_scope !== "string") {
    sendJson(res, 400, { error: "invalid-agent-scope" });
    return;
  }
  if (body.workspace_scope !== undefined && body.workspace_scope !== null && typeof body.workspace_scope !== "string") {
    sendJson(res, 400, { error: "invalid-workspace-scope" });
    return;
  }
  if (body.agent_scope !== undefined) patch.agent_scope = body.agent_scope;
  if (body.workspace_scope !== undefined) patch.workspace_scope = body.workspace_scope;
  if (body.reason !== undefined && (typeof body.reason !== "string" || !body.reason.trim())) {
    sendJson(res, 400, { error: "invalid-reason" });
    return;
  }
  if (Object.keys(patch).length === 0) {
    sendJson(res, 400, { error: "no-fields" });
    return;
  }
  const existing = service.getById(id);
  if (!existing) {
    sendJson(res, 404, { error: "not-found" });
    return;
  }
  // 内容被改写时旧版本先入档（human_override），与内部面板写路径一致。
  if (patch.content !== undefined && patch.content !== existing.content) {
    const history = Array.isArray(existing.content_history) ? existing.content_history : [];
    patch.content_history = [
      { content: existing.content ?? "", source: "human_override", updated_at: new Date().toISOString() },
      ...history
    ].slice(0, 20);
  }
  service.update(id, patch, {
    actor: "tool",
    ...(typeof body.reason === "string" && body.reason.trim() ? { query: body.reason.trim() } : {})
  });
  sendJson(res, 200, { memory: service.toApiList([service.getById(id)])[0] });
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

      // --- GET /profile: user self-description -------------------------------
      if (req.method === "GET" && pathname === "/profile") {
        sendJson(res, 200, { profile: settings?.getProfile?.() ?? "" });
        return;
      }

      // --- GET /rules: agent behavior rules -----------------------------------
      if (req.method === "GET" && pathname === "/rules") {
        sendJson(res, 200, { rules: settings?.getRules?.() ?? [] });
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
        // include_archived + occurred 时间窗：与 memory_list 工具同口径（工具
        // 面六件套经 8790 全量可用，#181）；缺省行为与既有调用方逐字节一致。
        const includeArchived = url.searchParams.get("include_archived") === "true";
        const occurredFrom = url.searchParams.get("occurred_from") ?? undefined;
        const occurredTo = url.searchParams.get("occurred_to") ?? undefined;
        const listFilters = { includeArchived, ...(occurredFrom ? { occurredFrom } : {}), ...(occurredTo ? { occurredTo } : {}) };
        const items = service.toApiList(service.list({ type, limit, offset, order, minImportance, source, ...listFilters }));
        // Total honors the same filters so pager math stays correct.
        sendJson(res, 200, { items, total: service.count(type, { minImportance, source, ...listFilters }) });
        return;
      }

      // --- GET/PUT/DELETE /memories/:id --------------------------------------
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
        // --- PUT: field patch（memory_update 工具的外部通道，#181）。字段校验
        // 与内部 /api/dsh-mneme/update 同风格：字段出现就必须合法，宁 400 不静默
        // 纠正；content 改写按 human_override 入档；scope 修正归一化在 service
        // 层做（null=放宽到全局，字符串=收窄/改标），审计 actor 记 "tool"。
        // 整个异步回调套 try/catch：service 抛错不能变成未处理拒绝（Node 默认
        // 策略下会终止宿主进程）或悬着不回的请求（外层同步 try 捕不到这里）。
        if (req.method === "PUT") {
          void readBody(req).then(async (text) => {
            try {
              await handlePutBody(res, service, logger, id, text);
            } catch (error) {
              logger?.warn?.(`[dsh-mneme] standalone API update failed: ${String(error)}`);
              sendJson(res, 500, { error: "internal" });
            }
          });
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
          // memory_save 工具的其余可选字段（#181）：sensitivity / occurred_at /
          // 显式 scope。scope 仅收显式声明（standalone API 无会话上下文，自动
          // 标注无从解析，语义与工具的显式参数一致）；形状不对宁 400 不静默丢。
          for (const key of ["sensitivity", "occurred_at", "agent_scope", "workspace_scope"]) {
            if (body[key] !== undefined && (typeof body[key] !== "string" || !body[key].trim())) {
              sendJson(res, 400, { error: `invalid-${key.replace(/_/g, "-")}` });
              return;
            }
          }
          try {
            const { action, memory } = service.saveWithDedupe({
              type: body.type,
              title: body.title,
              content: body.content,
              importance: body.importance,
              tags: body.tags,
              source: body.source,
              ...(body.sensitivity !== undefined ? { sensitivity: body.sensitivity } : {}),
              ...(body.occurred_at !== undefined ? { occurred_at: body.occurred_at } : {}),
              ...(body.agent_scope !== undefined ? { agent_scope: body.agent_scope, agent_scope_source: "explicit" } : {}),
              ...(body.workspace_scope !== undefined ? { workspace_scope: body.workspace_scope, workspace_scope_source: "explicit" } : {})
            });
            // action 随行透出（created/merged）：memory_save 工具语义对齐所需，
            // 附加键对既有消费方（CLI add 等）向后兼容。
            sendJson(res, action === "created" ? 201 : 200, { ...service.toApiList([memory])[0], action });
          } catch (error) {
            logger?.warn?.(`[dsh-mneme] standalone API save failed: ${String(error)}`);
            sendJson(res, 500, { error: "internal" });
          }
        });
        return;
      }

      // --- POST /bootstrap: cold-start memories from repo files (#220) -------
      // 显式收 dir（插件没有工作区根目录概念，不猜路径）；确定性解析零 LLM；
      // 幂等骑 saveWithDedupe 的 (type, title, scope) 去重 + _overwrite 刷新。
      if (req.method === "POST" && pathname === "/bootstrap") {
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
          if (typeof body.dir !== "string" || !body.dir.trim()) {
            sendJson(res, 400, { error: "missing-dir" });
            return;
          }
          bootstrapFromDirectory({ service, dir: body.dir, logger })
            .then((summary) => sendJson(res, 200, summary))
            .catch((error) => {
              if (error?.code) {
                sendJson(res, 400, { error: error.code });
                return;
              }
              logger?.warn?.(`[dsh-mneme] standalone API bootstrap failed: ${String(error)}`);
              sendJson(res, 500, { error: "internal" });
            });
        });
        return;
      }

      // --- GET /search: unified recall pipeline (keyword + vector + BM25) ----
      if (req.method === "GET" && pathname === "/search") {
        const q = url.searchParams.get("q") ?? "";
        const limit = Number(url.searchParams.get("topK") ?? url.searchParams.get("limit") ?? 20);
        const mode = url.searchParams.get("mode") ?? "auto";
        const rerank = url.searchParams.get("rerank") !== "false";
        const occurredFrom = url.searchParams.get("occurred_from") ?? null;
        const occurredTo = url.searchParams.get("occurred_to") ?? null;
        const query = q.trim();
        if (!query) {
          sendJson(res, 200, { items: [], mode: "keyword" });
          return;
        }
        // Any vector/rerank failure degrades to keyword inside searchMemories.
        void Promise.resolve(
          service.searchMemories(query, {
            mode,
            topK: limit,
            useRerank: rerank,
            ...(occurredFrom !== null || occurredTo !== null ? { occurredFrom, occurredTo } : {})
          })
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
    // listening handled by listenWithRetry
    listenWithRetry(server, boundPort, boundHost, logger).then(resolve, reject);
  });
  // server.listen is called inside listenWithRetry
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
