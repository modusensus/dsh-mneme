export function createInjector(ctx, service, settings, config) {
  const maxItems = config.maxInjectedItems ?? 5;
  const threshold = config.importanceThreshold ?? 3;

  function render(candidates) {
    if (!candidates.length) return "";
    const lines = ["[记忆库] 来自 dsh-mneme 的跨会话记忆（用户偏好与高优先级项目/决策）："];
    for (const m of candidates) {
      lines.push(`- [${m.type}] ${m.title}（重要性 ${m.importance}）：${m.content}`);
    }
    return lines.join("\n");
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
      text: () => {
        const candidates = service.injectCandidates({ maxItems, threshold });
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
    for (const dispose of disposers) {
      if (typeof dispose === "function") dispose();
    }
  };
}
