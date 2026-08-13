export function createInjector(ctx, service, config) {
  const maxItems = config.maxInjectedItems ?? 5;
  const threshold = config.importanceThreshold ?? 3;

  function render(candidates) {
    if (!candidates.length) return "";
    const lines = ["[记忆库] 来自 dsh-memory 的跨会话记忆（用户偏好与高优先级项目/决策）："];
    for (const m of candidates) {
      lines.push(`- [${m.type}] ${m.title}（重要性 ${m.importance}）：${m.content}`);
    }
    return lines.join("\n");
  }

  return ctx.systemPrompt.context({
    name: "memory",
    order: 90,
    text: () => {
      const candidates = service.injectCandidates({ maxItems, threshold });
      return render(candidates);
    }
  });
}
