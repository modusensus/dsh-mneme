window.__ModuleLoader__.load({
  id: "@modusensus/dsh-mneme",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let react = require("react");
    let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    let { useState, useEffect, useCallback, useRef } = react;
    const IconArchiveOutline20 = primitives.IconArchiveOutline20;

    // Portal target for the hero fallback surface. The host whitelists
    // react-dom for its own bundles (dsh-client-ui-trajectory requires it);
    // when the runtime rejects it for plugins the overlay renders in place —
    // position:fixed keeps it viewport-sized either way.
    let reactDom = null;
    try { reactDom = require("react-dom"); } catch { reactDom = null; }

    // Node-graph pictogram (three nodes joined by edges). The primitives kit
    // ships no network/graph icon, and its share-style glyph reads as
    // "share" — exactly the confusion this custom 16px replacement avoids.
    const GraphNodesIcon = ({ size = 16, className }) => h("svg", {
      width: size,
      height: size,
      className,
      viewBox: "0 0 16 16",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg"
    },
      h("path", {
        d: "M8 5.2 4.6 10.4M8 5.2l3.4 5.2M5.2 12h5.6",
        stroke: "currentColor",
        strokeWidth: "1.2",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }),
      h("circle", { cx: 8, cy: 3.4, r: 1.8, fill: "currentColor" }),
      h("circle", { cx: 3.6, cy: 12, r: 1.8, fill: "currentColor" }),
      h("circle", { cx: 12.4, cy: 12, r: 1.8, fill: "currentColor" })
    );

    // Unified API fetcher: attaches the optional apiToken (set in the settings
    // view, persisted in localStorage) as a Bearer header. When no token has
    // been configured the header is omitted and the API stays open (default).
    const API_TOKEN_KEY = "dsh-mneme-api-token";
    function apiFetch(path, opts = {}) {
      const token = (typeof window !== "undefined" && window.localStorage)
        ? window.localStorage.getItem(API_TOKEN_KEY) || ""
        : "";
      const headers = { ...(opts.headers || {}) };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      return fetch(path, { ...opts, headers });
    }

    const inject = ["slots", "locale"];

    const NS = "memory";

    const dictionaries = {
      zh: {
        "memory.panel.empty": "暂无记忆条目",
        "memory.panel.open": "记忆",
        "memory.tab.all": "全部",
        "memory.tab.preference": "偏好",
        "memory.tab.project": "项目",
        "memory.tab.decision": "决策",
        "memory.tab.history": "历史",
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
        "memory.settings.empty": "暂无内容",
        "memory.panel.semantic": "语义",
        "memory.sidebar.aria": "打开记忆库",
        "memory.view.label": "记忆库",
        "memory.overlay.close": "关闭",
        "memory.explorer.tabMemory": "记忆",
        "memory.explorer.tabGraph": "图谱",
        "memory.explorer.tabSettings": "设置",
        "memory.explorer.search": "搜索标题或内容…",
        "memory.explorer.searchTitle": "语义检索",
        "memory.explorer.types": "分类",
        "memory.explorer.timeline": "时间树",
        "memory.explorer.detail": "详情",
        "memory.explorer.emptyDetail": "在时间树中选择一条记忆查看全文",
        "memory.explorer.copy": "复制全文",
        "memory.explorer.copied": "已复制",
        "memory.explorer.refresh": "刷新",
        "memory.explorer.count": "共 {n} 条",
        "memory.explorer.empty": "暂无记忆条目",
        "memory.explorer.source": "来源",
        "memory.explorer.created": "创建",
        "memory.explorer.updated": "更新",
        "memory.explorer.tags": "标签",
        "memory.explorer.tagAdd": "添加标签",
        "memory.explorer.tagRemove": "移除标签",
        "memory.explorer.tagPlaceholder": "输入标签，回车添加",
        "memory.explorer.tagsEmpty": "暂无标签",
        "memory.explorer.importance": "重要性",
        "memory.explorer.topK": "返回数量",
        "memory.explorer.topKOption": "返回 {n} 条",
        "memory.card.open": "在主区记忆库中查看全文",
        "memory.time.now": "刚刚",
        "memory.time.seconds": "{n}秒前",
        "memory.time.minutes": "{n}分钟前",
        "memory.time.hours": "{n}小时前",
        "memory.time.days": "{n}天前",
        "memory.graph.title": "记忆图谱",
        "memory.graph.aria": "记忆图谱",
        "memory.graph.placeholder": "输入实体名，查看关联网络…",
        "memory.graph.depth": "跳数",
        "memory.graph.empty": "图谱待积累：随对话记忆的沉淀，实体与关系会自动进入图谱",
        "memory.graph.notFound": "未找到该实体",
        "memory.graph.attrs": "属性",
        "memory.graph.related": "关联记忆",
        "memory.graph.relation": "关系",
        "memory.graph.sourceMemory": "查看来源记忆",
        "memory.graph.hint": "点击节点展开 · 拖拽调整布局",
        "memory.graph.viewInGraph": "在图谱中查看",
        "memory.graph.loading": "加载中…",
        "memory.graph.distance": "距中心 {n} 跳",
        "memory.settings.vectorTitle": "向量搜索",
        "memory.settings.vectorHint": "接入 OpenAI 兼容的 embeddings API 做语义搜索，可匹配字面不同但语义相近的记忆",
        "memory.settings.vectorEnabled": "启用向量搜索",
        "memory.settings.vectorBaseUrl": "API 地址 (Base URL)",
        "memory.settings.vectorApiKey": "API Key",
        "memory.settings.vectorModel": "模型名",
        "memory.settings.vectorSave": "保存配置",
        "memory.settings.vectorSaved": "配置已保存",
        "memory.settings.vectorReindex": "重建索引",
        "memory.settings.vectorReindexing": "索引中…",
        "memory.settings.vectorReindexDone": "已索引 {n} 条",
        "memory.settings.apiTokenTitle": "API Token（可选）",
        "memory.settings.apiTokenHint": "设置后，写操作与密钥接口（画像/规则/命令/向量配置）需携带 Authorization: Bearer <token>；面板只读操作不受影响。清空并保存可关闭鉴权。",
        "memory.settings.apiTokenPlaceholder": "留空 = 不鉴权（默认）",
        "memory.settings.apiTokenSave": "保存 Token",
        "memory.settings.apiTokenSaved": "Token 已保存",
        "memory.wikilink.backlinks": "链接到此记忆",
        "memory.wikilink.forward": "此记忆链接到",
        "memory.wikilink.empty": "暂无关联记忆",
        "memory.wikilink.loading": "加载中…",
        "memory.wikilink.unresolved": "目标记忆不存在"
      },
      en: {
        "memory.panel.empty": "No memories yet",
        "memory.panel.open": "Memory",
        "memory.tab.all": "All",
        "memory.tab.preference": "Preferences",
        "memory.tab.project": "Projects",
        "memory.tab.decision": "Decisions",
        "memory.tab.history": "History",
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
        "memory.settings.empty": "Nothing yet",
        "memory.panel.semantic": "Semantic",
        "memory.sidebar.aria": "Open memory panel",
        "memory.view.label": "Memory",
        "memory.overlay.close": "Close",
        "memory.explorer.tabMemory": "Memories",
        "memory.explorer.tabGraph": "Graph",
        "memory.explorer.tabSettings": "Settings",
        "memory.explorer.search": "Search title or content…",
        "memory.explorer.searchTitle": "Semantic Search",
        "memory.explorer.types": "Types",
        "memory.explorer.timeline": "Timeline",
        "memory.explorer.detail": "Details",
        "memory.explorer.emptyDetail": "Select a memory in the timeline to read it",
        "memory.explorer.copy": "Copy content",
        "memory.explorer.copied": "Copied",
        "memory.explorer.refresh": "Refresh",
        "memory.explorer.count": "{n} items",
        "memory.explorer.empty": "No memories yet",
        "memory.explorer.source": "Source",
        "memory.explorer.created": "Created",
        "memory.explorer.updated": "Updated",
        "memory.explorer.tags": "Tags",
        "memory.explorer.tagAdd": "Add tag",
        "memory.explorer.tagRemove": "Remove tag",
        "memory.explorer.tagPlaceholder": "Type a tag, press Enter",
        "memory.explorer.tagsEmpty": "No tags",
        "memory.explorer.importance": "Importance",
        "memory.explorer.topK": "Results limit",
        "memory.explorer.topKOption": "Return {n}",
        "memory.card.open": "Open full text in the Memory tab",
        "memory.time.now": "just now",
        "memory.time.seconds": "{n}s ago",
        "memory.time.minutes": "{n}m ago",
        "memory.time.hours": "{n}h ago",
        "memory.time.days": "{n}d ago",
        "memory.graph.title": "Memory Graph",
        "memory.graph.aria": "Memory graph",
        "memory.graph.placeholder": "Type an entity name to see its network…",
        "memory.graph.depth": "hops",
        "memory.graph.empty": "The graph is waiting for data: entities and relations accumulate as memories are extracted",
        "memory.graph.notFound": "Entity not found",
        "memory.graph.attrs": "Attributes",
        "memory.graph.related": "Related memories",
        "memory.graph.relation": "Relation",
        "memory.graph.sourceMemory": "View source memory",
        "memory.graph.hint": "Click a node to expand · drag to rearrange",
        "memory.graph.viewInGraph": "View in graph",
        "memory.graph.loading": "Loading…",
        "memory.graph.distance": "{n} hop(s) from root",
        "memory.settings.vectorTitle": "Vector Search",
        "memory.settings.vectorHint": "Connect an OpenAI-compatible embeddings API for semantic search by meaning, not just keywords",
        "memory.settings.vectorEnabled": "Enable vector search",
        "memory.settings.vectorBaseUrl": "Base URL",
        "memory.settings.vectorApiKey": "API Key",
        "memory.settings.vectorModel": "Model",
        "memory.settings.vectorSave": "Save Config",
        "memory.settings.vectorSaved": "Config saved",
        "memory.settings.vectorReindex": "Reindex",
        "memory.settings.vectorReindexing": "Indexing…",
        "memory.settings.vectorReindexDone": "Indexed {n} items",
        "memory.settings.apiTokenTitle": "API Token (optional)",
        "memory.settings.apiTokenHint": "When set, write operations and secret endpoints (profile/rules/commands/vector config) require Authorization: Bearer <token>. Read-only panel calls stay open. Save empty to disable.",
        "memory.settings.apiTokenPlaceholder": "Empty = no auth (default)",
        "memory.settings.apiTokenSave": "Save Token",
        "memory.settings.apiTokenSaved": "Token saved",
        "memory.wikilink.backlinks": "Links to this memory",
        "memory.wikilink.forward": "This memory links to",
        "memory.wikilink.empty": "No linked memories",
        "memory.wikilink.loading": "Loading…",
        "memory.wikilink.unresolved": "Target memory not found"
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

    // Relative time ("2分钟前") keeps cards scannable; anything older than a
    // week falls back to the absolute date. The card meta shows the relative
    // form and carries the full timestamp in a title tooltip.
    function formatRelativeTime(value, t) {
      if (!value) return "—";
      const ms = new Date(value).getTime();
      if (Number.isNaN(ms)) return "—";
      const diff = Date.now() - ms;
      if (diff < 60_000) return t("memory.time.now");
      const minutes = Math.floor(diff / 60_000);
      if (minutes < 60) return t("memory.time.minutes").replace("{n}", String(minutes));
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return t("memory.time.hours").replace("{n}", String(hours));
      const days = Math.floor(hours / 24);
      if (days < 7) return t("memory.time.days").replace("{n}", String(days));
      return new Date(ms).toLocaleDateString();
    }

    // Memory-library stylesheet, injected once per page following the host's
    // data-plugin-css convention. Every value resolves to the host's design
    // tokens: background layers, label/border/interactive aliases and the
    // --dsw-font-* scale, so the page reads as a first-party view beside
    // Chat / Trajectory (flat layer-1 canvas, hairline column separators,
    // text-turns-brand-blue active states — no boxed panels).
    const CSS_TAG = "@modusensus/dsh-mneme/drawer.css";
    const css = [
      // --- sidebar foot trigger (wide row / collapsed rail icon) ---
      ".mneme-trigger{box-sizing:border-box;cursor:pointer;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:12px;flex:none;align-items:center;gap:8px;margin:4px -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}",
      ".mneme-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-trigger.mneme-rail{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0}",
      ".mneme-trigger-label{white-space:nowrap;overflow:hidden}",
      // --- shared controls ---
      ".mneme-search{box-sizing:border-box;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;outline:none;transition:border-color .12s,box-shadow .12s}",
      ".mneme-search:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent)}",
      ".mneme-search::placeholder{color:var(--dsw-alias-label-tertiary)}",
      ".mneme-chip{height:26px;padding:0 10px;border-radius:8px;border:1px solid transparent;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:12px;line-height:16px;display:inline-flex;align-items:center}",
      ".mneme-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-chip.mneme-active{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}",
      ".mneme-select{box-sizing:border-box;height:30px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;outline:none}",
      ".mneme-footbtn{border:none;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:12px;line-height:16px;padding:3px 8px;border-radius:6px}",
      ".mneme-footbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".mneme-hint{color:var(--dsw-alias-label-tertiary);padding:24px 0;text-align:center;font-size:13px}",
      ".mneme-entitychip{flex:none;height:26px;padding:0 10px;border-radius:8px;border:none;background:none;color:var(--dsw-alias-state-business-primary);cursor:pointer;font-family:inherit;font-size:12px;line-height:16px;display:inline-flex;align-items:center}",
      ".mneme-entitychip:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}",
      // --- tag chips in the detail meta (v0.6.2) ---
      ".mneme-tagrow{display:flex;flex-wrap:wrap;gap:6px;align-items:center}",
      ".mneme-tagchip{display:inline-flex;align-items:center;gap:4px;max-width:100%;height:22px;padding:0 4px 0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-state-business-primary);cursor:pointer;font-family:inherit;font-size:12px;line-height:16px}",
      ".mneme-tagchip:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}",
      ".mneme-tagremove{flex:none;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border:none;border-radius:4px;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-family:inherit;font-size:12px;line-height:1;padding:0}",
      ".mneme-tagremove:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-tagadd{border:none;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:12px;line-height:16px;padding:2px 8px;border-radius:6px;flex:none}",
      ".mneme-tagadd:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".mneme-taginput{box-sizing:border-box;height:22px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;outline:none;width:150px}",
      ".mneme-taginput:focus{border-color:var(--dsw-alias-state-business-primary)}",
      ".mneme-tagempty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px}",
      // --- main-area memory library page ---
      ".mneme-x{flex:1;min-height:0;height:100%;width:100%;box-sizing:border-box;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}",
      ".mneme-xbar{flex:none;display:flex;align-items:center;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l2);padding:0 16px}",
      ".mneme-filterbar{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".mneme-vtabs{display:flex;align-items:stretch;height:38px}",
      ".mneme-vtab{position:relative;border:0;background:none;cursor:pointer;padding:0 10px;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:13px;font-weight:500;line-height:16px;display:inline-flex;align-items:center;gap:6px}",
      ".mneme-vtab:hover{color:var(--dsw-alias-label-primary)}",
      ".mneme-vtab.mneme-active{color:var(--dsw-alias-state-business-primary)}",
      ".mneme-vtab.mneme-active::after{content:\"\";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:2px;background:var(--dsw-alias-state-business-primary)}",
      ".mneme-xtools{margin-left:auto;display:flex;align-items:center;gap:8px;padding:0 0 0 12px}",
      ".mneme-xcount{flex:none;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
      // --- three-column browse layout: hairline separators, no outer box ---
      ".mneme-xmain{flex:1;min-height:0;display:flex;flex-direction:row;overflow:hidden}",
      ".mneme-xside{flex:none;width:236px;min-width:0;min-height:0;overflow-y:auto;padding:12px;border-right:1px solid var(--dsw-alias-border-l2);box-sizing:border-box;display:flex;flex-direction:column;gap:8px}",
      ".mneme-xside--filter{width:214px}",
      ".mneme-xbrowse{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}",
      ".mneme-xrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".mneme-xsearch{width:100%}",
      ".mneme-xselect{flex:1;min-width:0}",
      ".mneme-xcolhead{flex:none;font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:2px 8px 8px}",
      ".mneme-xtype{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;padding:5px 8px;border:none;border-radius:8px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:13px;line-height:18px;text-align:left}",
      ".mneme-xtype:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-xtype.mneme-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:500}",
      ".mneme-xcount2{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
      ".mneme-xmonth{display:flex;align-items:center;gap:4px;width:100%;padding:6px 8px 4px;border:none;border-radius:8px;background:none;color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;line-height:18px;text-align:left}",
      ".mneme-xmonth:first-child{margin-top:0}",
      ".mneme-xmonth:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-xcaret{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary);width:10px}",
      ".mneme-xday{display:flex;align-items:center;gap:4px;margin:6px 0 2px 22px;padding:2px 6px;border:none;border-radius:6px;background:none;font-family:inherit;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);cursor:pointer;text-align:left}",
      ".mneme-xday:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".mneme-xitem{display:flex;gap:8px;align-items:baseline;width:calc(100% - 22px);margin-left:22px;padding:4px 8px;border:none;border-radius:8px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:13px;line-height:18px;text-align:left}",
      ".mneme-xitem:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-xitem.mneme-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}",
      ".mneme-xtime{flex:none;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
      ".mneme-xname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".mneme-xempty{padding:32px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}",
      // --- detail column ---
      ".mneme-xdetail{flex:none;max-height:44%;min-height:0;overflow-y:auto;padding:14px 20px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".mneme-xtree{flex:1;min-height:0;overflow-y:auto;padding:8px 10px 28px}",
      ".mneme-xdinner{max-width:720px}",
      ".mneme-xdtitle{font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary);margin-bottom:10px;word-break:break-word}",
      ".mneme-xdmeta{display:flex;flex-wrap:wrap;gap:4px 14px;margin-bottom:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      ".mneme-xdcontent{margin-top:14px;font-size:14px;line-height:1.75;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}",
      ".mneme-xdactions{display:flex;gap:8px;margin-top:18px}",
      // --- wiki-link backlinks panel (detail pane footer) ---
      ".mneme-backlinks{margin-top:18px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:12px}",
      ".mneme-bl-block{display:flex;flex-direction:column;gap:4px}",
      ".mneme-bl-head{font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary)}",
      ".mneme-bl-list{display:flex;flex-wrap:wrap;gap:6px}",
      ".mneme-bl-link{display:inline-flex;align-items:center;gap:6px;max-width:100%;border:none;background:none;color:var(--dsw-alias-state-business-primary);cursor:pointer;font-family:inherit;font-size:13px;line-height:18px;padding:2px 8px;border-radius:6px;text-align:left}",
      ".mneme-bl-link:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}",
      ".mneme-bl-link.mneme-bl-link--dim{color:var(--dsw-alias-label-tertiary);cursor:default}",
      ".mneme-bl-link.mneme-bl-link--dim:hover{background:none}",
      ".mneme-bl-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".mneme-bl-meta{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      ".mneme-bl-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
      // --- inline [[wiki-link]] links inside the detail content ---
      ".mneme-wikilink{display:inline;padding:0 2px;border:none;background:none;color:var(--dsw-alias-state-business-primary);cursor:pointer;font-family:inherit;font-size:inherit;line-height:inherit;text-decoration:underline;text-underline-offset:2px;border-radius:3px}",
      ".mneme-wikilink:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent)}",
      // --- graph sub-view (fills the content area under the tabs) ---
      ".mneme-graph{flex:1;min-height:0;width:100%;display:flex;flex-direction:column;padding:12px 16px 16px;box-sizing:border-box}",
      ".mneme-graphbar{display:flex;gap:8px;align-items:center;flex:none;margin-bottom:10px}",
      ".mneme-graphsvg{flex:1;min-height:180px;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-button-elevated-fill);cursor:grab;touch-action:none}",
      ".mneme-gnode{cursor:pointer}",
      ".mneme-gnode circle{stroke:var(--dsw-alias-bg-layer-2);stroke-width:2;transition:stroke-width .12s}",
      ".mneme-gnode:hover circle{stroke-width:4}",
      ".mneme-gnode.mneme-groot circle{stroke:var(--dsw-alias-state-business-primary);stroke-width:3}",
      ".mneme-glabel{fill:var(--dsw-alias-label-secondary);font-size:11px;text-anchor:middle;pointer-events:none;user-select:none}",
      ".mneme-gedge{stroke:var(--dsw-alias-label-dimmed);stroke-width:1.5;cursor:pointer}",
      ".mneme-gedge:hover{stroke:var(--dsw-alias-state-business-primary)}",
      ".mneme-gedge-dashed{stroke-dasharray:5 4;opacity:.7}",
      ".mneme-graphhint{flex:none;color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center;padding:6px 0 2px}",
      ".mneme-graphside{flex:none;max-height:220px;overflow-y:auto;border-top:1px solid var(--dsw-alias-border-l1);margin-top:10px;padding-top:10px}",
      ".mneme-gs-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:4px;display:flex;justify-content:space-between;align-items:baseline;gap:8px}",
      ".mneme-gs-meta{font-size:13px;color:var(--dsw-alias-label-tertiary);margin-bottom:6px}",
      ".mneme-gs-attr{display:flex;gap:6px;font-size:13px;padding:2px 0}",
      ".mneme-gs-attrkey{flex:none;color:var(--dsw-alias-label-tertiary);font-size:13px}",
      ".mneme-gs-attrval{color:var(--dsw-alias-label-secondary);word-break:break-word;font-size:13px}",
      ".mneme-gs-link{display:block;width:100%;text-align:left;border:none;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:13px;padding:3px 6px;border-radius:6px;word-break:break-word}",
      ".mneme-gs-link:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      // --- settings sub-view ---
      ".mneme-xsettings{flex:1;min-height:0;overflow-y:auto;padding:24px 24px 48px}",
      ".mneme-xsettings-inner{max-width:640px}",
      // --- hero fallback: full-viewport memory library when no tab ring exists ---
      // The host hides the whole conversation tab ring while a session is
      // blank (hero screen), so the sidebar entry cannot activate the tab
      // there. This surface reuses the exact MemoryExplorer UI at full size —
      // not a side drawer — so the library stays reachable from any state.
      ".mneme-overlay{position:fixed;inset:0;z-index:1000;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);animation:mneme-fadein .12s ease-out}",
      ".mneme-overlaybar{flex:none;display:flex;align-items:center;justify-content:space-between;height:44px;padding:0 12px 0 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".mneme-overlaytitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".mneme-overlaybody{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}",
      "@keyframes mneme-fadein{from{opacity:0}to{opacity:1}}"
    ].join("\n");
    if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "@modusensus/dsh-mneme";
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    const h = react.createElement;

    // --- graph view constants ---
    // Entity type → node fill. The host has no palette token for categorical
    // data, so these are fixed hues tuned for both light and dark themes
    // (medium saturation, similar luminance).
    const TYPE_COLORS = {
      person: "#3b82f6",
      project: "#22c55e",
      concept: "#a855f7",
      technology: "#f59e0b",
      organization: "#06b6d4"
    };
    function typeColor(type) {
      return TYPE_COLORS[type] || "#94a3b8";
    }
    function nodeRadius(n) {
      // mention_count → area-ish growth, clamped so hubs stay legible.
      return 7 + Math.min(20, Math.max(1, n.mention_count ?? 1)) * 0.55;
    }

    // Deterministic golden-angle spiral: no two nodes start overlapping, and
    // re-running the layout for the same data is stable (no random seeding).
    function initialPositions(nodes, width, height) {
      const cx = width / 2;
      const cy = height / 2;
      return nodes.map((n, i) => {
        const r = i === 0 ? 0 : 34 + 13 * Math.sqrt(i);
        const a = i * 2.39996;
        return { ...n, x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), vx: 0, vy: 0, pinned: false };
      });
    }

    // --- wiki-link (v0.6.1) -------------------------------------------------
    // Splits detail content into literal text and clickable [[target]] /
    // [[display|target]] links. Mirrors src/parser/wiki-link.js: single pipe
    // only, empty / multi-pipe / unclosed markers stay literal text.
    function wikilinkSegments(text, onClick) {
      if (typeof text !== "string" || text.length === 0) return text;
      const out = [];
      let last = 0;
      let key = 0;
      const re = /\[\[([^\[\]]*)\]\]/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const parts = m[1].split("|");
        if (parts.length > 2) continue; // 多管道 → 非法，保留字面文本
        const target = (parts.length === 2 ? parts[1] : parts[0]).trim();
        if (!target) continue; // 空目标 → 非法
        if (m.index > last) out.push(text.slice(last, m.index));
        out.push(h("button", {
          key: `w${key++}`,
          type: "button",
          className: "mneme-wikilink",
          title: target,
          onClick: () => onClick(target)
        }, parts[0].trim() || target));
        last = m.index + m[0].length;
      }
      if (last < text.length) out.push(text.slice(last));
      return out.length ? out : text;
    }

    // Backlinks panel: the two wiki-link relation blocks under the detail pane.
    // Backlinks = memories whose content links to this one; forward = memories
    // this one links to (unresolved targets surface as dim, non-clickable).
    // Mounted per-selection (the surrounding Fragment keys on selected.id), so
    // state resets and the fetches re-run on every switch.
    function BacklinksPanel({ memory, t, onJump }) {
      const [back, setBack] = useState(null); // null = loading
      const [forward, setForward] = useState(null);

      useEffect(() => {
        let cancelled = false;
        if (!memory || !memory.id) return;
        apiFetch(`/api/dsh-mneme/wikilinks/backlinks?id=${encodeURIComponent(memory.id)}`)
          .then((r) => (r.ok ? r.json() : { backlinks: [] }))
          .then((j) => { if (!cancelled) setBack(Array.isArray(j.backlinks) ? j.backlinks : []); })
          .catch(() => { if (!cancelled) setBack([]); });
        apiFetch(`/api/dsh-mneme/wikilinks/forward?id=${encodeURIComponent(memory.id)}`)
          .then((r) => (r.ok ? r.json() : { links: [] }))
          .then((j) => { if (!cancelled) setForward(Array.isArray(j.links) ? j.links : []); })
          .catch(() => { if (!cancelled) setForward([]); });
        return () => { cancelled = true; };
      }, [memory && memory.id]);

      if (!memory || !memory.id) return null;

      const loading = back === null || forward === null;
      const row = (link, i) => {
        const canJump = !!link.id;
        return h("button", {
          key: link.id ?? `unresolved-${i}`,
          type: "button",
          className: canJump ? "mneme-bl-link" : "mneme-bl-link mneme-bl-link--dim",
          title: canJump ? t("memory.card.open") : t("memory.wikilink.unresolved"),
          disabled: !canJump,
          onClick: () => onJump && onJump({ id: link.id })
        },
          h("span", { className: "mneme-bl-title" }, link.title || "—"),
          link.type && h("span", { className: "mneme-bl-meta" }, typeLabel(t, link.type))
        );
      };
      const section = (label, items) =>
        h("div", { className: "mneme-bl-block" },
          h("div", { className: "mneme-bl-head" }, label),
          loading
            ? h("div", { className: "mneme-bl-empty" }, t("memory.wikilink.loading"))
            : items.length === 0
              ? h("div", { className: "mneme-bl-empty" }, t("memory.wikilink.empty"))
              : h("div", { className: "mneme-bl-list" }, items.map(row))
        );

      return h("div", { className: "mneme-backlinks" },
        section(t("memory.wikilink.backlinks"), back || []),
        section(t("memory.wikilink.forward"), forward || [])
      );
    }

    // --- Graph view: ego-graph of one entity, zero-dependency SVG force layout ---
    // The DSH client module table only whitelists platform modules, so a graph
    // library like vis-network cannot be required from a plugin. A hand-rolled
    // spring simulation (repulsion + edge springs + center gravity, damped) is
    // plenty for the ≤40 nodes the ego API returns.
    function GraphPanel({ t, focusEntity, onJumpMemory }) {
      const [entityName, setEntityName] = useState(focusEntity || "");
      const [inputValue, setInputValue] = useState(focusEntity || "");
      const [depth, setDepth] = useState(1);
      const [data, setData] = useState(null);
      const [status, setStatus] = useState("idle"); // idle | loading | ready | notfound | error
      const [selected, setSelected] = useState(null); // { kind: "node"|"edge", node?|edge? }
      const [attrs, setAttrs] = useState([]);
      const [related, setRelated] = useState([]);
      const svgRef = useRef(null);
      const posRef = useRef([]); // live simulation positions, not React state
      const dragRef = useRef(null); // { id, moved }
      const [frame, setFrame] = useState(0); // re-render tick driven by the simulation

      useEffect(() => {
        if (focusEntity && focusEntity !== entityName) {
          setEntityName(focusEntity);
          setInputValue(focusEntity);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [focusEntity]);

      const load = useCallback(async (name, d) => {
        if (!name) { setData(null); setStatus("idle"); return; }
        setStatus("loading");
        setSelected(null);
        try {
          const res = await apiFetch(`/api/dsh-mneme/semantic/graph/ego?entity=${encodeURIComponent(name)}&depth=${d}`);
          if (res.status === 404) { setData(null); setStatus("notfound"); return; }
          if (!res.ok) { setData(null); setStatus("error"); return; }
          const json = await res.json();
          setData(json);
          setStatus("ready");
        } catch {
          setData(null);
          setStatus("error");
        }
      }, []);

      useEffect(() => { load(entityName, depth); }, [load, entityName, depth]);

      // Detail pane: node → current attrs + entity: search for related memories.
      useEffect(() => {
        setAttrs([]);
        setRelated([]);
        if (!selected || selected.kind !== "node") return;
        const name = selected.node.name;
        let cancelled = false;
        apiFetch(`/api/dsh-mneme/semantic/graph/entity-attrs?entity=${encodeURIComponent(name)}`)
          .then((r) => (r.ok ? r.json() : { attrs: [] }))
          .then((j) => { if (!cancelled) setAttrs(Array.isArray(j.attrs) ? j.attrs : []); })
          .catch(() => {});
        apiFetch(`/api/dsh-mneme/search?q=${encodeURIComponent("entity:" + name)}&limit=10`)
          .then((r) => (r.ok ? r.json() : { items: [] }))
          .then((j) => { if (!cancelled) setRelated(Array.isArray(j.items) ? j.items : []); })
          .catch(() => {});
        return () => { cancelled = true; };
      }, [selected]);

      // Simulation: run in rAF against posRef, tick React only every few frames.
      // Re-seeds when data changes; dragging writes straight into posRef.
      useEffect(() => {
        if (!data || data.nodes.length === 0) return;
        const width = Math.max(280, svgRef.current?.clientWidth || 380);
        const height = 300;
        posRef.current = initialPositions(data.nodes, width, height);
        const byId = new Map(posRef.current.map((n) => [n.id, n]));
        const edges = data.edges;
        let raf = 0;
        let n = 0;
        const tick = () => {
          const nodes = posRef.current;
          // pairwise repulsion, capped so far nodes don't explode
          for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
              const a = nodes[i], b = nodes[j];
              let dx = b.x - a.x, dy = b.y - a.y;
              let d2 = dx * dx + dy * dy;
              if (d2 < 1) { dx = (Math.random() - 0.5) || 1; dy = (Math.random() - 0.5) || 1; d2 = dx * dx + dy * dy; }
              const d = Math.sqrt(d2);
              const f = Math.min(2200 / d2, 6);
              const fx = (dx / d) * f, fy = (dy / d) * f;
              a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
            }
          }
          // edge springs pull toward the target length
          for (const e of edges) {
            const a = byId.get(e.from), b = byId.get(e.to);
            if (!a || !b) continue;
            const dx = b.x - a.x, dy = b.y - a.y;
            const d = Math.sqrt(dx * dx + dy * dy) || 1;
            const f = (d - 90) * 0.02;
            const fx = (dx / d) * f, fy = (dy / d) * f;
            a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
          }
          let energy = 0;
          for (const node of nodes) {
            // gentle gravity toward center keeps the cloud from drifting off-canvas
            node.vx += (width / 2 - node.x) * 0.002;
            node.vy += (height / 2 - node.y) * 0.002;
            if (node.pinned || node === dragRef.current?.node) { node.vx = 0; node.vy = 0; continue; }
            node.vx *= 0.85; node.vy *= 0.85;
            node.x = Math.max(nodeRadius(node) + 4, Math.min(width - nodeRadius(node) - 4, node.x + node.vx));
            node.y = Math.max(nodeRadius(node) + 14, Math.min(height - nodeRadius(node) - 14, node.y + node.vy));
            energy += Math.abs(node.vx) + Math.abs(node.vy);
          }
          n++;
          if (n % 3 === 0) setFrame((f) => f + 1);
          if (n < 300 && energy > 0.4) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
      }, [data]);

      // drag handling on the svg surface
      const onNodeMouseDown = (e, node) => {
        e.preventDefault();
        dragRef.current = { node, moved: false };
        const startX = e.clientX, startY = e.clientY;
        const origX = node.x, origY = node.y;
        const svg = svgRef.current;
        const rect = svg.getBoundingClientRect();
        const scale = 380 / Math.max(1, rect.width); // viewBox width / css width
        const onMove = (ev) => {
          dragRef.current.moved = true;
          node.x = origX + (ev.clientX - startX) * scale;
          node.y = origY + (ev.clientY - startY) * scale;
          setFrame((f) => f + 1);
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          setTimeout(() => { dragRef.current = null; }, 0);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      };

      const onNodeClick = (node) => {
        if (dragRef.current?.moved) return; // it was a drag, not a click
        setSelected({ kind: "node", node });
      };
      const onEdgeClick = (edge) => setSelected({ kind: "edge", edge });

      const nodes = posRef.current;
      const nodeById = new Map(nodes.map((n) => [n.id, n]));
      const VIEW_W = 380, VIEW_H = 300;

      const side = selected?.kind === "node"
        ? h("div", { className: "mneme-graphside" },
            h("div", { className: "mneme-gs-title" },
              h("span", null, selected.node.name),
              h("span", { className: "mneme-gs-meta" },
                `${typeLabel(t, selected.node.type || "concept")} · ★${selected.node.mention_count ?? 1}`)
            ),
            attrs.length > 0 && h("div", null,
              h("div", { className: "mneme-gs-meta" }, t("memory.graph.attrs")),
              attrs.map((a, i) => h("div", { key: i, className: "mneme-gs-attr" },
                h("span", { className: "mneme-gs-attrkey" }, `${a.key}:`),
                h("span", { className: "mneme-gs-attrval" }, a.value)
              ))
            ),
            related.length > 0 && h("div", { style: { marginTop: 8 } },
              h("div", { className: "mneme-gs-meta" }, t("memory.graph.related")),
              related.map((m) => h("button", {
                key: m.id,
                type: "button",
                className: "mneme-gs-link",
                title: t("memory.card.open"),
                onClick: () => onJumpMemory && onJumpMemory(m)
              }, m.title || m.content?.slice(0, 60)))
            )
          )
        : selected?.kind === "edge"
          ? h("div", { className: "mneme-graphside" },
              h("div", { className: "mneme-gs-title" },
                h("span", null,
                  `${nodeById.get(selected.edge.from)?.name ?? "?"} → ${selected.edge.relation_type} → ${nodeById.get(selected.edge.to)?.name ?? "?"}`)
              ),
              h("div", { className: "mneme-gs-meta" },
                `${t("memory.graph.relation")} · ${formatRelativeTime(selected.edge.created_at, t)}`),
              selected.edge.memory_id && h("button", {
                className: "mneme-footbtn",
                onClick: () => onJumpMemory && onJumpMemory({ id: selected.edge.memory_id })
              }, t("memory.graph.sourceMemory"))
            )
          : null;

      return h("div", { className: "mneme-graph" },
        h("div", { className: "mneme-graphbar" },
          h("input", {
            className: "mneme-search",
            style: { flex: 1, minWidth: 0, maxWidth: 280 },
            placeholder: t("memory.graph.placeholder"),
            value: inputValue,
            onChange: (e) => setInputValue(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter") setEntityName(inputValue.trim()); }
          }),
          h("button", {
            className: depth === 2 ? "mneme-chip mneme-active" : "mneme-chip",
            title: t("memory.graph.depth"),
            onClick: () => setDepth(depth === 1 ? 2 : 1)
          }, `${depth} ${t("memory.graph.depth")}`)
        ),
        status === "idle" && h("div", { className: "mneme-hint" }, t("memory.graph.empty")),
        status === "loading" && h("div", { className: "mneme-hint" }, t("memory.graph.loading")),
        status === "notfound" && h("div", { className: "mneme-hint" }, t("memory.graph.notFound")),
        status === "error" && h("div", { className: "mneme-hint" }, t("memory.panel.empty")),
        status === "ready" && (data.nodes.length <= 1
          ? h("div", { className: "mneme-hint" }, t("memory.graph.empty"))
          : h(react.Fragment, null,
              h("svg", {
                ref: svgRef,
                className: "mneme-graphsvg",
                viewBox: `0 0 ${VIEW_W} ${VIEW_H}`
              },
                data.edges.map((e) => {
                  const a = nodeById.get(e.from), b = nodeById.get(e.to);
                  if (!a || !b) return null;
                  return h("line", {
                    key: e.id,
                    x1: a.x, y1: a.y, x2: b.x, y2: b.y,
                    className: e.memory_id ? "mneme-gedge" : "mneme-gedge mneme-gedge-dashed",
                    onClick: () => onEdgeClick(e)
                  });
                }),
                nodes.map((n) => h("g", {
                  key: n.id,
                  className: n.id === data.root.id ? "mneme-gnode mneme-groot" : "mneme-gnode",
                  transform: `translate(${n.x},${n.y})`,
                  onMouseDown: (e) => onNodeMouseDown(e, n),
                  onClick: () => onNodeClick(n),
                  "data-node": n.name
                },
                  h("circle", { r: nodeRadius(n), fill: typeColor(n.type) }),
                  h("text", { className: "mneme-glabel", y: nodeRadius(n) + 13 }, n.name)
                ))
              ),
              h("div", { className: "mneme-graphhint" }, t("memory.graph.hint"))
            )),
        side
      );
    }

    // --- Settings view: user profile, rules, custom commands, vector, token ---
    const styles = {
      footerButton: { padding: "4px 10px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, #ddd)", background: "none", cursor: "pointer", fontSize: 12, margin: "2px 8px", color: "var(--dsw-alias-label-secondary, #666)", fontFamily: "inherit" }
    };

    function SettingsContent({ t }) {
      const [profile, setProfile] = react.useState("");
      const [rules, setRules] = react.useState([]);
      const [commands, setCommands] = react.useState([]);
      const [newRule, setNewRule] = react.useState("");
      const [newCmd, setNewCmd] = react.useState({ name: "", description: "", instruction: "" });
      const [saved, setSaved] = react.useState(false);
      const [cmdError, setCmdError] = react.useState("");
      const [vector, setVector] = react.useState({ enabled: false, baseUrl: "", apiKey: "", model: "" });
      const [vectorSaved, setVectorSaved] = react.useState(false);
      const [reindexing, setReindexing] = react.useState(false);
      const [reindexMsg, setReindexMsg] = react.useState("");
      const [apiToken, setApiToken] = react.useState(() =>
        (typeof window !== "undefined" && window.localStorage) ? window.localStorage.getItem("dsh-mneme-api-token") || "" : ""
      );
      const [apiTokenSaved, setApiTokenSaved] = react.useState(false);

      const load = react.useCallback(async () => {
        try {
          const [p, r, c, v] = await Promise.all([
            apiFetch("/api/dsh-mneme/profile").then((res) => res.json()),
            apiFetch("/api/dsh-mneme/rules").then((res) => res.json()),
            apiFetch("/api/dsh-mneme/commands").then((res) => res.json()),
            apiFetch("/api/dsh-mneme/vector-config").then((res) => res.json())
          ]);
          setProfile(p.profile || "");
          setRules(Array.isArray(r.rules) ? r.rules : []);
          setCommands(Array.isArray(c.commands) ? c.commands : []);
          setVector(v.config || { enabled: false, baseUrl: "", apiKey: "", model: "" });
        } catch { /* ignore */ }
      }, []);

      react.useEffect(() => { load(); }, [load]);

      async function saveProfile() {
        try {
          await apiFetch("/api/dsh-mneme/profile", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ profile })
          });
          setSaved(true);
          setTimeout(() => setSaved(false), 1500);
        } catch { /* ignore */ }
      }

      async function putRules(next) {
        await apiFetch("/api/dsh-mneme/rules", {
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
          const res = await apiFetch("/api/dsh-mneme/commands", {
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
        await apiFetch(`/api/dsh-mneme/commands?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        setCommands(commands.filter((c) => c.id !== id));
      }

      async function saveVector() {
        try {
          await apiFetch("/api/dsh-mneme/vector-config", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(vector)
          });
          setVectorSaved(true);
          setTimeout(() => setVectorSaved(false), 1500);
        } catch { /* ignore */ }
      }

      async function reindex() {
        setReindexing(true);
        setReindexMsg("");
        try {
          const res = await apiFetch("/api/dsh-mneme/vector-reindex");
          const data = await res.json();
          const n = data.indexed ?? 0;
          setReindexMsg(t("memory.settings.vectorReindexDone").replace("{n}", String(n)));
        } catch { setReindexMsg(""); }
        setReindexing(false);
      }

      function saveToken() {
        try {
          if (apiToken.trim()) window.localStorage.setItem("dsh-mneme-api-token", apiToken.trim());
          else window.localStorage.removeItem("dsh-mneme-api-token");
          setApiTokenSaved(true);
          setTimeout(() => setApiTokenSaved(false), 1500);
        } catch { /* ignore */ }
      }

      const inputStyle = { boxSizing: "border-box", width: "100%", height: 34, padding: "0 12px", borderRadius: 10, border: "1px solid var(--dsw-alias-border-l2, #ddd)", background: "var(--dsw-alias-bg-base, transparent)", color: "var(--dsw-alias-label-primary)", fontFamily: "inherit", fontSize: 13, outline: "none", marginBottom: 8 };
      const labelStyle = { fontSize: 12, fontWeight: 600, margin: "12px 0 4px", color: "var(--dsw-alias-label-primary)" };
      const hintStyle = { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #999)", marginBottom: 8 };
      const rowStyle = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--dsw-alias-border-l1, #eee)" };

      return h("div", { style: { paddingBottom: 8 } },
        // api token (optional)
        h("div", { style: { ...labelStyle, marginTop: 20 } }, t("memory.settings.apiTokenTitle")),
        h("div", { style: hintStyle }, t("memory.settings.apiTokenHint")),
        h("div", { style: { display: "flex", gap: 6 } },
          h("input", { style: { ...inputStyle, flex: 1, marginBottom: 0 }, type: "password", value: apiToken, placeholder: t("memory.settings.apiTokenPlaceholder"), onChange: (e) => setApiToken(e.target.value) }),
          h("button", { style: styles.footerButton, onClick: saveToken }, t("memory.settings.apiTokenSave"))
        ),
        apiTokenSaved && h("div", { style: { fontSize: 12, color: "var(--dsw-alias-state-success, #2a7)" } }, t("memory.settings.apiTokenSaved")),
        // profile
        h("div", { style: labelStyle }, t("memory.settings.profile")),
        h("div", { style: hintStyle }, t("memory.settings.profileHint")),
        h("textarea", {
          style: { ...inputStyle, minHeight: 72, resize: "vertical", fontFamily: "inherit", padding: "8px 12px", height: "auto" },
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
        rules.length === 0 && h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #999)", padding: "8px 0" } }, t("memory.settings.empty")),
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
        commands.length === 0 && h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #999)", padding: "8px 0" } }, t("memory.settings.empty")),
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
          h("textarea", { style: { ...inputStyle, marginBottom: 0, minHeight: 48, resize: "vertical", fontFamily: "inherit", padding: "8px 12px", height: "auto" }, value: newCmd.instruction, placeholder: t("memory.settings.cmdInstruction"), onChange: (e) => setNewCmd({ ...newCmd, instruction: e.target.value }) }),
          h("button", { style: styles.footerButton, onClick: addCommand }, t("memory.settings.cmdAdd")),
          cmdError && h("div", { style: { fontSize: 12, color: "var(--dsw-alias-state-error, #c33)" } }, cmdError)
        ),
        // vector search
        h("div", { style: { ...labelStyle, marginTop: 20 } }, t("memory.settings.vectorTitle")),
        h("div", { style: hintStyle }, t("memory.settings.vectorHint")),
        h("label", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 13 } },
          h("input", { type: "checkbox", checked: !!vector.enabled, onChange: (e) => setVector({ ...vector, enabled: e.target.checked }) }),
          h("span", null, t("memory.settings.vectorEnabled"))
        ),
        h("input", { style: inputStyle, value: vector.baseUrl, placeholder: t("memory.settings.vectorBaseUrl"), onChange: (e) => setVector({ ...vector, baseUrl: e.target.value }) }),
        h("input", { style: inputStyle, type: "password", value: vector.apiKey, placeholder: t("memory.settings.vectorApiKey"), onChange: (e) => setVector({ ...vector, apiKey: e.target.value }) }),
        h("input", { style: inputStyle, value: vector.model, placeholder: t("memory.settings.vectorModel"), onChange: (e) => setVector({ ...vector, model: e.target.value }) }),
        h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
          h("button", { style: styles.footerButton, onClick: saveVector }, t("memory.settings.vectorSave")),
          vectorSaved && h("span", { style: { fontSize: 12, color: "var(--dsw-alias-state-success, #2a7)" } }, t("memory.settings.vectorSaved")),
          h("button", { style: styles.footerButton, onClick: reindex, disabled: reindexing }, reindexing ? t("memory.settings.vectorReindexing") : t("memory.settings.vectorReindex")),
          reindexMsg && h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #666)" } }, reindexMsg)
        )
      );
    }

    // --- Main-area memory library: the single home for every memory feature ---
    // Registered under conversation.view beside Chat / Trajectory. The old
    // right-hand drawer is gone: the sidebar foot entry activates this tab
    // directly. The framework keeps the active-view setter private to the
    // conversation package, and the DOM tab click is the one stable
    // activation path available to plugins.
    //
    // One host constraint remains: the conversation header (and with it the
    // whole tab ring) is hidden while a session is blank — the new-chat hero
    // screen. There the tab simply does not exist, so activateExplorerTab
    // resolves false and the sidebar entry falls back to the full-viewport
    // overlay surface below.
    function findExplorerTab(label) {
      const tabs = document.querySelectorAll('[role="tab"]');
      for (const tab of tabs) {
        if ((tab.textContent || "").trim() === label) return tab;
      }
      return null;
    }

    // Click the memory library tab and wait (bounded, rAF-polled) until the
    // host actually marks it selected — a silent React re-render gap must not
    // be mistaken for success, or the fallback would never kick in.
    function activateExplorerTab(label) {
      return new Promise((resolve) => {
        const tab = findExplorerTab(label);
        if (!tab) { resolve(false); return; }
        tab.click();
        const deadline = Date.now() + 400;
        (function check() {
          if (tab.getAttribute("aria-selected") === "true") { resolve(true); return; }
          if (Date.now() >= deadline) { resolve(false); return; }
          requestAnimationFrame(check);
        })();
      });
    }

    // --- Hero fallback overlay state (module-level pub/sub) ---
    const overlayListeners = new Set();
    let overlayOpenState = false;
    function setOverlayOpen(v) {
      if (v === overlayOpenState) return;
      overlayOpenState = v;
      for (const fn of overlayListeners) fn();
    }
    function useOverlayOpen() {
      const [open, setOpen] = useState(overlayOpenState);
      useEffect(() => {
        const fn = () => setOpen(overlayOpenState);
        overlayListeners.add(fn);
        return () => { overlayListeners.delete(fn); };
      }, []);
      return [open, setOverlayOpen];
    }

    // Full-viewport memory library for states without a tab ring (new-chat
    // hero). Same MemoryExplorer component as the tab view — identical
    // three-column layout, graph and settings — plus a slim top bar with a
    // close affordance. Esc closes. Portalled to <body> so sidebar stacking
    // contexts cannot clip it.
    function MemoryOverlay({ t }) {
      const [open, setOpen] = useOverlayOpen();
      useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [open]);
      if (!open) return null;
      const tree = h("div", { className: "mneme-overlay", role: "region", "aria-label": t("memory.view.label") },
        h("div", { className: "mneme-overlaybar" },
          h("span", { className: "mneme-overlaytitle" }, t("memory.view.label")),
          h("button", {
            type: "button",
            className: "mneme-footbtn",
            onClick: () => setOpen(false)
          }, t("memory.overlay.close"))
        ),
        h("div", { className: "mneme-overlaybody" }, h(MemoryExplorer, { t }))
      );
      if (reactDom && typeof document !== "undefined") return reactDom.createPortal(tree, document.body);
      return tree;
    }

    const EXPLORER_TYPES = ["preference", "project", "decision", "summary", "history"];

    function MemoryExplorer({ t }) {
      const [view, setView] = useState("memory"); // memory | graph | settings
      const [items, setItems] = useState([]);
      const [loading, setLoading] = useState(true);
      const [type, setType] = useState("all");
      const [query, setQuery] = useState("");
      const [semantic, setSemantic] = useState(false);
      const [vecEnabled, setVecEnabled] = useState(false);
      const [searchTopK, setSearchTopK] = useState(20);
      const [remoteItems, setRemoteItems] = useState(null);
      const [selectedId, setSelectedId] = useState(null);
      const [collapsed, setCollapsed] = useState({});
      const [copied, setCopied] = useState(false);
      const [reloadKey, setReloadKey] = useState(0);
      const [graphFocus, setGraphFocus] = useState("");
      // v0.6.2 tag editing state for the detail pane. The authoritative tag set
      // lives server-side (entity_attrs), so it is fetched per selected memory
      // and refreshed after every write instead of trusting the list snapshot.
      const [tagTags, setTagTags] = useState([]);
      const [tagManual, setTagManual] = useState(true);
      const [tagInput, setTagInput] = useState("");
      const [tagAdding, setTagAdding] = useState(false);
      const itemRefs = useRef(new Map());

      useEffect(() => {
        apiFetch("/api/dsh-mneme/vector-config")
          .then((res) => res.json())
          .then((d) => setVecEnabled(!!d.config?.enabled))
          .catch(() => {});
      }, []);

      useEffect(() => {
        let cancelled = false;
        setLoading(true);
        apiFetch("/api/dsh-mneme/list?limit=500")
          .then((res) => (res.ok ? res.json() : { items: [] }))
          .then((d) => { if (!cancelled) { setItems(d.items || []); setLoading(false); } })
          .catch(() => { if (!cancelled) { setItems([]); setLoading(false); } });
        return () => { cancelled = true; };
      }, [reloadKey]);

      // Semantic search: server-side ranking replaces the client filter
      // while enabled and a query is present (debounced). tag: queries always
      // go server-side (searchMemories resolves them without vector support),
      // so they bypass the semantic toggle and use the same search endpoint.
      useEffect(() => {
        const q = query.trim();
        if ((!semantic && !q.startsWith("tag:")) || !q || q.startsWith("entity:")) { setRemoteItems(null); return; }
        let cancelled = false;
        const timer = setTimeout(() => {
          apiFetch(`/api/dsh-mneme/search?q=${encodeURIComponent(q)}&mode=vector&topK=${searchTopK}`)
            .then((res) => (res.ok ? res.json() : { items: [] }))
            .then((d) => { if (!cancelled) setRemoteItems(d.items || []); })
            .catch(() => { if (!cancelled) setRemoteItems([]); });
        }, 250);
        return () => { cancelled = true; clearTimeout(timer); };
      }, [semantic, query, searchTopK]);

      useEffect(() => {
        if (!selectedId) return;
        itemRefs.current.get(selectedId)?.scrollIntoView({ block: "nearest" });
      }, [selectedId]);

      // Load the authoritative tag set for the selected memory (entity_attrs-
      // backed) plus the manualTagEnabled gate that hides editing when off.
      const loadTags = (id) => {
        if (!id) { setTagTags([]); setTagManual(true); setTagInput(""); return; }
        apiFetch(`/api/dsh-mneme/memory/tags?id=${encodeURIComponent(id)}`)
          .then((res) => (res.ok ? res.json() : null))
          .then((j) => { if (j) { setTagTags(Array.isArray(j.tags) ? j.tags : []); setTagManual(j.manualTagEnabled !== false); } })
          .catch(() => {});
      };
      useEffect(() => {
        let cancelled = false;
        if (selectedId) {
          apiFetch(`/api/dsh-mneme/memory/tags?id=${encodeURIComponent(selectedId)}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((j) => { if (!cancelled && j) { setTagTags(Array.isArray(j.tags) ? j.tags : []); setTagManual(j.manualTagEnabled !== false); } })
            .catch(() => {});
        } else {
          setTagTags([]);
          setTagManual(true);
        }
        setTagAdding(false);
        return () => { cancelled = true; };
      }, [selectedId]);

      const q = query.trim().toLowerCase();
      // "entity:" is the graph entry grammar: typing it means the user wants
      // the entity's neighborhood, not a memory list. Offer the jump instead
      // of auto-switching so the list stays predictable.
      const entityQuery = query.trim().startsWith("entity:")
        ? query.trim().slice(7).trim()
        : "";
      const visible = remoteItems
        ? remoteItems
        : items.filter((m) => {
            if (type !== "all" && m.type !== type) return false;
            if (!q) return true;
            return (m.title || "").toLowerCase().includes(q) || (m.content || "").toLowerCase().includes(q);
          });

      const counts = {};
      for (const m of items) counts[m.type] = (counts[m.type] || 0) + 1;
      const knownTypes = EXPLORER_TYPES.filter((k) => counts[k]);
      const extraTypes = Object.keys(counts)
        .filter((k) => !EXPLORER_TYPES.includes(k))
        .sort((a, b) => counts[b] - counts[a]);

      // Time tree: sort newest first, then group month → day in one pass so
      // the grouping follows the sort order instead of re-sorting buckets.
      const sorted = [...visible].sort((a, b) =>
        new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
      const months = [];
      let curMonth = null, curDay = null;
      for (const m of sorted) {
        const d = new Date(m.updated_at || m.created_at || 0);
        const valid = !Number.isNaN(d.getTime());
        const mk = valid ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` : "unknown";
        if (!curMonth || curMonth.key !== mk) {
          curMonth = {
            key: mk,
            label: valid ? d.toLocaleDateString(undefined, { year: "numeric", month: "long" }) : "—",
            days: []
          };
          months.push(curMonth);
          curDay = null;
        }
        const dk = valid ? `${mk}-${String(d.getDate())}` : "unknown";
        if (!curDay || curDay.key !== dk) {
          curDay = { key: dk, label: valid ? d.toLocaleDateString(undefined, { day: "numeric" }) : "—", items: [] };
          curMonth.days.push(curDay);
        }
        curDay.items.push(m);
      }

      const selected = items.find((m) => m.id === selectedId) || null;

      const copyContent = () => {
        if (!selected) return;
        navigator.clipboard?.writeText(selected.content || "").then(
          () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
          () => {}
        );
      };

      // v0.6.2 tag editing: a chip click jumps to a tag:xxx search (reusing
      // the query-driven search flow), the + entry and per-chip × post the new
      // tag set through the tags endpoint then re-fetch. A 409 from the server
      // means manualTagEnabled turned off — flip the gate so editing hides.
      const submitTag = () => {
        const tag = tagInput.trim();
        if (!tag || !selectedId) return;
        apiFetch("/api/dsh-mneme/memory/tags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: selectedId, tags: [...tagTags, tag] })
        }).then((res) => {
          if (res.status === 409) { setTagManual(false); setTagAdding(false); setTagInput(""); return; }
          return res.json();
        }).then((j) => {
          if (j?.ok) { setTagAdding(false); setTagInput(""); loadTags(selectedId); }
        }).catch(() => {});
      };
      const removeTag = (tag) => {
        if (!selectedId) return;
        apiFetch("/api/dsh-mneme/memory/tags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: selectedId, tags: tagTags.filter((x) => x !== tag) })
        }).then((res) => {
          if (res.status === 409) { setTagManual(false); return; }
          return res.json();
        }).then((j) => {
          if (j?.ok) loadTags(selectedId);
        }).catch(() => {});
      };
      const onTagClick = (tag) => {
        setType("all");
        setQuery(`tag:${tag}`);
      };

      // Graph → memory jump: land on the browser tab with filters reset so
      // the target row is visible, selected and scrolled into view.
      const jumpToMemory = (target) => {
        if (!target?.id) return;
        setView("memory");
        setType("all");
        setQuery("");
        setCollapsed({});
        setSelectedId(target.id);
      };

      // [[wiki-link]] click in the detail content: resolve the title to a
      // memory (case-insensitive exact match) then jump to it. Unresolvable
      // titles silently no-op — the link stays as display text.
      const onWikilinkClick = (target) => {
        if (!target) return;
        apiFetch(`/api/dsh-mneme/wikilinks/resolve?title=${encodeURIComponent(target)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => { if (j?.memory?.id) jumpToMemory(j.memory); })
          .catch(() => {});
      };

      const openGraphFor = (name) => {
        setGraphFocus(name || "");
        setView("graph");
      };

      const subviews = [
        { key: "memory", label: t("memory.explorer.tabMemory") },
        { key: "graph", label: t("memory.explorer.tabGraph") },
        { key: "settings", label: t("memory.explorer.tabSettings") }
      ];

      return h("div", { className: "mneme-x" },
        h("div", { className: "mneme-xbar" },
          h("nav", { className: "mneme-vtabs", "aria-label": t("memory.view.label") },
            subviews.map((s) =>
              h("button", {
                key: s.key,
                type: "button",
                className: view === s.key ? "mneme-vtab mneme-active" : "mneme-vtab",
                "aria-pressed": String(view === s.key),
                onClick: () => setView(s.key)
              },
                s.key === "graph"
                  ? h(react.Fragment, null, h(GraphNodesIcon, { size: 16 }), s.label)
                  : s.label
              ))
          ),
          ),
        view === "memory" && h("div", { className: "mneme-xmain" },
          h("div", { className: "mneme-xside" },
            h("div", { className: "mneme-xcolhead" }, t("memory.explorer.searchTitle")),
            h("input", {
              className: "mneme-search mneme-xsearch",
              placeholder: t("memory.explorer.search"),
              value: query,
              onChange: (e) => setQuery(e.target.value)
            }),
            entityQuery && h("button", {
              className: "mneme-entitychip",
              style: { textAlign: "left", justifyContent: "flex-start" },
              onClick: () => openGraphFor(entityQuery)
            }, `${t("memory.graph.viewInGraph")} “${entityQuery}”`),
            h("div", { className: "mneme-xrow" },
              vecEnabled && h("button", {
                className: semantic ? "mneme-chip mneme-active" : "mneme-chip",
                title: t("memory.settings.vectorTitle"),
                onClick: () => setSemantic(!semantic)
              }, t("memory.panel.semantic")),
              h("select", {
                className: "mneme-select mneme-xselect",
                value: searchTopK,
                onChange: (e) => setSearchTopK(Number(e.target.value)),
                title: t("memory.explorer.topK")
              }, [5, 10, 20, 50].map((n) => h("option", { key: n, value: n }, t("memory.explorer.topKOption").replace("{n}", String(n)))))
            ),
            h("div", { className: "mneme-xrow" },
              h("span", { className: "mneme-xcount" }, t("memory.explorer.count").replace("{n}", String(visible.length))),
              h("button", { className: "mneme-footbtn", onClick: () => setReloadKey((k) => k + 1) }, t("memory.explorer.refresh"))
            )
          ),
          h("div", { className: "mneme-xside mneme-xside--filter" },
            h("div", { className: "mneme-xcolhead" }, t("memory.explorer.types")),
            h("button", {
              className: type === "all" ? "mneme-xtype mneme-active" : "mneme-xtype",
              onClick: () => setType("all")
            }, h("span", null, t("memory.tab.all")), h("span", { className: "mneme-xcount2" }, String(items.length))),
            knownTypes.concat(extraTypes).map((key) =>
              h("button", {
                key,
                className: type === key ? "mneme-xtype mneme-active" : "mneme-xtype",
                onClick: () => setType(key)
              },
                h("span", null, typeLabel(t, key)),
                h("span", { className: "mneme-xcount2" }, String(counts[key]))
              ))
          ),
          h("div", { className: "mneme-xbrowse" },
            h("div", { className: "mneme-xdetail" },
              selected
                ? h(react.Fragment, { key: selected.id },
                    h("div", { className: "mneme-xdinner" },
                      h("div", { className: "mneme-xdtitle" }, selected.title),
                      h("div", { className: "mneme-xdmeta" },
                        h("span", null, `${typeLabel(t, selected.type)} · ${t("memory.explorer.importance")} ★${selected.importance}`),
                        selected.source && h("span", null, `${t("memory.explorer.source")}: ${selected.source}`),
                        h("span", { title: formatDate(selected.created_at) }, `${t("memory.explorer.created")}: ${formatDate(selected.created_at)}`),
                        h("span", { title: formatDate(selected.updated_at) }, `${t("memory.explorer.updated")}: ${formatDate(selected.updated_at)}`)
                      ),
                      h("div", { className: "mneme-xdmeta" },
                        h("span", null, t("memory.explorer.tags")),
                        h("div", { className: "mneme-tagrow" },
                          tagTags.length > 0
                            ? tagTags.map((tag) =>
                                h("span", {
                                  key: tag,
                                  className: "mneme-tagchip",
                                  title: `tag:${tag}`,
                                  onClick: () => onTagClick(tag)
                                },
                                  tag,
                                  tagManual && h("button", {
                                    type: "button",
                                    className: "mneme-tagremove",
                                    "aria-label": `${t("memory.explorer.tagRemove")}: ${tag}`,
                                    onClick: (e) => { e.stopPropagation(); removeTag(tag); }
                                  }, "×")
                                )
                              )
                            : h("span", { className: "mneme-tagempty" }, t("memory.explorer.tagsEmpty")),
                          tagManual && (tagAdding
                            ? h("input", {
                                key: selectedId,
                                className: "mneme-taginput",
                                autoFocus: true,
                                value: tagInput,
                                placeholder: t("memory.explorer.tagPlaceholder"),
                                onChange: (e) => setTagInput(e.target.value),
                                onKeyDown: (e) => { if (e.key === "Enter") submitTag(); },
                                onBlur: () => { setTagAdding(false); setTagInput(""); }
                              })
                            : h("button", {
                                type: "button",
                                className: "mneme-tagadd",
                                onClick: () => setTagAdding(true)
                              }, `+ ${t("memory.explorer.tagAdd")}`))
                        )
                      ),
                      h("div", { className: "mneme-xdcontent" },
                        selected.content ? wikilinkSegments(selected.content, onWikilinkClick) : selected.content
                      ),
                      h("div", { className: "mneme-xdactions" },
                        h("button", { className: "mneme-footbtn", onClick: copyContent },
                          copied ? t("memory.explorer.copied") : t("memory.explorer.copy"))
                      ),
                      h(BacklinksPanel, { memory: selected, t, onJump: jumpToMemory })
                    )
                  )
                : h("div", { className: "mneme-xempty" }, t("memory.explorer.emptyDetail"))
            ),
            h("div", { className: "mneme-xtree" },
              h("div", { className: "mneme-xcolhead" }, t("memory.explorer.timeline")),
              loading
                ? h("div", { className: "mneme-xempty" }, "…")
                : months.length === 0
                  ? h("div", { className: "mneme-xempty" }, t("memory.explorer.empty"))
                  : months.map((month) =>
                      h("div", { key: month.key },
                        h("button", {
                          className: "mneme-xmonth",
                          "aria-expanded": String(!collapsed[month.key]),
                          onClick: () => setCollapsed((c) => ({ ...c, [month.key]: !c[month.key] }))
                        },
                          h("span", { className: "mneme-xcaret" }, collapsed[month.key] ? "▸" : "▾"),
                          month.label
                        ),
                        !collapsed[month.key] && month.days.map((day) =>
                          h("div", { key: day.key },
                            h("button", {
                              className: "mneme-xday",
                              "aria-expanded": String(!collapsed[day.key]),
                              onClick: () => setCollapsed((c) => ({ ...c, [day.key]: !c[day.key] }))
                            },
                              h("span", { className: "mneme-xcaret" }, collapsed[day.key] ? "▸" : "▾"),
                              day.label
                            ),
                            !collapsed[day.key] && day.items.map((m) => {
                              const d = new Date(m.updated_at || m.created_at || 0);
                              const time = Number.isNaN(d.getTime())
                                ? ""
                                : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
                              return h("button", {
                                key: m.id,
                                ref: (el) => { if (el) itemRefs.current.set(m.id, el); else itemRefs.current.delete(m.id); },
                                className: m.id === selectedId ? "mneme-xitem mneme-active" : "mneme-xitem",
                                onClick: () => setSelectedId(m.id)
                              },
                                h("span", { className: "mneme-xtime" }, time),
                                h("span", { className: "mneme-xname" }, m.title || m.content?.slice(0, 40))
                              );
                            })
                          ))
                      ))
            )
          )
        ),
        view === "graph" && h(GraphPanel, { t, focusEntity: graphFocus, onJumpMemory: jumpToMemory }),
        view === "settings" && h("div", { className: "mneme-xsettings" },
          h("div", { className: "mneme-xsettings-inner" }, h(SettingsContent, { t }))
        )
      );
    }

    // --- Sidebar foot entry: the wide row / rail icon that activates the
    // main-area memory library tab. When the tab ring is absent (new-chat
    // hero screen hides the conversation header entirely) the same click
    // opens the full-viewport overlay instead — the library stays reachable
    // from every conversation state.
    function SidebarTrigger({ wide, t }) {
      const [, setOpen] = useOverlayOpen();
      return h("button", {
        type: "button",
        className: wide ? "mneme-trigger" : "mneme-trigger mneme-rail",
        "aria-label": t("memory.sidebar.aria"),
        title: t("memory.sidebar.aria"),
        onClick: () => {
          activateExplorerTab(t("memory.view.label")).then((ok) => { if (!ok) setOpen(true); });
        }
      },
        h(IconArchiveOutline20, { size: wide ? 16 : 18 }),
        wide && h("span", { className: "mneme-trigger-label" }, t("memory.panel.open"))
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dictionaries), "dsh-mneme: dictionaries");

      // Register the memory entry beside Settings at the sidebar foot. The
      // entry renders a wide row (icon + label) when the sidebar is expanded
      // and a rail icon when collapsed; clicking activates the memory
      // library conversation view.
      ctx.slots.inject("sidebar.footer.action", () => {
        const t = ctx.locale.bind(NS);
        return ctx.slots.register({
          name: "sidebar.footer.action",
          id: "dsh-mneme",
          order: 0,
          label: () => t("memory.panel.open")
        }, (props) => h(react.Fragment, null,
          h(SidebarTrigger, { ...props, t }),
          // The overlay mounts from the always-rendered sidebar slot so it
          // survives conversation switches; the portal moves it to <body>.
          h(MemoryOverlay, { t })
        ));
      });

      // Register the memory library as a conversation view tab, beside
      // Chat / Trajectory. The view ignores its session props: the library
      // reads the memory store over HTTP. It hosts every memory feature —
      // browse, graph and settings — in the main content area.
      ctx.slots.inject("conversation.view", () => {
        const t = ctx.locale.bind(NS);
        return ctx.slots.register({
          name: "conversation.view",
          id: "dsh-mneme-memory",
          order: 30,
          locale: NS,
          label: () => t("memory.view.label")
        }, () => h(MemoryExplorer, { t }));
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
