import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { FEATURE_FLAG_SPEC } from "./settings.js";
import { TYPE_FILE, renderMirrorText, parseHumanEdits } from "./mirror.js";
import { computeHeat } from "./heat.js";

// headers：少数端点（/export 附件下载）需要追加 Content-Disposition 等响应头。
function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(payload));
}

// 附件下载响应（导出端点）：Content-Type 与文件名（含日期后缀）由调用方给定。
function sendAttachment(res, status, contentType, filename, body) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${filename}"`
  });
  res.end(body);
}

// 导出 JSON 的 version 字段：读插件根的 package.json（src/ 与 lib/ 都在根下
// 一层，相对 import.meta.url 解析一致）。读取失败（打包/受限环境）降级为
// "unknown"，导出本身仍然可用。
const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

// Defaults for the standalone external API — keep in step with the schema
// defaults in config.js (externalApiPort / externalApiHost).
const EXTERNAL_API_DEFAULTS = { enabled: false, port: 8790, host: "127.0.0.1" };

/** Merge persisted external-api kv over the defaults for client display. */
function fullExternalConfig(kv = {}) {
  return {
    enabled: kv.enabled === true,
    port: Number.isInteger(kv.port) && kv.port > 0 ? kv.port : EXTERNAL_API_DEFAULTS.port,
    host: kv.host || EXTERNAL_API_DEFAULTS.host,
    token: kv.token || ""
  };
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

export function createApi(ctx, service, settings, commands, embedder, semantic = null, apiToken = "", config = null) {
  const disposers = [];

  // webServer 在 index.js 的 inject 声明中（cordis 等宿主服务就绪后 apply），
  // 这里做防御性读取：cordis ctx 的 Proxy 不允许直接访问未 inject 的属性
  // （会抛 "cannot get property without inject"），用 ctx.reflect.get 免
  // inject 读取（未提供返回 undefined）；对象字面量 mock ctx（测试）没有
  // reflect，退回直接属性访问。createApi 只在有 webServer 时被调用（index.js
  // 守卫 + 测试 mock），故下方 register 用之非空。
  const webServer = typeof ctx.reflect?.get === "function" ? ctx.reflect.get("webServer") : ctx.webServer;

  // feature flags 快照（GET/PUT 共用）：overrides 是持久化的用户显式覆盖；
  // effective 是启动配置在白名单键上被 overrides 覆盖后的最终值。config 缺席
  // （旧调用方直连、未传 cfg）时只报被覆盖的键，不把不存在的默认值编造给前端。
  const flagKeys = [
    ...FEATURE_FLAG_SPEC.booleans,
    ...Object.keys(FEATURE_FLAG_SPEC.ints),
    ...FEATURE_FLAG_SPEC.strings,
    ...FEATURE_FLAG_SPEC.urls,
    ...Object.keys(FEATURE_FLAG_SPEC.enums)
  ];
  // 嵌套键在 kv 里按点号平铺（"memoryQualityFilter.enabled"），运行时 cfg 里
  // 是嵌套对象，effective 从对象子字段取值；其余键照旧从 cfg 顶层取。
  const NESTED_FLAG_PATHS = {
    "memoryQualityFilter.enabled": ["memoryQualityFilter", "enabled"],
    "llmAudit.enabled": ["llmAudit", "enabled"]
  };
  function configFlagValue(key) {
    const path = NESTED_FLAG_PATHS[key];
    if (path) return config?.[path[0]]?.[path[1]];
    return config?.[key];
  }
  function featureSnapshot() {
    const overrides = settings.getFeatureFlags();
    const effective = {};
    for (const key of flagKeys) {
      if (overrides[key] !== undefined) effective[key] = overrides[key];
      else {
        const value = configFlagValue(key);
        if (value !== undefined) effective[key] = value;
      }
    }
    return { overrides, effective };
  }

  // Ensure the service has an embedder when the API layer was handed one
  // (tests wire the embedder through the API instead of index.js). Without
  // this, /api/dsh-mneme/search would silently degrade to keyword-only.
  if (embedder && typeof service.setEmbedder === "function") {
    service.setEmbedder(embedder);
  }

  const register = (route) => {
    disposers.push(webServer.register(route));
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
        // order=chrono: pure newest-first for paged browsing; default keeps
        // the importance-ranked order other callers rely on.
        const order = url.searchParams.get("order") ?? undefined;
        // minImportance: numeric lower bound on importance (absent/NaN → no
        // floor); source: exact match on the source column (empty → no filter).
        const minRaw = url.searchParams.get("minImportance");
        const minImportance = minRaw !== null && minRaw !== "" && !Number.isNaN(Number(minRaw))
          ? Number(minRaw)
          : undefined;
        const source = url.searchParams.get("source") || undefined;
        // updatedFrom/updatedTo：updated_at 闭区间过滤（ISO 日期或完整时间戳）。
        // 边界归一化在 store 的 updatedAtBounds（list/count 共用同一纯函数）
        // 完成，非法值在那里被忽略——这里原样透传即可。
        const updatedFrom = url.searchParams.get("updatedFrom") ?? undefined;
        const updatedTo = url.searchParams.get("updatedTo") ?? undefined;
        // archived=only：只看归档（状态页的归档列表用）。归档行不进默认列表，
        // 所以这是独立的视图开关，而不是 includeArchived 的混看模式。
        const onlyArchived = url.searchParams.get("archived") === "only";
        // deposited=only：只看 autoDream 巩固过的记忆（receipt_chain 的
        // merge/update verdict ∪ source=dream 直写）——状态页「查看全部」
        // 与记忆库的「沉淀」筛选 chip 共用这个视图。
        const depositedOnly = url.searchParams.get("deposited") === "only";
        const rows = service.list({ type, limit, offset, order, minImportance, source, updatedFrom, updatedTo, onlyArchived, depositedOnly });
        // 面板行在 wire DTO 之上补 archived/quality_score——模型工具的输出
        // schema 严格复用 toApiList，扩展只发生在 HTTP 层。
        // heat 投影（阶段二前端数据源）：仅 heatEnabled=true 时下发逐条热度
        // （heat.js 纯函数，λ=0 免疫类型恒 1.0）；字段缺省时前端徽章自动隐藏。
        const heatOn = config?.heatEnabled === true;
        const items = service.toApiList(rows).map((m, i) => ({
          ...m,
          archived: rows[i].archived === true || rows[i].archived === 1,
          quality_score: rows[i].quality_score ?? null,
          ...(heatOn ? { heat: computeHeat(rows[i], Date.now(), config ?? {}) } : {})
        }));
        // Total honors the same filters as the rows, or the pager's
        // has-more math breaks whenever minImportance/source/updated-at
        // bounds are active.
        sendJson(res, 200, { items, total: service.count(type, { minImportance, source, updatedFrom, updatedTo, onlyArchived, depositedOnly }) });
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

  // --- delete one memory by id ---
  // Mutation route: apiToken-gated like the profile/rules writes above. POST
  // body is JSON { id }. store.remove deletes silently, so existence is checked
  // up front to give clients a distinguishable 404 instead of a fake success.
  register({
    kind: "exact",
    path: "/api/dsh-mneme/delete",
    handler(req, res) {
      try {
        if (req.method !== "POST") {
          sendJson(res, 404, { error: "not-found" });
          return;
        }
        if (!requireAuth(req, res, apiToken)) return;
        return readBody(req).then((text) => {
          const body = parseBody(text);
          const id = typeof body.id === "string" ? body.id.trim() : "";
          if (!id) {
            sendJson(res, 400, { error: "missing-id" });
            return;
          }
          if (!service.getById(id)) {
            sendJson(res, 404, { error: "not-found" });
            return;
          }
          service.remove(id);
          sendJson(res, 200, { ok: true });
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- 编辑/归档一条记忆（面板写路径，与 /delete 对称命名）-------------------
  // POST body {id, title?, content?, importance?, tags?, archived?}。字段校验
  // 只做类型/范围检查：字段出现（!== undefined）就必须合法，宁 400 不静默纠正
  // ——静默丢字段会让面板误以为保存成功。写入走 service 的正规更新路径：
  // updated_at 由 store 的单调时钟推进；content 被改写时旧版本按 human_override
  // 入档（与镜像人工编辑回灌 mergeHumanEdits 的语义对齐，FIFO 上限 20）；
  // archived 走 setArchived。两条路径都会触发镜像重渲染（afterSync）。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/update",
    handler(req, res) {
      try {
        if (req.method !== "POST") {
          sendJson(res, 404, { error: "not-found" });
          return;
        }
        if (!requireAuth(req, res, apiToken)) return;
        return readBody(req).then((text) => {
          const body = parseBody(text);
          const id = typeof body.id === "string" ? body.id.trim() : "";
          if (!id) {
            sendJson(res, 400, { error: "missing-id" });
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
          if (body.archived !== undefined && typeof body.archived !== "boolean") {
            sendJson(res, 400, { error: "invalid-archived" });
            return;
          }
          if (Object.keys(patch).length === 0 && body.archived === undefined) {
            sendJson(res, 400, { error: "no-fields" });
            return;
          }
          const existing = service.getById(id);
          if (!existing) {
            sendJson(res, 404, { error: "not-found" });
            return;
          }
          // 内容被改写时旧版本先入档（human_override），人工修正不静默销毁旧值。
          if (patch.content !== undefined && patch.content !== existing.content) {
            const history = Array.isArray(existing.content_history) ? existing.content_history : [];
            patch.content_history = [
              { content: existing.content ?? "", source: "human_override", updated_at: new Date().toISOString() },
              ...history
            ].slice(0, 20);
          }
          if (Object.keys(patch).length) service.update(id, patch);
          if (body.archived !== undefined) service.setArchived(id, body.archived);
          sendJson(res, 200, { memory: service.getById(id) });
        });
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
            distance: n.distance,
            // v0.7.0 实体热投影：实体热 = 关联记忆 heat 聚合（max），前端据此
            // 缩放节点大小/明暗。heatEnabled=false 时 entityHeat 返回 null。
            heat: service.entityHeat?.(n.id) ?? null
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

  // --- entity directory (entity gene v0.3.0): read-only list for the UI ---
  // Flat entity list (newest-seen first). Attributes and relations stay on
  // their own per-entity endpoints, the directory only carries the columns
  // the rail needs: name, type, mention_count, first/last seen.
  register({
    kind: "exact",
    path: "/api/dsh-mneme/entities",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 500) || 500));
        const entities = service.listEntities?.({ limit }) ?? [];
        sendJson(res, 200, { entities, total: entities.length });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- 一条记忆的关联实体（记忆详情侧栏）-------------------------------------
  // 只读：entity_attrs.memory_id 反查实体（store 一条 JOIN 完成，按提及去重）。
  // 与目录 /entities 不同，这里以记忆为锚点，回答"这条记忆提到了谁"。记忆不
  // 存在或无关联一律返回空数组——详情侧栏不需要区分这两种情况。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/memories/entities",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const memoryId = (url.searchParams.get("memoryId") ?? "").trim();
        if (!memoryId) {
          sendJson(res, 400, { error: "missing-memory-id" });
          return;
        }
        sendJson(res, 200, { entities: service.entitiesForMemory?.(memoryId) ?? [] });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- 导出（面板备份/迁移）---------------------------------------------------
  // 只读。json：全字段行（含 archived/forgotten，布尔化），updated_at DESC；
  // markdown：按类型分节，块格式与磁盘镜像完全同构（renderMirrorText 与
  // mirror.sync 共用同一条渲染路径），因此导出文本可以被 /import 原样吃回。
  // 全量一次性取回（store.all 按 updated_at DESC）——导出是一次性备份动作，
  // 不需要流式。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/export",
    handler(req, res) {
      try {
        const url = new URL(req.url, "http://localhost");
        const format = url.searchParams.get("format") ?? "json";
        if (format !== "json" && format !== "markdown") {
          sendJson(res, 400, { error: "invalid-format" });
          return;
        }
        const rows = service.all?.() ?? [];
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        if (format === "json") {
          sendJson(res, 200, {
            exported_at: new Date().toISOString(),
            version: PACKAGE_VERSION,
            count: rows.length,
            memories: rows
          }, { "Content-Disposition": `attachment; filename="dsh-mneme-export-${stamp}.json"` });
          return;
        }
        const byType = {};
        for (const row of rows) {
          if (TYPE_FILE[row.type]) (byType[row.type] ??= []).push(row);
        }
        const sections = [];
        for (const type of Object.keys(TYPE_FILE)) {
          if (byType[type]?.length) sections.push(renderMirrorText(type, byType[type]));
        }
        sendAttachment(res, 200, "text/markdown; charset=utf-8", `dsh-mneme-export-${stamp}.md`, sections.join("\n"));
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- 导入（Markdown 镜像回填）----------------------------------------------
  // 写路径（requireAuth）。body {type, markdown}：type 是镜像 TYPE_FILE 键
  // （preference/project/decision/history/summary），markdown 是与镜像文件同构
  // 的文本。解析复用 readHumanEdits 的纯函数核心 parseHumanEdits（同一实现，
  // 行为一致是硬约束），合并走 mergeHumanEdits（只吃 title/content；digest 命
  // 中或无差异的条目在 service 侧自动跳过）。解析出 0 条不算错误。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/import",
    handler(req, res) {
      try {
        if (req.method !== "POST") {
          sendJson(res, 404, { error: "not-found" });
          return;
        }
        if (!requireAuth(req, res, apiToken)) return;
        return readBody(req).then((text) => {
          const body = parseBody(text);
          if (typeof body.type !== "string" || !Object.hasOwn(TYPE_FILE, body.type)) {
            sendJson(res, 400, { error: "invalid-type" });
            return;
          }
          if (typeof body.markdown !== "string" || !body.markdown.trim()) {
            sendJson(res, 400, { error: "invalid-markdown" });
            return;
          }
          const edits = parseHumanEdits(body.markdown);
          service.mergeHumanEdits(body.type, edits);
          sendJson(res, 200, { merged: edits.length, type: body.type });
        });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- 巩固状态（dream 面板）--------------------------------------------------
  // 只读：最近巩固运行（最多 5 条，created_at DESC）+ 未解决冲突队列。
  // pendingMemoryIds 从未解决冲突行提取涉及的记忆 id，去重后上限 200，避免积
  // 压很大时响应失控。listDreamRuns/listConflictPending 走 service 现成的审计
  // 只读通道（bookkeeping 语义，不触发写钩子）。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/dream-status",
    handler(req, res) {
      try {
        const runs = (service.listDreamRuns?.({ limit: 5 }) ?? []).map((r) => ({
          created_at: r.created_at,
          status: r.status,
          provider: r.provider ?? null,
          model: r.model ?? null,
          error: r.error ?? null,
          run_type: r.run_type ?? "auto",
          // sleep 审计：heat/时间分层降级决策计数（工作动态可展示"降级 N 条"）。
          // 数据来自 runSleep 写入的 decisions.demotion（{demoted,archived} 数组）。
          demotion: r.decisions?.demotion
            ? { demoted: (r.decisions.demotion.demoted ?? []).length, archived: (r.decisions.demotion.archived ?? []).length }
            : null
        }));
        const pendingConflicts = service.countConflictPending?.() ?? 0;
        const ids = new Set();
        for (const row of service.listConflictPending?.({ limit: 200, includeResolved: false }) ?? []) {
          if (ids.size >= 200) break;
          if (row.memory_a) ids.add(row.memory_a);
          if (ids.size >= 200) break;
          if (row.memory_b) ids.add(row.memory_b);
        }
        sendJson(res, 200, {
          lastRun: runs[0] ?? null,
          runs,
          pendingConflicts,
          pendingMemoryIds: [...ids].slice(0, 200)
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

  // --- panel mode (v0.7.12): light / standard -------------------------------
  // Persists the Web panel's feature preset into the settings kv
  // ("panel_mode"). PUT requires auth like every other settings write; the
  // value is validated against the enum. index.js applies the light preset on
  // the next boot (persisted mode wins over the bundle config).
  register({
    kind: "exact",
    path: "/api/dsh-mneme/mode",
    handler(req, res) {
      try {
        if (req.method === "PUT" || req.method === "POST") {
          if (!requireAuth(req, res, apiToken)) return;
          return readBody(req).then((text) => {
            const body = parseBody(text);
            if (body.mode !== "light" && body.mode !== "standard") {
              sendJson(res, 400, { error: "invalid-mode" });
              return;
            }
            settings.setPanelMode(body.mode);
            sendJson(res, 200, { mode: settings.getPanelMode() });
          });
        }
        sendJson(res, 200, { mode: settings.getPanelMode() });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- external API settings (the standalone server's panel-facing config) ---
  register({
    kind: "exact",
    path: "/api/dsh-mneme/external-api",
    handler(req, res) {
      try {
        if (req.method === "PUT" || req.method === "POST") {
          if (!requireAuth(req, res, apiToken)) return;
          return readBody(req).then((text) => {
            const body = parseBody(text);
            const patch = {};
            if (body.enabled !== undefined) patch.enabled = body.enabled === true;
            if (body.port !== undefined) {
              const port = Number(body.port);
              if (!Number.isInteger(port) || port < 1 || port > 65535) {
                sendJson(res, 400, { error: "invalid-port" });
                return;
              }
              patch.port = port;
            }
            if (body.host !== undefined) {
              const host = String(body.host).trim();
              if (!host || host.includes("://")) {
                sendJson(res, 400, { error: "invalid-host" });
                return;
              }
              patch.host = host;
            }
            sendJson(res, 200, { config: fullExternalConfig(settings.setExternalApi(patch)) });
          });
        }
        // GET: always hand back a token — the standalone server generates its
        // own on first enabled boot, but the panel displays it before that,
        // so materialize and persist one here.
        const kv = settings.getExternalApi() ?? {};
        if (!kv.token) {
          kv.token = randomBytes(24).toString("base64url");
          settings.setExternalApi({ token: kv.token });
        }
        sendJson(res, 200, { config: fullExternalConfig(kv) });
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });

  // --- feature flags（功能开关：面板逐项开关后端能力）-------------------------
  // 读路由保持开放（与 mode/list 一致），前端无需 token 即可渲染开关状态；PUT
  // 与其他设置写一致走 requireAuth。空/非对象 patch 直接 400：它不携带任何
  // 意图，静默成功只会掩盖前端 bug。校验失败（未知键/类型/越界）的 400 把键
  // 名放进 error，前端能直接定位写坏的开关。生效节奏与 panel_mode 相同：
  // 持久化后下次启动合并进 cfg，本次启动的运行时行为不变。
  register({
    kind: "exact",
    path: "/api/dsh-mneme/features",
    handler(req, res) {
      try {
        if (req.method === "PUT" || req.method === "POST") {
          if (!requireAuth(req, res, apiToken)) return;
          return readBody(req).then((text) => {
            const body = parseBody(text);
            if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length === 0) {
              sendJson(res, 400, { error: "invalid-patch" });
              return;
            }
            try {
              settings.setFeatureFlags(body);
            } catch (error) {
              sendJson(res, 400, { error: error.message });
              return;
            }
            sendJson(res, 200, featureSnapshot());
          });
        }
        sendJson(res, 200, featureSnapshot());
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
    routes: 23,
    dispose: () => {
      for (const dispose of disposers) dispose();
    }
  };
}
