import { createHotMemory } from "./hot-memory.js";

// Best-effort extraction of the current user's latest message text from the
// live session, for semantic-first injection (Bug4). The system-prompt
// interpolator renders synchronously, so this walks the already-materialized
// session event log (same event shape summarize.js consumes) and returns the
// most recent human message. Any failure degrades to "" — the injector then
// falls back to the legacy rule-based pick, never breaking the render.
function lastUserQuery(ctx) {
  try {
    const events = ctx?.agent?.session?.events;
    if (!Array.isArray(events) || events.length === 0) return "";
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event?.type !== "user/message") continue;
      const kind = event.data?.source?.kind;
      if (kind !== undefined && kind !== "user") continue;
      const parts = event.data?.content;
      if (!Array.isArray(parts) || parts.length === 0) continue;
      return parts
        .map((p) => (typeof p === "string" ? p : p?.text ?? ""))
        .filter(Boolean)
        .join("\n")
        .slice(0, 500);
    }
  } catch { /* session internals unavailable: degrade to no query */ }
  return "";
}

// Hot-memory round extraction (v0.5.0 1.3): pairs each user/message with the
// next assistant reply from the materialized session log. Tolerates shapes
// where assistant events carry a different type tag — anything whose payload
// has content parts and is not a user message counts as a reply. Best-effort:
// returns [] on any failure, and the hot block simply does not render.
function extractRounds(ctx, maxRounds) {
  try {
    const events = ctx?.agent?.session?.events;
    if (!Array.isArray(events) || events.length === 0) return [];
    const rounds = [];
    let pendingQuery = null;
    const textOf = (event) => {
      const parts = event?.data?.content;
      if (!Array.isArray(parts)) return "";
      return parts
        .map((p) => (typeof p === "string" ? p : p?.text ?? ""))
        .filter(Boolean)
        .join("\n")
        .trim();
    };
    for (const event of events) {
      const kind = event?.data?.source?.kind;
      const isUser = event?.type === "user/message" && (kind === undefined || kind === "user");
      if (isUser) {
        if (pendingQuery) rounds.push({ query: pendingQuery, response: "" });
        pendingQuery = textOf(event).slice(0, 500);
        continue;
      }
      // Only assistant-originated events close a round; tool/system events
      // carrying text must not be mistaken for the model's reply.
      const isAssistant = typeof event?.type === "string" && event.type.includes("assistant")
        || kind === "assistant";
      const body = isAssistant ? textOf(event) : "";
      if (!body || !pendingQuery) continue;
      rounds.push({ query: pendingQuery, response: body.slice(0, 800) });
      pendingQuery = null;
    }
    if (pendingQuery) rounds.push({ query: pendingQuery, response: "" });
    return rounds.slice(-maxRounds);
  } catch {
    return [];
  }
}

