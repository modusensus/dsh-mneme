window.__ModuleLoader__.load({
  id: "dsh-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let react = require("react");
    let { useState, useEffect, useCallback } = react;

    const inject = ["slots", "locale"];

    const NS = "memory";

    const dictionaries = {
      zh: {
        "memory.panel.title": "记忆库",
        "memory.panel.search": "搜索记忆…",
        "memory.panel.empty": "暂无记忆条目",
        "memory.panel.open": "记忆",
        "memory.tab.all": "全部",
        "memory.tab.preference": "偏好",
        "memory.tab.project": "项目",
        "memory.tab.decision": "决策",
        "memory.tab.history": "历史"
      },
      en: {
        "memory.panel.title": "Memory",
        "memory.panel.search": "Search memories…",
        "memory.panel.empty": "No memories yet",
        "memory.panel.open": "Memory",
        "memory.tab.all": "All",
        "memory.tab.preference": "Preferences",
        "memory.tab.project": "Projects",
        "memory.tab.decision": "Decisions",
        "memory.tab.history": "History"
      }
    };

    function MemoryPanel({ t, onClose }) {
      const [tab, setTab] = useState("all");
      const [query, setQuery] = useState("");
      const [items, setItems] = useState([]);
      const [loading, setLoading] = useState(false);

      const load = useCallback(async () => {
        setLoading(true);
        try {
          const params = new URLSearchParams();
          if (tab !== "all") params.set("type", tab);
          if (query.trim()) {
            const res = await fetch(`/api/dsh-memory/search?q=${encodeURIComponent(query.trim())}`);
            const data = await res.json();
            setItems(data.items || []);
          } else {
            const res = await fetch(`/api/dsh-memory/list?${params.toString()}`);
            const data = await res.json();
            setItems(data.items || []);
          }
        } catch (error) {
          setItems([]);
        } finally {
          setLoading(false);
        }
      }, [tab, query]);

      useEffect(() => { load(); }, [load]);

      const tabs = ["all", "preference", "project", "decision", "history"];

      return react.createElement("div", { style: styles.overlay },
        react.createElement("div", { style: styles.panel },
          react.createElement("div", { style: styles.header },
            react.createElement("span", { style: styles.title }, t("memory.panel.title")),
            react.createElement("button", { style: styles.close, onClick: onClose }, "×")
          ),
          react.createElement("input", {
            style: styles.search,
            placeholder: t("memory.panel.search"),
            value: query,
            onChange: (e) => setQuery(e.target.value)
          }),
          react.createElement("div", { style: styles.tabs },
            tabs.map((key) =>
              react.createElement("button", {
                key,
                style: { ...styles.tab, ...(tab === key ? styles.tabActive : {}) },
                onClick: () => setTab(key)
              }, t(`memory.tab.${key}`))
            )
          ),
          react.createElement("div", { style: styles.list },
            loading
              ? react.createElement("div", { style: styles.hint }, "…")
              : items.length === 0
                ? react.createElement("div", { style: styles.hint }, t("memory.panel.empty"))
                : items.map((item) =>
                    react.createElement("div", { key: item.id, style: styles.card },
                      react.createElement("div", { style: styles.cardTitle },
                        react.createElement("span", null, item.title),
                        react.createElement("span", { style: styles.badge },
                          `${t(`memory.tab.${item.type}`)} · ★${item.importance}`
                        )
                      ),
                      react.createElement("div", { style: styles.cardContent }, item.content),
                      react.createElement("div", { style: styles.cardMeta },
                        new Date(item.updated_at).toLocaleString()
                      )
                    )
                  )
          )
        )
      );
    }

    const styles = {
      overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" },
      panel: { background: "var(--dsw-alias-bg-base, #fff)", borderRadius: 12, width: 640, maxWidth: "90vw", maxHeight: "80vh", display: "flex", flexDirection: "column", padding: 16, boxShadow: "0 8px 40px rgba(0,0,0,0.2)" },
      header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
      title: { fontSize: 16, fontWeight: 600 },
      close: { border: "none", background: "none", fontSize: 20, cursor: "pointer", color: "var(--dsw-alias-label-secondary, #666)" },
      search: { padding: "8px 12px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, #ddd)", marginBottom: 12, fontSize: 14 },
      tabs: { display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" },
      tab: { padding: "4px 10px", borderRadius: 999, border: "1px solid var(--dsw-alias-border-l2, #ddd)", background: "none", cursor: "pointer", fontSize: 12 },
      tabActive: { background: "var(--dsw-alias-interactive-bg-active, #eee)" },
      list: { overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 },
      hint: { color: "var(--dsw-alias-label-tertiary, #999)", padding: "24px 0", textAlign: "center" },
      card: { border: "1px solid var(--dsw-alias-border-l1, #eee)", borderRadius: 8, padding: "10px 12px" },
      cardTitle: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, fontSize: 14, fontWeight: 600 },
      badge: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #999)" },
      cardContent: { fontSize: 13, color: "var(--dsw-alias-label-secondary, #555)", marginBottom: 4, whiteSpace: "pre-wrap", wordBreak: "break-word" },
      cardMeta: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #999)" },
      footerButton: { padding: "4px 10px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, #ddd)", background: "none", cursor: "pointer", fontSize: 12, margin: "2px 8px" },
      footerButtonActive: { background: "var(--dsw-alias-interactive-bg-active, #eee)" }
    };

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dictionaries), "dsh-memory: dictionaries");

      ctx.effect(() => {
        const t = ctx.locale.bind(NS);
        return ctx.slots.inject("sidebar.footer.action", () =>
          ctx.slots.register({
            name: "memory",
            locale: NS,
            children: {},
            inject: () => ({})
          }, () => {
            const [open, setOpen] = react.useState(false);
            return react.createElement(react.Fragment, null,
              react.createElement("button", {
                onClick: () => setOpen(true),
                style: { ...styles.footerButton, ...(open ? styles.footerButtonActive : {}) }
              }, t("memory.panel.open")),
              open && react.createElement(MemoryPanel, { t, onClose: () => setOpen(false) })
            );
          })
        );
      }, "dsh-memory: sidebar action");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
