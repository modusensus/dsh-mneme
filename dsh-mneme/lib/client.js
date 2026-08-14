window.__ModuleLoader__.load({
  id: "@modusensus/dsh-mneme",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let react = require("react");
    let reactDom = require("react-dom");
    let { useState, useEffect, useCallback, useRef } = react;
    let { createPortal } = reactDom;

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
        "memory.tab.history": "历史",
        "memory.settings.open": "设置",
        "memory.settings.title": "记忆库设置",
        "memory.settings.profile": "用户画像",
        "memory.settings.profileHint": "描述你自己（角色、背景、偏好），Agent 会在每轮遵循",
        "memory.settings.profileSave": "保存画像",
        "memory.settings.profileSaved": "画像已保存",
        "memory.settings.rules": "规则",
        "memory.settings.rulesHint": "Agent 必须遵守的行为规则，每轮注入",
        "memory.settings.ruleAdd": "添加规则",
        "memory.settings.rulePlaceholder": "例如：回答时总是先给结论",
        "memory.settings.commands": "自定义指令",
        "memory.settings.commandsHint": "注册斜杠命令（/名称），触发时把指令内容交给 Agent",
        "memory.settings.cmdName": "命令名",
        "memory.settings.cmdDesc": "描述",
        "memory.settings.cmdInstruction": "指令内容",
        "memory.settings.cmdAdd": "添加命令",
        "memory.settings.cmdDelete": "删除",
        "memory.settings.empty": "暂无内容"
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
        "memory.tab.history": "History",
        "memory.settings.open": "Settings",
        "memory.settings.title": "Memory Settings",
        "memory.settings.profile": "User Profile",
        "memory.settings.profileHint": "Describe yourself — the agent follows this every turn",
        "memory.settings.profileSave": "Save Profile",
        "memory.settings.profileSaved": "Profile saved",
        "memory.settings.rules": "Rules",
        "memory.settings.rulesHint": "Behavior rules the agent must follow every turn",
        "memory.settings.ruleAdd": "Add Rule",
        "memory.settings.rulePlaceholder": "e.g. Always lead with a conclusion",
        "memory.settings.commands": "Custom Commands",
        "memory.settings.commandsHint": "Register slash commands (/name) whose instruction is handed to the agent",
        "memory.settings.cmdName": "Name",
        "memory.settings.cmdDesc": "Description",
        "memory.settings.cmdInstruction": "Instruction",
        "memory.settings.cmdAdd": "Add Command",
        "memory.settings.cmdDelete": "Delete",
        "memory.settings.empty": "Nothing yet"
      }
    };

    function typeLabel(t, type) {
      const key = `memory.tab.${type}`;
      const label = t(key);
      return label && label !== key ? label : String(type);
    }

    function formatDate(value) {
      if (!value) return "—";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
    }

    function MemoryPanel({ t, onClose }) {
      const [tab, setTab] = useState("all");
      const [query, setQuery] = useState("");
      const [items, setItems] = useState([]);
      const [loading, setLoading] = useState(false);
      const abortRef = useRef(null);

      const load = useCallback(async () => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setLoading(true);
        try {
          const params = new URLSearchParams();
          if (tab !== "all") params.set("type", tab);
          const url = query.trim()
            ? `/api/dsh-mneme/search?q=${encodeURIComponent(query.trim())}`
            : `/api/dsh-mneme/list?${params.toString()}`;
          const res = await fetch(url, { signal: controller.signal });
          const data = await res.json();
          setItems(data.items || []);
        } catch (error) {
          if (error.name === "AbortError") return;
          setItems([]);
        } finally {
          setLoading(false);
        }
      }, [tab, query]);

      useEffect(() => {
        load();
        return () => abortRef.current?.abort();
      }, [load]);

      const tabs = ["all", "preference", "project", "decision", "history"];

      return createPortal(
        react.createElement("div", { style: styles.overlay },
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
                            `${typeLabel(t, item.type)} · ★${item.importance}`
                          )
                        ),
                        react.createElement("div", { style: styles.cardContent }, item.content),
                        react.createElement("div", { style: styles.cardMeta },
                          formatDate(item.updated_at)
                        )
                      )
                    )
            )
          )
        ),
        document.body
      );
    }

    const h = react.createElement;

    // --- Settings panel: user profile, rules, custom commands ---
    function SettingsPanel({ t, onClose }) {
      const [profile, setProfile] = react.useState("");
      const [rules, setRules] = react.useState([]);
      const [commands, setCommands] = react.useState([]);
      const [newRule, setNewRule] = react.useState("");
      const [newCmd, setNewCmd] = react.useState({ name: "", description: "", instruction: "" });
      const [saved, setSaved] = react.useState(false);
      const [cmdError, setCmdError] = react.useState("");

      const load = react.useCallback(async () => {
        try {
          const [p, r, c] = await Promise.all([
            fetch("/api/dsh-mneme/profile").then((res) => res.json()),
            fetch("/api/dsh-mneme/rules").then((res) => res.json()),
            fetch("/api/dsh-mneme/commands").then((res) => res.json())
          ]);
          setProfile(p.profile || "");
          setRules(Array.isArray(r.rules) ? r.rules : []);
          setCommands(Array.isArray(c.commands) ? c.commands : []);
        } catch { /* ignore */ }
      }, []);

      react.useEffect(() => { load(); }, [load]);

      async function saveProfile() {
        try {
          await fetch("/api/dsh-mneme/profile", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profile })
          });
          setSaved(true);
          setTimeout(() => setSaved(false), 1500);
        } catch { /* ignore */ }
      }

      async function putRules(next) {
        await fetch("/api/dsh-mneme/rules", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rules: next })
        });
      }

      async function addRule() {
        const text = newRule.trim();
        if (!text) return;
        const next = [...rules, text];
        await putRules(next);
        setRules(next);
        setNewRule("");
      }

      async function removeRule(index) {
        const next = rules.filter((_, i) => i !== index);
        await putRules(next);
        setRules(next);
      }

      async function addCommand() {
        const name = newCmd.name.trim();
        const instruction = newCmd.instruction.trim();
        if (!name || !instruction) return;
        try {
          const res = await fetch("/api/dsh-mneme/commands", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, description: newCmd.description, instruction })
          });
          const data = await res.json();
          if (!res.ok) { setCmdError(data.error || "failed"); return; }
          setCmdError("");
          setCommands([...commands, data.command]);
          setNewCmd({ name: "", description: "", instruction: "" });
        } catch { setCmdError("failed"); }
      }

      async function removeCommand(id) {
        await fetch(`/api/dsh-mneme/commands?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        setCommands(commands.filter((c) => c.id !== id));
      }

      const inputStyle = { ...styles.search, marginBottom: 8 };
      const labelStyle = { fontSize: 12, fontWeight: 600, margin: "12px 0 4px" };
      const hintStyle = { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #999)", marginBottom: 8 };
      const rowStyle = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--dsw-alias-border-l1, #eee)" };

      return createPortal(
        h("div", { style: styles.overlay },
          h("div", { style: styles.panel },
            h("div", { style: styles.header },
              h("span", { style: styles.title }, t("memory.settings.title")),
              h("button", { style: styles.close, onClick: onClose }, "×")
            ),
            h("div", { style: { overflowY: "auto" } },
              // profile
              h("div", { style: labelStyle }, t("memory.settings.profile")),
              h("div", { style: hintStyle }, t("memory.settings.profileHint")),
              h("textarea", {
                style: { ...inputStyle, minHeight: 72, resize: "vertical", fontFamily: "inherit" },
                value: profile,
                placeholder: t("memory.settings.profile"),
                onChange: (e) => setProfile(e.target.value)
              }),
              h("div", null,
                h("button", { style: styles.footerButton, onClick: saveProfile }, t("memory.settings.profileSave")),
                saved && h("span", { style: { fontSize: 12, color: "var(--dsw-alias-state-success, #2a7)" } }, t("memory.settings.profileSaved"))
              ),
              // rules
              h("div", { style: labelStyle }, t("memory.settings.rules")),
              h("div", { style: hintStyle }, t("memory.settings.rulesHint")),
              rules.length === 0 && h("div", { style: styles.hint }, t("memory.settings.empty")),
              rules.map((rule, i) =>
                h("div", { key: i, style: rowStyle },
                  h("span", { style: { fontSize: 13, flex: 1 } }, rule),
                  h("button", { style: { ...styles.footerButton, color: "var(--dsw-alias-state-error, #c33)" }, onClick: () => removeRule(i) }, "×")
                )
              ),
              h("div", { style: { display: "flex", gap: 6 } },
                h("input", {
                  style: { ...inputStyle, flex: 1, marginBottom: 0 },
                  value: newRule,
                  placeholder: t("memory.settings.rulePlaceholder"),
                  onChange: (e) => setNewRule(e.target.value)
                }),
                h("button", { style: styles.footerButton, onClick: addRule }, t("memory.settings.ruleAdd"))
              ),
              // custom commands
              h("div", { style: labelStyle }, t("memory.settings.commands")),
              h("div", { style: hintStyle }, t("memory.settings.commandsHint")),
              commands.length === 0 && h("div", { style: styles.hint }, t("memory.settings.empty")),
              commands.map((cmd) =>
                h("div", { key: cmd.id, style: rowStyle },
                  h("div", { style: { flex: 1 } },
                    h("div", { style: { fontSize: 13, fontWeight: 600 } }, `/${cmd.name}`),
                    h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #999)" } }, cmd.description || cmd.instruction)
                  ),
                  h("button", { style: { ...styles.footerButton, color: "var(--dsw-alias-state-error, #c33)" }, onClick: () => removeCommand(cmd.id) }, t("memory.settings.cmdDelete"))
                )
              ),
              h("div", { style: { display: "grid", gap: 6, marginTop: 6 } },
                h("input", { style: { ...inputStyle, marginBottom: 0 }, value: newCmd.name, placeholder: t("memory.settings.cmdName"), onChange: (e) => setNewCmd({ ...newCmd, name: e.target.value }) }),
                h("input", { style: { ...inputStyle, marginBottom: 0 }, value: newCmd.description, placeholder: t("memory.settings.cmdDesc"), onChange: (e) => setNewCmd({ ...newCmd, description: e.target.value }) }),
                h("textarea", { style: { ...inputStyle, marginBottom: 0, minHeight: 48, resize: "vertical", fontFamily: "inherit" }, value: newCmd.instruction, placeholder: t("memory.settings.cmdInstruction"), onChange: (e) => setNewCmd({ ...newCmd, instruction: e.target.value }) }),
                h("button", { style: styles.footerButton, onClick: addCommand }, t("memory.settings.cmdAdd")),
                cmdError && h("div", { style: { fontSize: 12, color: "var(--dsw-alias-state-error, #c33)" } }, cmdError)
              )
            )
          )
        ),
        document.body
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
      ctx.effect(() => ctx.locale.register(NS, dictionaries), "dsh-mneme: dictionaries");

      ctx.effect(() => {
        const t = ctx.locale.bind(NS);
        return ctx.slots.inject("sidebar.footer.action", () =>
          ctx.slots.register({
            name: "sidebar.footer.action",
            id: "memory",
            locale: NS,
            inject: () => ({})
          }, () => {
            const [open, setOpen] = react.useState(false);
            const [openSettings, setOpenSettings] = react.useState(false);
            return react.createElement(react.Fragment, null,
              react.createElement("button", {
                onClick: () => setOpen(true),
                style: { ...styles.footerButton, ...(open ? styles.footerButtonActive : {}) }
              }, t("memory.panel.open")),
              react.createElement("button", {
                onClick: () => setOpenSettings(true),
                style: { ...styles.footerButton, ...(openSettings ? styles.footerButtonActive : {}) }
              }, t("memory.settings.open")),
              open && react.createElement(MemoryPanel, { t, onClose: () => setOpen(false) }),
              openSettings && react.createElement(SettingsPanel, { t, onClose: () => setOpenSettings(false) })
            );
          })
        );
      }, "dsh-mneme: sidebar action");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