export function createInjector(ctx, service, settings, config) {
  const maxItems = config.maxInjectedItems ?? 5;
  const threshold = config.importanceThreshold ?? 3;

  // Bug6: bound the injected memory block. Each entry's content is truncated to
  // MAX_CONTENT chars (trailing `…`); the whole block gets a MAX_BLOCK budget
  // and an entry that would exceed it collapses to its title only, so a long
  // memory can never push the injected context past a few thousand chars.
  const MAX_CONTENT = 300;
  const MAX_BLOCK = 1500;

  // Compressed injection (v0.5.0 2.1): a sleep-demoted row already carries its
  // summary in `content` with the original parked in `_full_content` — inject
  // the summary verbatim instead of re-truncating the (already short) text.
  // Regular long rows keep the hard truncate.
  function injectMemory(m, maxLength = MAX_CONTENT) {
    if (m?._full_content) return String(m.content ?? "");
    const text = String(m?.content ?? "");
    return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
  }

  // Hot memory (v0.5.0 1.3): the latest rounds of THIS session, rebuilt from
  // the materialized event log on every render — stateless, so it survives
  // session switches and never persists anywhere.
  const hot = createHotMemory({
    maxRounds: config.hotMemoryRounds ?? 5,
    maxTokens: config.hotMemoryMaxTokens ?? 2000
  });

  function renderHotContext(ctx) {
    if (config.hotMemoryEnabled === false) return "";
    const rounds = extractRounds(ctx, config.hotMemoryRounds ?? 5);
    if (!rounds.length) return "";
    hot.clear();
    for (const r of rounds) hot.add(r);
    const body = hot.getContext();
    if (!body) return "";
    return `[短期上下文] 最近对话（共 ${rounds.length} 轮）：\n${body}`;
  }

  function render(candidates) {
    if (!candidates.length) return "";
    const header = "[记忆库] 来自 dsh-mneme 的跨会话记忆（用户偏好与高优先级项目/决策）：";
    const lines = [header];
    let budget = MAX_BLOCK - header.length;
    for (const m of candidates) {
      // Epistemic trust (v0.4.5): when enabled, measured observations are
      // flagged so the agent can weigh them above guesses/opinions.
      const verified = config.trustEpistemicWeighting === true && m.epistemic_status === "observation"
        ? "[verified] "
        : "";
      const title = `${m.title}（重要性 ${m.importance}）`;
      const content = injectMemory(m);
      const full = `- [${m.type}] ${verified}${title}：${content}`;
      if (budget - full.length >= 0) {
        lines.push(full);
        budget -= full.length;
      } else {
        lines.push(`- [${m.type}] ${verified}${title}`);
      }
    }
    return lines.join("\n");
  }

  // Bug4: the system-prompt render is synchronous, so the semantic query vector
  // must be prefetched asynchronously and cached for the next assembly. The
  // first render after a new user message may still fall back to the rule-based
  // pick; later assemblies in the same session reuse the cached vector. Bounded
  // cache (cap 8, drop oldest) so a long session never grows it unbounded.
  const QUERY_VECTOR_CACHE_MAX = 8;
  const queryVectorCache = new Map();
  let lastPrefetched = "";

  function prefetchQueryVector(query) {
    if (!query || query === lastPrefetched || queryVectorCache.has(query)) return;
    lastPrefetched = query;
    service.embedQuery(query).then((vec) => {
      if (Array.isArray(vec) && vec.length) {
        queryVectorCache.set(query, vec);
        if (queryVectorCache.size > QUERY_VECTOR_CACHE_MAX) {
          queryVectorCache.delete(queryVectorCache.keys().next().value);
        }
      }
    }).catch(() => { /* prefetch is best-effort */ });
  }

  // User profile + rules: injected ahead of the memory block because they are
  // always-relevant instructions the agent should follow every turn.
  function renderUserSettings() {
    const profile = settings.getProfile().trim();
    const rules = settings.getRules();
    if (!profile && !rules.length) return "";
    const lines = ["[用户设置] 来自 dsh-mneme 的用户画像与规则："];
    if (profile) lines.push(`- 用户画像：${profile}`);
    for (const rule of rules) lines.push(`- 规则：${rule}`);
    return lines.join("\n");
  }

  const disposers = [
    ctx.systemPrompt.context({
      name: "memory",
      order: 90,
      text: (ctx) => {
        // Bug4: pass the latest user query so injection prefers semantically
        // relevant memories; lastUserQuery is best-effort (empty → legacy).
        // The query vector is prefetched asynchronously (cached) because the
        // render itself must stay synchronous.
        const query = lastUserQuery(ctx);
        if (query) prefetchQueryVector(query);
        const queryVector = queryVectorCache.get(query);
        const candidates = service.injectCandidates({ query, queryVector, maxItems, threshold });
        // Hot memory (v0.5.0 1.3) leads the single memory block: the agent
        // sees the short-term rounds first, then the cross-session recall —
        // the documented injection order 1→2. Folding it here (instead of a
        // separate context) keeps the prompt assembly stable at two blocks.
        const hotText = renderHotContext(ctx);
        const body = render(candidates);
        if (!hotText) return body;
        return body ? `${hotText}\n\n${body}` : hotText;
      }
    }),
    ctx.systemPrompt.context({
      name: "user-settings",
      order: 85,
      text: renderUserSettings
    })
  ];

  return () => {
    queryVectorCache.clear();
    for (const dispose of disposers) {
      if (typeof dispose === "function") dispose();
    }
  };
}
