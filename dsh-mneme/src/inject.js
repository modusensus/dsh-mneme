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

export function createInjector(ctx, service, settings, config) {
  const maxItems = config.maxInjectedItems ?? 5;
  const threshold = config.importanceThreshold ?? 3;

  // Bug6: bound the injected memory block. Each entry's content is truncated to
  // MAX_CONTENT chars (trailing `…`); the whole block gets a MAX_BLOCK budget
  // and an entry that would exceed it collapses to its title only, so a long
  // memory can never push the injected context past a few thousand chars.
  const MAX_CONTENT = 300;
  const MAX_BLOCK = 1500;

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
      let content = String(m.content ?? "");
      if (content.length > MAX_CONTENT) content = `${content.slice(0, MAX_CONTENT)}…`;
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
        return render(candidates);
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
