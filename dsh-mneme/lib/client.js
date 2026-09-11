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

    // Stroke icons, Lucide path data (ISC license) inlined as [tag, attrs]
    // tuples — the plugin runtime cannot require third-party libraries, so
    // the data ships with the bundle (the morphicons/lucide pairing the
    // data package documents, minus the runtime dependency). Stroke picks
    // up currentColor, so icons follow the host theme tokens.
    const ICON_PATHS = {
      database: [["ellipse", { cx: "12", cy: "5", rx: "9", ry: "3" }], ["path", { d: "M3 5V19A9 3 0 0 0 21 19V5" }], ["path", { d: "M3 12A9 3 0 0 0 21 12" }]],
      waypoints: [["path", { d: "m10.586 5.414-5.172 5.172" }], ["path", { d: "m18.586 13.414-5.172 5.172" }], ["path", { d: "M6 12h12" }], ["circle", { cx: "12", cy: "20", r: "2" }], ["circle", { cx: "12", cy: "4", r: "2" }], ["circle", { cx: "20", cy: "12", r: "2" }], ["circle", { cx: "4", cy: "12", r: "2" }]],
      settings: [["path", { d: "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" }], ["circle", { cx: "12", cy: "12", r: "3" }]],
      search: [["path", { d: "m21 21-4.34-4.34" }], ["circle", { cx: "11", cy: "11", r: "8" }]],
      refresh: [["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }], ["path", { d: "M21 3v5h-5" }], ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }], ["path", { d: "M8 16H3v5" }]],
      chevronDown: [["path", { d: "m6 9 6 6 6-6" }]],
      chevronRight: [["path", { d: "m9 18 6-6-6-6" }]],
      copy: [["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" }], ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }]],
      check: [["path", { d: "M20 6 9 17l-5-5" }]],
      inbox: [["polyline", { points: "22 12 16 12 14 15 10 15 8 12 2 12" }], ["path", { d: "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" }]],
      activity: [["path", { d: "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" }]],
      flame: [["path", { d: "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" }]]
    };
    const Icon = ({ name, size = 16, className }) => {
      const parts = ICON_PATHS[name];
      if (!parts) return null;
      return h("svg", {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        className,
        "aria-hidden": "true"
      }, parts.map(([tag, attrs], i) => h(tag, { key: i, ...attrs })));
    };

    // Lucide v1.42 star path（morphicons 官方配套的数据包）。morphicons 本体
    // 是 ESM-only 的变形动画引擎、插件运行时不允许 require 第三方库，故按
    // 既有惯例内联图标数据静态渲染；实心/空心由 fill 区分，空心降透明度。
    const STAR_PATH_D = "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z";
    const ImportanceStars = ({ value = 0, size = 13, className }) => {
      const filled = Math.min(5, Math.max(0, Math.round(value || 0)));
      return h("span", { className: `mneme-stars${className ? ` ${className}` : ""}`, role: "img", "aria-label": `${filled}/5` },
        [0, 1, 2, 3, 4].map((i) => h("svg", { key: i, width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true" },
          h("path", {
            d: STAR_PATH_D,
            fill: i < filled ? "currentColor" : "none",
            stroke: "currentColor",
            strokeWidth: 1.6,
            strokeLinejoin: "round",
            opacity: i < filled ? 1 : 0.35
          }))));
    };

    // 热度徽章（阶段二）：flame 图标 + 整数百分比，三档配色（热/温/冷）。
    // /list 仅在 heatEnabled=true 时下发 heat 字段——缺省即不渲染，开关关闭
    // 时徽章全站自动消失，前端无需感知开关状态。
    const HeatBadge = ({ value, size = 12 }) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
      const tier = pct >= 66 ? "hot" : pct >= 33 ? "warm" : "cold";
      return h("span", { className: `mneme-heat mneme-heat--${tier}`, title: `${pct}%` },
        h(Icon, { name: "flame", size, className: "mneme-heatico" }),
        h("span", { className: "mneme-heatpct" }, `${pct}%`));
    };

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

    // ⚠️ 'betterSidebar' 绝不能进模块级 inject（issue #88 实锤）：loader 对
    // inject 声明的服务是硬等待——未安装 better-sidebar 的环境里整个 entry
    // 永远 pending（"1 entry did not activate" → Failed to load plugins）。
    // 软依赖靠内层动态子插件探测（见 apply 内 better-sidebar 挂载块）。
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
        "memory.settings.profileHint": "写一段自我介绍（角色、背景、偏好），Agent 每轮对话都会自动带上。",
        "memory.settings.profileSave": "保存画像",
        "memory.settings.profileSaved": "画像已保存",
        "memory.settings.rules": "规则",
        "memory.settings.rulesHint": "给 Agent 立下必须遵守的规矩，随时增删，下一轮即生效。",
        "memory.settings.ruleAdd": "添加规则",
        "memory.settings.rulePlaceholder": "例如：回答时总是先给结论",
        "memory.settings.commands": "自定义指令",
        "memory.settings.commandsHint": "把常用提示词存成 / 命令，聊天时直接键入调用。",
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
        "memory.explorer.tabEntities": "实体",
        "memory.explorer.tabSettings": "设置",
        "memory.explorer.tabStatus": "状态",
        "memory.entities.count": "{n} 个实体",
        "memory.entities.pick": "从左侧选择一个实体，查看它的属性与关系",
        "memory.entities.none": "暂无实体：开启实体抽取后，记忆里的人物 / 项目 / 概念会自动沉淀到这里",
        "memory.entities.attrs": "属性",
        "memory.entities.relations": "关系",
        "memory.entities.mentions": "{n} 次提及",
        "memory.entities.lastSeen": "最近出现",
        "memory.entities.graph": "关系图谱",
        "memory.entity.person": "人物",
        "memory.entity.project": "项目",
        "memory.entity.concept": "概念",
        "memory.entity.technology": "技术",
        "memory.entity.organization": "组织",
        "memory.entity.other": "其他",
        "memory.explorer.search": "搜索标题或内容…",
        "memory.explorer.searchTitle": "语义检索",
        "memory.explorer.types": "分类",
        "memory.explorer.timeline": "时间树",
        "memory.explorer.detail": "详情",
        "memory.explorer.emptyDetail": "在时间树中选择一条记忆查看全文",
        "memory.explorer.copy": "复制全文",
        "memory.explorer.copied": "已复制",
        "memory.explorer.refresh": "刷新",
        "memory.explorer.loadMore": "加载更多",
        "memory.explorer.count": "共 {n} 条",
        "memory.explorer.empty": "暂无记忆条目",
        "memory.explorer.source": "来源",
        "memory.explorer.created": "创建",
        "memory.explorer.updated": "更新",
        "memory.explorer.tags": "标签",
        "memory.explorer.importance": "重要性",
        "memory.explorer.heat": "热度",
        "memory.explorer.sourceFilter": "来源",
        "memory.explorer.sort": "排序",
        "memory.explorer.heatSort": "热度优先",
        "memory.explorer.heatSortHint": "对已加载条目按热度降序（页内排序，非全局序；时间树保持时间序）",
        "memory.explorer.filterDeposited": "沉淀",
        "memory.explorer.filterDepositedHint": "只看 autoDream 巩固/更新过的记忆",
        "memory.explorer.filterArchived": "已归档",
        "memory.explorer.filterArchivedHint": "只看已归档的记忆（默认列表不含它们）",
        "memory.explorer.topK": "返回数量",
        "memory.explorer.topKOption": "返回 {n} 条",
        "memory.card.open": "在记忆库中查看全文",
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
        "memory.graph.hint": "拖拽节点调整布局 · 空白处拖动平移 · 滚轮缩放",
        "memory.graph.resetView": "重置视图",
        "memory.graph.viewInGraph": "在实体视图中打开",
        "memory.graph.loading": "加载中…",
        "memory.graph.distance": "距中心 {n} 跳",
        "memory.settings.vectorTitle": "向量搜索",
        "memory.settings.vectorHint": "搜索不再只认字面：接入任意 OpenAI 兼容的 embedding 接口后，意思相近的记忆也能被召回。",
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
        "memory.settings.apiTokenHint": "给面板的写操作加一道锁：设置后，修改记忆或配置需要携带 Token，纯浏览不受影响。清空并保存可关闭。",
        "memory.settings.apiTokenPlaceholder": "留空 = 不鉴权（默认）",
        "memory.settings.apiTokenSave": "保存 Token",
        "memory.settings.apiTokenSaved": "Token 已保存",
        "memory.settings.feedback.title": "帮助与反馈",
        "memory.settings.feedback.desc": "遇到问题？先看看仓库已有的 issue，或直接把情况反馈过来：",
        "memory.settings.feedback.newIssue": "GitHub 新建 issue（自动带上环境信息）",
        "memory.settings.feedback.email": "邮件反馈（work@modusensus.space）",
        "memory.settings.feedback.browse": "浏览仓库已知问题",
        "memory.settings.feedback.hint": "反馈前先搜搜是否已有相同问题，能省一份重复的 issue～",
        "memory.settings.mode.title": "运行模式",
        "memory.settings.mode.desc": "轻量模式只保留核心的记忆读写与自动注入（关闭 autoDream 巩固、实体抽取、语义搜索等高级功能），适合只想「记住偏好」的轻量使用；标准模式开启全部功能。",
        "memory.settings.mode.light": "轻量",
        "memory.settings.mode.standard": "标准",
        "memory.settings.mode.savedHint": "已保存，重启 DSH 后生效",
        "memory.settings.mode.offList": "已关闭：巩固（autoDream）· 实体抽取 · 语义搜索",
        "memory.settings.extapi.title": "外部访问 API",
        "memory.settings.extapi.desc": "独立 HTTP 服务，供其他插件 / CLI / 桌面工具读写记忆，默认绑定 127.0.0.1。重启 DSH 后生效。",
        "memory.settings.extapi.enabled": "启用",
        "memory.settings.extapi.disabled": "停用",
        "memory.settings.extapi.address": "地址",
        "memory.settings.extapi.port": "端口",
        "memory.settings.extapi.token": "Token",
        "memory.settings.extapi.copy": "复制",
        "memory.settings.extapi.copied": "已复制",
        "memory.settings.extapi.savedHint": "已保存，重启 DSH 后生效",
        "memory.settings.extapi.invalidPort": "端口需为 1-65535 的数字",
        "memory.tab.rejected_solution": "被否决方案",
        "memory.tab.pitfall": "踩坑记录",
        "memory.tab.constraint": "工程约束",
        "memory.features.title": "功能开关",
        "memory.features.desc": "按需启停后端能力，改动保存后重启 DSH 生效。",
        "memory.features.group.core": "核心",
        "memory.features.group.enhance": "记忆增强",
        "memory.features.group.dream": "巩固与睡眠",
        "memory.features.group.advanced": "高级",
        "memory.features.advancedToggle": "高级（注入策略 · 反思 · 实验项）",
        "memory.features.restartHint": "重启 DSH 后生效",
        "memory.features.loadFailed": "加载失败",
        "memory.features.autoInject": "自动注入",
        "memory.features.autoInject.hint": "每轮对话自动携带相关记忆",
        "memory.features.autoSummarize": "自动总结",
        "memory.features.autoSummarize.hint": "对话结束自动提炼记忆条目",
        "memory.features.hotMemoryEnabled": "热记忆",
        "memory.features.hotMemoryEnabled.hint": "最近几轮对话原文随注入携带，不写入长期记忆",
        "memory.features.entityExtractionEnabled": "实体抽取",
        "memory.features.entityExtractionEnabled.hint": "从记忆中提取人物/项目/概念，图谱随之生长",
        "memory.features.entityExtractionProvider": "实体抽取 Provider",
        "memory.features.entityExtractionModel": "实体抽取模型",
        "memory.features.entityExtractionReasoning": "实体抽取思考强度",
        "memory.features.entityExtractionReasoning.none": "跟随默认",
        "memory.features.entityExtractionReasoning.low": "低",
        "memory.features.entityExtractionReasoning.medium": "中",
        "memory.features.entityExtractionReasoning.high": "高",
        "memory.features.entityExtractionModelHint": "Provider/模型留空 = 跟随主对话模型；思考强度 none = 服务商默认",
        "memory.features.codingRetrospect": "编码记忆蒸馏",
        "memory.features.codingRetrospect.hint": "用完整转录（含工具调用与报错）提炼踩坑、约束与被否决方案",
        "memory.features.rerankEnabled": "结果重排",
        "memory.features.rerankEnabled.hint": "本地重排模型对召回结果精排，更慢更准",
        "memory.features.searchSemanticDedup": "语义去重",
        "memory.features.searchSemanticDedup.hint": "搜索结果中意思相近的条目只保留一条",
        "memory.features.autoDream": "记忆巩固",
        "memory.features.autoDream.hint": "后台自动合并、沉淀碎片记忆",
        "memory.features.sleepModeEnabled": "睡眠模式",
        "memory.features.sleepModeEnabled.hint": "空闲时段做分层压缩与整理",
        "memory.features.hybridInject": "混合注入",
        "memory.features.hybridInject.hint": "关键词 + 向量双路召回后合并注入",
        "memory.features.selectiveInjectEnabled": "选择性注入",
        "memory.features.selectiveInjectEnabled.hint": "按相关性筛选，只注入值得携带的记忆",
        "memory.features.adaptiveThresholdEnabled": "自适应阈值",
        "memory.features.adaptiveThresholdEnabled.hint": "按召回质量动态调整相关性门槛",
        "memory.features.reflectionUpdateEnabled": "反思更新",
        "memory.features.reflectionUpdateEnabled.hint": "巩固时允许修正已有记忆",
        "memory.features.distill": "蒸馏与限流",
        "memory.features.distillRateLimitIntervalMs": "蒸馏放行间隔 (ms)",
        "memory.features.distillRateLimitRetries": "429 重试次数",
        "memory.features.distillRateLimitBaseDelayMs": "退避起始延迟 (ms)",
        "memory.features.distillMaxChars": "转录截断上限（字符）",
        "memory.features.codingBoostFactor": "编码记忆加权",
        "memory.features.memoryQualityFilter.enabled": "记忆质量过滤",
        "memory.features.memoryQualityFilter.enabled.hint": "低价值记忆自动归档，注入按质量降权",
        "memory.features.llmAudit.enabled": "后台调用审计",
        "memory.features.llmAudit.enabled.hint": "记录巩固/总结的后台模型调用与 token 消耗",
        "memory.features.bm25SearchEnabled": "BM25 关键词检索",
        "memory.features.bm25SearchEnabled.hint": "传统关键词打分检索，与向量召回互补",
        "memory.features.conflictFreezeEnabled": "冲突冻结",
        "memory.features.conflictFreezeEnabled.hint": "巩固发现互相矛盾的记忆时先冻结待确认",
        "memory.features.trustEpistemicWeighting": "可信度加权",
        "memory.features.trustEpistemicWeighting.hint": "按来源可信度调整召回排序（实验性）",
        "memory.features.reflectionFailureTracking": "反思失败追踪",
        "memory.features.reflectionFailureTracking.hint": "记录巩固决策的失败样本供后续改进",
        "memory.features.embedRoute": "语义检索路线",
        "memory.features.embedProvider": "Embedding 提供方",
        "memory.features.embedProvider.openai": "OpenAI 兼容接口",
        "memory.features.embedProvider.local": "本地模型（离线）",
        "memory.features.embedProvider.ollama": "Ollama",
        "memory.features.embedProvider.openai.hint": "接口地址 / Key / 模型在「向量搜索」卡片配置",
        "memory.features.embedProvider.local.hint": "首次使用会下载模型，之后完全离线",
        "memory.features.embedProvider.ollama.hint": "需要本机 Ollama 服务在运行",
        "memory.features.localEmbedModel": "本地 embedding 模型",
        "memory.features.ollamaBaseUrl": "Ollama 服务地址",
        "memory.features.ollamaModel": "Ollama 模型名",
        "memory.features.dreamProvider": "巩固模型 Provider",
        "memory.features.dreamModel": "巩固用模型名",
        "memory.features.dreamModelHint": "留空 = 跟随主对话模型；只影响记忆巩固（autoDream）用的模型",
        "memory.features.sleepProvider": "睡眠 Provider",
        "memory.features.sleepModel": "睡眠模型",
        "memory.features.sleepModelHint": "留空 = 用巩固模型或当前模型；建议选非思考模型",
        "memory.features.routeFollowDefault": "跟随默认路由",
        "memory.features.modelTest": "测试连通性",
        "memory.features.modelTesting": "测试中…",
        "memory.features.modelTestOk": "连通正常",
        "memory.features.modelTestFail": "测试失败",
        "memory.features.modelTestHint": "真实发起一次最小巩固调用，验证 Provider/模型连通与 effort 支持",
        "memory.explorer.viewCards": "卡片",
        "memory.explorer.viewTimeline": "时间线",
        "memory.explorer.viewAria": "视图切换",
        "memory.explorer.dateLabel": "时间",
        "memory.explorer.date.all": "全部时间",
        "memory.explorer.date.7d": "近 7 天",
        "memory.explorer.date.30d": "近 30 天",
        "memory.explorer.date.90d": "近 90 天",
        "memory.explorer.more": "更多操作",
        "memory.explorer.exportJson": "导出 JSON",
        "memory.explorer.exportMarkdown": "导出 Markdown",
        "memory.explorer.importMd": "导入 Markdown 镜像…",
        "memory.explorer.importTitle": "导入 Markdown 镜像",
        "memory.explorer.importHint": "选择一个镜像类型的 Markdown 文件，解析其中的人工编辑并合并进记忆库。",
        "memory.explorer.importType": "镜像类型",
        "memory.explorer.importPick": "选择文件…",
        "memory.explorer.importConfirm": "导入",
        "memory.explorer.importCancel": "取消",
        "memory.explorer.importing": "导入中…",
        "memory.explorer.imported": "已合并 {n} 条编辑",
        "memory.explorer.importFailed": "导入失败",
        "memory.explorer.importNoFile": "请先选择文件",
        "memory.explorer.exportFailed": "导出失败",
        "memory.explorer.conflictBadge": "冲突",
        "memory.explorer.archivedBadge": "已归档",
        "memory.explorer.detail.edit": "编辑",
        "memory.explorer.detail.save": "保存",
        "memory.explorer.detail.cancel": "取消",
        "memory.explorer.detail.archive": "归档",
        "memory.explorer.detail.restore": "恢复",
        "memory.explorer.detail.restored": "已恢复到主列表",
        "memory.explorer.detail.archived": "已归档",
        "memory.explorer.detail.archiveFailed": "操作失败",
        "memory.explorer.detail.saved": "已保存，镜像同步更新",
        "memory.explorer.detail.quality": "质量分",
        "memory.explorer.detail.entities": "关联实体",
        "memory.explorer.detail.entitiesEmpty": "开启实体抽取后，相关人物/项目会出现在这里",
        "memory.explorer.detail.closeAria": "关闭详情",
        "memory.explorer.detail.editTitle": "标题",
        "memory.explorer.detail.editContent": "内容",
        "memory.explorer.detail.editImportance": "重要性",
        "memory.status.dream": "最近巩固",
        "memory.status.dreamNever": "尚未运行",
        "memory.status.conflicts": "待确认冲突",
        "memory.status.conflictsHint": "冻结的矛盾记忆，等待人工确认",
        "memory.status.workbench": "工作动态",
        "memory.status.dreamConsolidate": "记忆巩固",
        "memory.status.summarize": "总结提炼",
        "memory.status.tokens": "{n} tokens",
        "memory.status.deposited": "沉淀 {n} 条记忆",
        "memory.status.failed": "失败",
        "memory.status.success": "成功",
        "memory.status.skipped": "跳过",
        "memory.status.emptyFeed": "还没有后台活动：对话结束后会自动提炼记忆",
        "memory.status.consolidated": "沉淀的记忆",
        "memory.status.consolidatedEmpty": "autoDream / autoSummarize 沉淀的记忆会出现在这里",
        "memory.status.archivedMemories": "已归档的记忆",
        "memory.status.heatDistribution": "热度分布",
        "memory.status.heatHint": "热门（≥66%）{hot} · 温热（33–66%）{warm} · 冷却（<33%）{cold}，样本为最近 {sample} 条",
        "memory.status.viewAll": "查看全部",
        "memory.status.depositedCount": "沉淀的记忆（{n}）",
        "memory.status.archivedCount": "已归档的记忆（{n}）",
        "memory.status.archivedEmpty": "没有归档的记忆",
        "memory.status.restore": "恢复",
        "memory.settings.extapi.reveal": "显示",
        "memory.settings.extapi.hide": "隐藏",
        "memory.settings.extapi.maskHint": "Token 已遮蔽；「复制」可复制完整值",
        "memory.explorer.delete": "删除",
        "memory.explorer.confirmDelete": "确认删除?",
        "memory.explorer.cancel": "取消",
        "memory.explorer.deleted": "已删除",
        "memory.explorer.deleteFailed": "删除失败",
        "memory.status.memories": "记忆总数",
        "memory.status.entities": "实体",
        "memory.status.vector": "向量索引",
        "memory.status.vectorOff": "未启用",
        "memory.status.vectorInit": "初始化中",
        "memory.status.vectorInitHint": "embedder 不可达，正在重试",
        "memory.status.vectorRuntimeMissing": "缺少本地推理运行时",
        "memory.status.vectorRuntimeHint": "本地推理运行时未就绪（{status}）",
        "memory.status.vectorRuntimeCost": "本地向量化要额外一份本地推理运行时（transformers + onnxruntime 闭包，解包后约 247MB（实测））。下面的按钮会先尝试收编本机已有的那份（同盘则硬链接，不占额外空间），没有再按固定清单从 npm 取回（逐个校验 sha512）。也可以直接让 agent 处理，或在终端里自己跑：node scripts/mneme-runtime.mjs status / adopt [--from <node_modules>] / verify（详见 docs/LOCAL_MODEL.md §2.5）。",
        "memory.status.vectorRuntimeReady": "运行时已就绪",
        "memory.status.vectorRuntimeReadyHint": "本地嵌入尚未初始化（进程里的 embedder 在运行时缺失时已经失败过一次）：若一直停在这里，重启 DSH 即可。",
        "memory.status.vectorRuntimeFetch": "取回本地运行时",
        "memory.status.vectorRuntimeFetchBusy": "正在取回…（先试收编，必要时下载，数千个文件，请稍候）",
        "memory.status.vectorRuntimeFetchAdopted": "已收编本机已有的运行时：{n} 个包 / {m} 个文件（{mode}）。若状态未更新请重启 DSH",
        "memory.status.vectorRuntimeFetchDownloaded": "已从 npm 取回运行时：{n} 个包 / {m} 个文件。若状态未更新请重启 DSH",
        "memory.status.vectorRuntimeFetchFailed": "取回失败：{reason}",
        "memory.status.vectorIndexed": "已索引 {n} / {m} 条",
      "memory.status.vectorUnconfigured": "未配置",
      "memory.status.vectorUnconfiguredHint": "未填 embedding 端点/模型或未启用，语义召回不可用",
      "memory.status.vectorDegradedHint": "已索引 0 / {m} 条，语义召回实际不可用",
        "memory.status.llm": "LLM 消耗",
        "memory.status.llmCalls": "近 7 天 · {n} 次调用",
        "memory.status.error": "加载失败"
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
        "memory.settings.profileHint": "Describe yourself once — the agent reads it every turn.",
        "memory.settings.profileSave": "Save Profile",
        "memory.settings.profileSaved": "Profile saved",
        "memory.settings.rules": "Rules",
        "memory.settings.rulesHint": "Rules the agent must follow — add or remove anytime, effective next turn.",
        "memory.settings.ruleAdd": "Add Rule",
        "memory.settings.rulePlaceholder": "e.g. Always lead with a conclusion",
        "memory.settings.commands": "Custom Commands",
        "memory.settings.commandsHint": "Save prompts as slash commands and invoke them right from the composer.",
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
        "memory.explorer.tabEntities": "Entities",
        "memory.explorer.tabSettings": "Settings",
        "memory.explorer.tabStatus": "Status",
        "memory.entities.count": "{n} entities",
        "memory.entities.pick": "Select an entity to see its attributes and relations",
        "memory.entities.none": "No entities yet — turn on entity extraction and people / projects / concepts will accumulate here",
        "memory.entities.attrs": "Attributes",
        "memory.entities.relations": "Relations",
        "memory.entities.mentions": "{n} mentions",
        "memory.entities.lastSeen": "Last seen",
        "memory.entities.graph": "Relation graph",
        "memory.entity.person": "People",
        "memory.entity.project": "Projects",
        "memory.entity.concept": "Concepts",
        "memory.entity.technology": "Technologies",
        "memory.entity.organization": "Organizations",
        "memory.entity.other": "Others",
        "memory.explorer.search": "Search title or content…",
        "memory.explorer.searchTitle": "Semantic Search",
        "memory.explorer.types": "Types",
        "memory.explorer.timeline": "Timeline",
        "memory.explorer.detail": "Details",
        "memory.explorer.emptyDetail": "Select a memory in the timeline to read it",
        "memory.explorer.copy": "Copy content",
        "memory.explorer.copied": "Copied",
        "memory.explorer.refresh": "Refresh",
        "memory.explorer.loadMore": "Load more",
        "memory.explorer.count": "{n} items",
        "memory.explorer.empty": "No memories yet",
        "memory.explorer.source": "Source",
        "memory.explorer.created": "Created",
        "memory.explorer.updated": "Updated",
        "memory.explorer.tags": "Tags",
        "memory.explorer.importance": "Importance",
        "memory.explorer.heat": "Heat",
        "memory.explorer.sourceFilter": "Source",
        "memory.explorer.sort": "Sort",
        "memory.explorer.heatSort": "By heat",
        "memory.explorer.heatSortHint": "Sort loaded items by heat, in-page (not global; the month tree keeps chronological order)",
        "memory.explorer.filterDeposited": "Deposited",
        "memory.explorer.filterDepositedHint": "Only memories autoDream consolidated or updated",
        "memory.explorer.filterArchived": "Archived",
        "memory.explorer.filterArchivedHint": "Only archived memories (excluded from the default list)",
        "memory.explorer.topK": "Results limit",
        "memory.explorer.topKOption": "Return {n}",
        "memory.card.open": "Open full text in the memory library",
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
        "memory.graph.hint": "Drag nodes to rearrange · drag the background to pan · scroll to zoom",
        "memory.graph.resetView": "Reset view",
        "memory.graph.viewInGraph": "Open in entity explorer",
        "memory.graph.loading": "Loading…",
        "memory.graph.distance": "{n} hop(s) from root",
        "memory.settings.vectorTitle": "Vector Search",
        "memory.settings.vectorHint": "Match by meaning, not just wording — connect any OpenAI-compatible embeddings API.",
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
        "memory.settings.apiTokenHint": "Lock write operations behind a token — browsing stays open. Clear and save to disable.",
        "memory.settings.apiTokenPlaceholder": "Empty = no auth (default)",
        "memory.settings.apiTokenSave": "Save Token",
        "memory.settings.apiTokenSaved": "Token saved",
        "memory.settings.feedback.title": "Help & feedback",
        "memory.settings.feedback.desc": "Stuck? Search the existing issues, or tell us what happened:",
        "memory.settings.feedback.newIssue": "Open a GitHub issue (environment info prefilled)",
        "memory.settings.feedback.email": "Email feedback (work@modusensus.space)",
        "memory.settings.feedback.browse": "Browse known issues",
        "memory.settings.feedback.hint": "Search for an existing issue first — it saves a duplicate.",
        "memory.settings.mode.title": "Runtime mode",
        "memory.settings.mode.desc": "Light mode keeps only the core memory read/write and auto-injection (autoDream consolidation, entity extraction and semantic search are off) — for light use where you just want preferences remembered. Standard mode enables everything.",
        "memory.settings.mode.light": "Light",
        "memory.settings.mode.standard": "Standard",
        "memory.settings.mode.savedHint": "Saved. Takes effect after restarting DSH",
        "memory.settings.mode.offList": "Off: consolidation (autoDream) · entity extraction · semantic search",
        "memory.settings.extapi.title": "External API",
        "memory.settings.extapi.desc": "A standalone HTTP service for other plugins / CLIs / desktop tools to read and write memories, bound to 127.0.0.1 by default. Takes effect after restarting DSH.",
        "memory.settings.extapi.enabled": "Enable",
        "memory.settings.extapi.disabled": "Disable",
        "memory.settings.extapi.address": "Address",
        "memory.settings.extapi.port": "Port",
        "memory.settings.extapi.token": "Token",
        "memory.settings.extapi.copy": "Copy",
        "memory.settings.extapi.copied": "Copied",
        "memory.settings.extapi.savedHint": "Saved. Takes effect after restarting DSH",
        "memory.settings.extapi.invalidPort": "Port must be a number between 1 and 65535",
        "memory.tab.rejected_solution": "Rejected solutions",
        "memory.tab.pitfall": "Pitfalls",
        "memory.tab.constraint": "Constraints",
        "memory.features.title": "Features",
        "memory.features.desc": "Toggle backend capabilities. Changes take effect after restarting DSH.",
        "memory.features.group.core": "Core",
        "memory.features.group.enhance": "Enhancement",
        "memory.features.group.dream": "Consolidation",
        "memory.features.group.advanced": "Advanced",
        "memory.features.advancedToggle": "Advanced (injection · reflection · experimental)",
        "memory.features.restartHint": "Takes effect after restarting DSH",
        "memory.features.loadFailed": "Failed to load",
        "memory.features.autoInject": "Auto injection",
        "memory.features.autoInject.hint": "Carry relevant memories into every turn",
        "memory.features.autoSummarize": "Auto summarization",
        "memory.features.autoSummarize.hint": "Distill memory entries when a conversation ends",
        "memory.features.hotMemoryEnabled": "Hot memory",
        "memory.features.hotMemoryEnabled.hint": "Carry the last few turns verbatim; never written to long-term memory",
        "memory.features.entityExtractionEnabled": "Entity extraction",
        "memory.features.entityExtractionEnabled.hint": "Extract people / projects / concepts so the graph grows by itself",
        "memory.features.entityExtractionProvider": "Entity extraction provider",
        "memory.features.entityExtractionModel": "Entity extraction model",
        "memory.features.entityExtractionReasoning": "Entity extraction reasoning",
        "memory.features.entityExtractionReasoning.none": "Follow default",
        "memory.features.entityExtractionReasoning.low": "Low",
        "memory.features.entityExtractionReasoning.medium": "Medium",
        "memory.features.entityExtractionReasoning.high": "High",
        "memory.features.entityExtractionModelHint": "Provider / model empty = follow the main conversation model; reasoning none = provider default",
        "memory.features.codingRetrospect": "Coding retrospection",
        "memory.features.codingRetrospect.hint": "Distill pitfalls, constraints and rejected solutions from full transcripts (tools and errors included)",
        "memory.features.rerankEnabled": "Reranking",
        "memory.features.rerankEnabled.hint": "Rerank recalled results with a local model — slower, more precise",
        "memory.features.searchSemanticDedup": "Semantic dedup",
        "memory.features.searchSemanticDedup.hint": "Keep one entry when search hits near-duplicates",
        "memory.features.autoDream": "Memory consolidation",
        "memory.features.autoDream.hint": "Merge and settle fragmented memories in the background",
        "memory.features.sleepModeEnabled": "Sleep mode",
        "memory.features.sleepModeEnabled.hint": "Layered compaction during idle periods",
        "memory.features.hybridInject": "Hybrid injection",
        "memory.features.hybridInject.hint": "Merge keyword + vector recall before injecting",
        "memory.features.selectiveInjectEnabled": "Selective injection",
        "memory.features.selectiveInjectEnabled.hint": "Only inject memories worth carrying, filtered by relevance",
        "memory.features.adaptiveThresholdEnabled": "Adaptive threshold",
        "memory.features.adaptiveThresholdEnabled.hint": "Adjust the relevance floor with recall quality",
        "memory.features.reflectionUpdateEnabled": "Reflective update",
        "memory.features.reflectionUpdateEnabled.hint": "Allow consolidation to revise existing memories",
        "memory.features.distill": "Distillation & rate limiting",
        "memory.features.distillRateLimitIntervalMs": "Distill spacing (ms)",
        "memory.features.distillRateLimitRetries": "429 retries",
        "memory.features.distillRateLimitBaseDelayMs": "Backoff base delay (ms)",
        "memory.features.distillMaxChars": "Transcript cap (chars)",
        "memory.features.codingBoostFactor": "Coding boost factor",
        "memory.features.memoryQualityFilter.enabled": "Memory quality filter",
        "memory.features.memoryQualityFilter.enabled.hint": "Archive low-value memories automatically; injection downranks by quality",
        "memory.features.llmAudit.enabled": "Background call audit",
        "memory.features.llmAudit.enabled.hint": "Log background model calls and token usage from consolidation / summaries",
        "memory.features.bm25SearchEnabled": "BM25 keyword search",
        "memory.features.bm25SearchEnabled.hint": "Classic keyword scoring, complementary to vector recall",
        "memory.features.conflictFreezeEnabled": "Conflict freezing",
        "memory.features.conflictFreezeEnabled.hint": "Freeze contradictory memories for confirmation during consolidation",
        "memory.features.trustEpistemicWeighting": "Credibility weighting",
        "memory.features.trustEpistemicWeighting.hint": "Adjust recall ranking by source credibility (experimental)",
        "memory.features.reflectionFailureTracking": "Reflection failure tracking",
        "memory.features.reflectionFailureTracking.hint": "Record failed consolidation decisions for later improvement",
        "memory.features.embedRoute": "Semantic search route",
        "memory.features.embedProvider": "Embedding provider",
        "memory.features.embedProvider.openai": "OpenAI-compatible API",
        "memory.features.embedProvider.local": "Local model (offline)",
        "memory.features.embedProvider.ollama": "Ollama",
        "memory.features.embedProvider.openai.hint": "Endpoint / key / model live in the Vector Search card below",
        "memory.features.embedProvider.local.hint": "First use downloads the model; fully offline afterwards",
        "memory.features.embedProvider.ollama.hint": "Requires a local Ollama server",
        "memory.features.localEmbedModel": "Local embedding model",
        "memory.features.ollamaBaseUrl": "Ollama server URL",
        "memory.features.ollamaModel": "Ollama model",
        "memory.features.dreamProvider": "Consolidation provider",
        "memory.features.dreamModel": "Consolidation model",
        "memory.features.dreamModelHint": "Leave empty to follow the main conversation model; only affects autoDream consolidation",
        "memory.features.sleepProvider": "Sleep provider",
        "memory.features.sleepModel": "Sleep model",
        "memory.features.sleepModelHint": "Leave empty to reuse the consolidation model; a non-reasoning model is recommended",
        "memory.features.routeFollowDefault": "Follow default route",
        "memory.features.modelTest": "Test connectivity",
        "memory.features.modelTesting": "Testing…",
        "memory.features.modelTestOk": "Connected",
        "memory.features.modelTestFail": "Test failed",
        "memory.features.modelTestHint": "Fires one minimal consolidation call to verify provider/model connectivity and effort support",
        "memory.explorer.viewCards": "Cards",
        "memory.explorer.viewTimeline": "Timeline",
        "memory.explorer.viewAria": "Switch view",
        "memory.explorer.dateLabel": "Time",
        "memory.explorer.date.all": "All time",
        "memory.explorer.date.7d": "Last 7 days",
        "memory.explorer.date.30d": "Last 30 days",
        "memory.explorer.date.90d": "Last 90 days",
        "memory.explorer.more": "More actions",
        "memory.explorer.exportJson": "Export JSON",
        "memory.explorer.exportMarkdown": "Export Markdown",
        "memory.explorer.importMd": "Import Markdown mirror…",
        "memory.explorer.importTitle": "Import Markdown mirror",
        "memory.explorer.importHint": "Pick a Markdown mirror file; its manual edits are parsed and merged into the store.",
        "memory.explorer.importType": "Mirror type",
        "memory.explorer.importPick": "Choose file…",
        "memory.explorer.importConfirm": "Import",
        "memory.explorer.importCancel": "Cancel",
        "memory.explorer.importing": "Importing…",
        "memory.explorer.imported": "Merged {n} edits",
        "memory.explorer.importFailed": "Import failed",
        "memory.explorer.importNoFile": "Choose a file first",
        "memory.explorer.exportFailed": "Export failed",
        "memory.explorer.conflictBadge": "Conflict",
        "memory.explorer.archivedBadge": "Archived",
        "memory.explorer.detail.edit": "Edit",
        "memory.explorer.detail.save": "Save",
        "memory.explorer.detail.cancel": "Cancel",
        "memory.explorer.detail.archive": "Archive",
        "memory.explorer.detail.restore": "Restore",
        "memory.explorer.detail.restored": "Restored to the main list",
        "memory.explorer.detail.archived": "Archived",
        "memory.explorer.detail.archiveFailed": "Action failed",
        "memory.explorer.detail.saved": "Saved; mirrors re-rendered",
        "memory.explorer.detail.quality": "Quality",
        "memory.explorer.detail.entities": "Related entities",
        "memory.explorer.detail.entitiesEmpty": "Turn on entity extraction and related people / projects appear here",
        "memory.explorer.detail.closeAria": "Close details",
        "memory.explorer.detail.editTitle": "Title",
        "memory.explorer.detail.editContent": "Content",
        "memory.explorer.detail.editImportance": "Importance",
        "memory.status.dream": "Last consolidation",
        "memory.status.dreamNever": "Not yet run",
        "memory.status.conflicts": "Pending conflicts",
        "memory.status.conflictsHint": "Frozen contradictory memories awaiting confirmation",
        "memory.status.workbench": "Activity",
        "memory.status.dreamConsolidate": "Consolidation",
        "memory.status.summarize": "Summarization",
        "memory.status.tokens": "{n} tokens",
        "memory.status.deposited": "{n} memories deposited",
        "memory.status.failed": "failed",
        "memory.status.success": "success",
        "memory.status.skipped": "skipped",
        "memory.status.emptyFeed": "No background activity yet: memories are distilled after conversations",
        "memory.status.consolidated": "Deposited memories",
        "memory.status.consolidatedEmpty": "Memories deposited by autoDream / autoSummarize appear here",
        "memory.status.archivedMemories": "Archived memories",
        "memory.status.heatDistribution": "Heat distribution",
        "memory.status.heatHint": "hot (≥66%) {hot} · warm (33–66%) {warm} · cooled (<33%) {cold}, sampled from the latest {sample}",
        "memory.status.viewAll": "View all",
        "memory.status.depositedCount": "Deposited memories ({n})",
        "memory.status.archivedCount": "Archived memories ({n})",
        "memory.status.archivedEmpty": "Nothing archived",
        "memory.status.restore": "Restore",
        "memory.settings.extapi.reveal": "Reveal",
        "memory.settings.extapi.hide": "Hide",
        "memory.settings.extapi.maskHint": "Token masked; Copy still copies the full value",
        "memory.explorer.delete": "Delete",
        "memory.explorer.confirmDelete": "Confirm delete?",
        "memory.explorer.cancel": "Cancel",
        "memory.explorer.deleted": "Deleted",
        "memory.explorer.deleteFailed": "Delete failed",
        "memory.status.memories": "Total memories",
        "memory.status.entities": "Entities",
        "memory.status.vector": "Vector index",
        "memory.status.vectorOff": "Disabled",
        "memory.status.vectorInit": "Initializing",
        "memory.status.vectorInitHint": "embedder unreachable, retrying",
        "memory.status.vectorRuntimeMissing": "Local inference runtime missing",
        "memory.status.vectorRuntimeHint": "Local inference runtime not ready ({status})",
        "memory.status.vectorRuntimeCost": "Local vectorization needs an extra local inference runtime (the transformers + onnxruntime closure, ~247 MB unpacked). The button below first tries to adopt an existing copy on this machine (hardlinked when on the same volume, so no extra disk), and otherwise fetches it from npm against a pinned manifest (every tarball checked against its sha512). You can also just ask the agent, or run it yourself: node scripts/mneme-runtime.mjs status / adopt [--from <node_modules>] / verify (see docs/LOCAL_MODEL.md §2.5).",
        "memory.status.vectorRuntimeReady": "Runtime ready",
        "memory.status.vectorRuntimeReadyHint": "Local embedder is not initialized yet (the in-process embedder already failed while the runtime was missing): restart DSH if this persists.",
        "memory.status.vectorRuntimeFetch": "Fetch local runtime",
        "memory.status.vectorRuntimeFetchBusy": "Fetching… (tries adopt first, may download — thousands of files)",
        "memory.status.vectorRuntimeFetchAdopted": "Adopted the runtime already on this machine: {n} packages / {m} files ({mode}). Restart DSH if the status does not update",
        "memory.status.vectorRuntimeFetchDownloaded": "Fetched the runtime from npm: {n} packages / {m} files. Restart DSH if the status does not update",
        "memory.status.vectorRuntimeFetchFailed": "Fetch failed: {reason}",
        "memory.status.vectorIndexed": "Indexed {n} / {m} items",
      "memory.status.vectorUnconfigured": "Not configured",
      "memory.status.vectorUnconfiguredHint": "No embedding endpoint/model configured — semantic recall is off",
      "memory.status.vectorDegradedHint": "Indexed 0 / {m} items — semantic recall is effectively unavailable",
        "memory.status.llm": "LLM Usage",
        "memory.status.llmCalls": "Last 7 days · {n} calls",
        "memory.status.error": "Failed to load"
      }
    };

    function typeLabel(t, type) {
      const key = `memory.tab.${type}`;
      const label = t(key);
      return label && label !== key ? label : String(type);
    }

    // Entity types live under their own i18n subtree (person/project/...);
    // unknown or "other" falls back to the raw type string.
    function entityTypeLabel(t, type) {
      const key = `memory.entity.${type}`;
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
      // --- explorer shell: container queries let the toolbar adapt to the
      // better-sidebar workbench pane (~500px) as well as the 1240px sheet ---
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
      ".mneme-routeselect{width:240px;max-width:60%}",
      ".mneme-footbtn{border:none;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:12px;line-height:16px;padding:3px 8px;border-radius:6px}",
      ".mneme-footbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".mneme-hint{color:var(--dsw-alias-label-tertiary);padding:24px 0;text-align:center;font-size:13px}",
      ".mneme-entitychip{flex:none;height:26px;padding:0 10px;border-radius:8px;border:none;background:none;color:var(--dsw-alias-state-business-primary);cursor:pointer;font-family:inherit;font-size:12px;line-height:16px;display:inline-flex;align-items:center}",
      ".mneme-entitychip:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}",
      // --- main-area memory library page ---
      ".mneme-x{flex:1;min-height:0;height:100%;width:100%;box-sizing:border-box;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);container-type:inline-size}",
      // 窄容器（better-sidebar 工作台 ~500px）下中央 vtabs 会与右缘悬浮的
      // 卡片/时间线切换器重叠：容器查询收窄时隐藏切换器，视图模式沿用
      // localStorage 记忆，宽容器（sheet）不受影响。
      "@container (max-width: 640px){.mneme-xtools .mneme-seg{display:none}}",
      ".mneme-xbar{position:relative;flex:none;display:flex;align-items:center;justify-content:center;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l2);padding:0 16px;min-height:52px}",
      ".mneme-filterbar{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".mneme-vtabs{display:flex;align-items:stretch;height:46px}",
      ".mneme-vtab{position:relative;border:0;background:none;cursor:pointer;padding:0 16px;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:14px;font-weight:500;line-height:20px;display:inline-flex;align-items:center;gap:7px}",
      ".mneme-vtab:hover{color:var(--dsw-alias-label-primary)}",
      ".mneme-vtab.mneme-active{color:var(--dsw-alias-state-business-primary)}",
      ".mneme-vtab.mneme-active::after{content:\"\";position:absolute;left:10px;right:10px;bottom:-1px;height:2.5px;border-radius:2px;background:var(--dsw-alias-state-business-primary)}",
      // transform 会自建层叠上下文：层级必须给在容器上——3 高于吸顶月份头(2)、
      // 低于详情抽屉(6)，下拉菜单/导入对话框随容器整体上浮。
      ".mneme-xtools{position:absolute;right:14px;top:50%;transform:translateY(-50%);display:flex;align-items:center;gap:8px;padding:0;z-index:3}",
      ".mneme-xcount{flex:none;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
      // --- three-column browse layout: hairline separators, no outer box ---
      ".mneme-xmain{flex:1;min-height:0;display:flex;flex-direction:row;overflow:hidden}",
      ".mneme-xside{flex:none;width:236px;min-width:0;min-height:0;overflow-y:auto;padding:16px 14px;border-right:1px solid var(--dsw-alias-border-l2);box-sizing:border-box;display:flex;flex-direction:column;gap:8px}",
      ".mneme-xside--filter{width:214px}",
      ".mneme-xbrowse{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}",
      ".mneme-xrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".mneme-xsearch{width:100%}",
      ".mneme-xselect{flex:1;min-width:0}",
      ".mneme-xcolhead{flex:none;font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:2px 8px 8px}",
      ".mneme-xtype{display:flex;justify-content:flex-start;align-items:center;gap:8px;width:100%;padding:5px 8px;border:none;border-radius:8px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:13px;line-height:18px;text-align:left}",
      ".mneme-xtype:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-xtype.mneme-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:500}",
      ".mneme-xcount2{flex:none;margin-left:auto;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
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
      ".mneme-xempty{padding:18px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}",
      // --- memory-type color dots (mirrored across filter / timeline / detail) ---
      ".mneme-xdot{flex:none;display:inline-block;width:8px;height:8px;border-radius:50%;background:currentColor}",
      ".mneme-xdot--all{background:transparent;border:1.5px solid currentColor;opacity:.55;box-sizing:border-box}",
      ".mneme-xitem .mneme-xdot{align-self:center}",
      // --- detail column (preview pane sits BELOW the timeline: the list is
      // the primary scan target, the detail grows only when something is
      // selected so the empty state never eats the viewport) ---
      ".mneme-xdetail{flex:none;max-height:56%;min-height:0;overflow-y:auto;padding:12px 20px 16px;border-top:1px solid var(--dsw-alias-border-l2)}",
      ".mneme-xtree{flex:1;min-height:0;overflow-y:auto;padding:8px 10px 28px}",
      ".mneme-xdinner{max-width:720px}",
      ".mneme-xdtitle{font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary);margin-bottom:10px;word-break:break-word}",
      ".mneme-xdmeta{display:flex;flex-wrap:wrap;gap:4px 14px;margin-bottom:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      ".mneme-xdsrc{display:inline-block;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}",
      ".mneme-xdcontent{margin-top:14px;font-size:14px;line-height:1.75;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}",
      ".mneme-xdactions{display:flex;gap:8px;margin-top:18px}",
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
      // --- entity explorer: rail + layered detail (entities → attrs → relations → graph) ---
      ".mneme-ent{flex:1;min-height:0;display:flex;overflow:hidden}",
      ".mneme-entrail{flex:none;width:224px;min-height:0;overflow-y:auto;padding:12px;border-right:1px solid var(--dsw-alias-border-l2);box-sizing:border-box;display:flex;flex-direction:column;gap:4px}",
      ".mneme-enttype{display:flex;align-items:center;gap:6px;width:100%;padding:8px 8px 2px;border:none;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-family:inherit;font-size:11px;font-weight:600;line-height:16px;text-align:left;letter-spacing:.02em}",
      ".mneme-entitem{display:flex;align-items:center;gap:8px;width:100%;padding:5px 8px;border:none;border-radius:8px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:13px;line-height:18px;text-align:left}",
      ".mneme-entitem:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-entitem.mneme-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}",
      ".mneme-entname{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".mneme-entmentions{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
      ".mneme-entdetail{flex:1;min-width:0;min-height:0;overflow-y:auto;padding:20px 24px 32px;box-sizing:border-box}",
      ".mneme-entinner{max-width:720px}",
      ".mneme-enttitle{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary);word-break:break-word}",
      ".mneme-enttitle .mneme-xdot{width:10px;height:10px}",
      ".mneme-entmeta{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      ".mneme-layer{margin-top:24px}",
      ".mneme-layerhead{display:flex;align-items:baseline;gap:8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:10px}",
      ".mneme-layercount{font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary)}",
      ".mneme-attrgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}",
      ".mneme-attrcard{min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 12px}",
      ".mneme-attrkey{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".mneme-attrval{font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary);word-break:break-word}",
      ".mneme-relrow{display:flex;align-items:center;gap:10px;width:100%;padding:7px 10px;border:none;border-radius:10px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:13px;line-height:20px;text-align:left}",
      ".mneme-relrow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-reltype{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-state-business-primary);border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 35%,transparent);border-radius:6px;padding:0 6px}",
      ".mneme-relname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      // --- settings: quiet stacked sections, one concern per section ---
      ".mneme-set{flex:1;min-height:0;overflow-y:auto;padding:8px 24px 48px;box-sizing:border-box}",
      ".mneme-set-inner{max-width:720px;margin:0 auto}",
      ".mneme-set-sec{padding:20px 0 24px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".mneme-set-sec:last-child{border-bottom:none}",
      ".mneme-set-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:4px}",
      ".mneme-set-desc{font-size:13px;line-height:19px;color:var(--dsw-alias-label-tertiary);margin-bottom:14px}",
      ".mneme-set-input{box-sizing:border-box;width:100%;height:34px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;outline:none;margin-bottom:10px;transition:border-color .12s,box-shadow .12s}",
      ".mneme-set-input:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent)}",
      ".mneme-set-input::placeholder{color:var(--dsw-alias-label-tertiary)}",
      ".mneme-set-input--area{height:auto;min-height:76px;padding:8px 12px;resize:vertical;line-height:1.6}",
      ".mneme-btn{flex:none;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;font-size:12px;line-height:16px;display:inline-flex;align-items:center;gap:6px}",
      ".mneme-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-btn:disabled{opacity:.5;cursor:default}",
      ".mneme-saved{font-size:12px;color:var(--dsw-alias-state-success,#2a7)}",
      // rule rows: numbered chips + hover-revealed delete
      ".mneme-set-row{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;margin-bottom:8px;background:var(--dsw-alias-bg-base,transparent)}",
      ".mneme-set-idx{flex:none;width:20px;height:20px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;display:inline-flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}",
      ".mneme-set-ruletext{flex:1;min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);word-break:break-word}",
      ".mneme-set-del{flex:none;opacity:0;transition:opacity .12s;border:none;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px;line-height:20px;padding:0 4px;border-radius:6px}",
      ".mneme-set-row:hover .mneme-set-del,.mneme-set-row:focus-within .mneme-set-del{opacity:1}",
      ".mneme-set-del:hover{color:var(--dsw-alias-state-error,#c33);background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-set-cmd{flex:1;min-width:0}",
      ".mneme-set-cmdname{font-size:13px;font-weight:600;color:var(--dsw-alias-state-business-primary)}",
      ".mneme-set-cmddesc{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary);margin-top:1px;word-break:break-word}",
      // --- settings sub-view ---
      ".mneme-set{flex:1;min-height:0;overflow-y:auto;padding:8px 24px 48px;box-sizing:border-box}",
      // --- 记忆库页面：居中 sheet，非全屏 ---
      // 从对话直接打开一页记忆库：背板压暗 + 居中圆角卡片（上限 1180×880），
      // 对话仍留在背板之后，任何状态下（含新会话 hero、无 tab 环）都可用。
      // portal 到 <body>，宿主侧边栏的层叠上下文裁不住它。
      ".mneme-backdrop{position:fixed;inset:0;z-index:999;background:color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);backdrop-filter:blur(2px);animation:mneme-fadein .14s ease-out}",
      ".mneme-overlay{position:fixed;z-index:1000;left:50%;top:50%;transform:translate(-50%,-50%);width:min(1240px,calc(100vw - 88px));height:min(920px,calc(100vh - 64px));display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);box-shadow:0 24px 64px color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent);animation:mneme-pop .18s cubic-bezier(.2,.9,.3,1)}",
      ".mneme-overlaybar{flex:none;display:flex;align-items:center;justify-content:space-between;height:48px;padding:0 12px 0 18px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".mneme-overlaytitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:8px}",
      ".mneme-overlaybody{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}",
      "@keyframes mneme-fadein{from{opacity:0}to{opacity:1}}",
      "@keyframes mneme-pop{from{opacity:0;transform:translate(-50%,-50%) scale(.98)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}",
      // --- 侧边栏顶部入口：借宿主「新会话」按钮的原生类名对齐 ---
      // wrapper display:contents 隐身，按钮成为侧边栏弹性布局的直接子元素；
      // 盒模型/间距/收起态 rail 几何全部继承宿主，我们只覆盖配色为次级观感。
      ".mneme-stars{display:inline-flex;align-items:center;gap:2px}",
      // 热度徽章三档：热（橙）/温（次级文字）/冷（弱化文字），冷档藏百分比只留图标。
      ".mneme-heat{display:inline-flex;align-items:center;gap:2px;font-size:11px;line-height:14px;font-variant-numeric:tabular-nums}",
      ".mneme-heat--hot{color:var(--dsw-alias-state-warning,#d97706)}",
      ".mneme-heat--warm{color:var(--dsw-alias-label-secondary)}",
      ".mneme-heat--cold{color:var(--dsw-alias-label-tertiary)}",
      ".mneme-heat--cold .mneme-heatpct{display:none}",
      // 纵向 flex 容器按原生按钮的宽度与外边距分配空间，保留展开和收起态的对齐。
      ".mneme-topentry{display:flex;flex-direction:column}",
      ".mneme-topentry-native{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
      ".mneme-topentry-native:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".mneme-topentry-native .mneme-topentry-label{white-space:nowrap}",
      // --- 功能开关：一行一开关，Claude 式安静排版 ---
      ".mneme-featgroup{flex:none;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary);margin:16px 0 2px}",
      ".mneme-featrow{display:flex;align-items:center;gap:14px;padding:11px 2px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".mneme-featrow:last-child{border-bottom:none}",
      ".mneme-featmain{flex:1;min-width:0}",
      ".mneme-featname{font-size:13.5px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}",
      ".mneme-feathint{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin-top:2px}",
      ".mneme-switch{position:relative;flex:none;width:36px;height:22px;border-radius:11px;border:none;cursor:pointer;background:var(--dsw-alias-interactive-bg-active);transition:background .15s}",
      ".mneme-switch::after{content:\"\";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 3px color-mix(in srgb,var(--dsw-alias-label-primary) 25%,transparent);transition:transform .15s}",
      ".mneme-switch.mneme-on{background:var(--dsw-alias-state-business-primary)}",
      ".mneme-switch.mneme-on::after{transform:translateX(14px)}",
      ".mneme-switch:disabled{opacity:.5;cursor:default}",
      ".mneme-featnum{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 2px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".mneme-featnum:last-child{border-bottom:none}",
      ".mneme-featnumlabel{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}",
      ".mneme-numinput{box-sizing:border-box;width:110px;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;outline:none;text-align:right;transition:border-color .12s,box-shadow .12s}",
      ".mneme-numinput:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent)}",
      // 字符串开关的输入框（provider/model 等）与其子块容器
      ".mneme-strinput{box-sizing:border-box;width:240px;max-width:60%;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;outline:none;text-align:left;transition:border-color .12s,box-shadow .12s}",
      ".mneme-feed-link{display:block;color:var(--dsw-alias-brand,var(--dsw-alias-label-primary));text-decoration:none;font-size:13px;line-height:20px;padding:4px 2px;border-radius:6px;transition:opacity .12s}.mneme-feed-link:hover{opacity:.8;text-decoration:underline}",
      ".mneme-strinput:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent)}",
      ".mneme-featsub{margin:2px 0 8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;display:flex;flex-direction:column;gap:6px}",
      ".mneme-featsub .mneme-featnum{padding:6px 0;border-bottom:none}",
      ".mneme-featsubhint{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}",
      // --- 交互式记忆库：工具栏 / 卡片网格 / 详情抽屉 / 更多菜单 ---
      // sheet 边距放宽：与窗口边缘保持呼吸距离，居中不顶满。
      // 视图切换（卡片/时间线）分段控件挂在子页栏右侧。
      ".mneme-seg{display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}",
      ".mneme-seg button{border:none;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-family:inherit;font-size:12px;line-height:16px;padding:5px 10px;display:inline-flex;align-items:center;gap:5px}",
      ".mneme-seg button:hover{color:var(--dsw-alias-label-primary)}",
      ".mneme-seg button.mneme-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:500}",
      // 卡片网格：响应式 auto-fill，卡片悬停轻浮起
      ".mneme-cards{flex:1;min-height:0;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(252px,1fr));gap:14px;padding:20px 24px 32px;align-content:start}",
      ".mneme-card{display:flex;flex-direction:column;gap:7px;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 13px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;font-family:inherit;text-align:left;transition:border-color .12s,box-shadow .12s,transform .12s}",
      ".mneme-card:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,var(--dsw-alias-border-l2));box-shadow:0 6px 20px color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);transform:translateY(-1px)}",
      ".mneme-card.mneme-active{border-color:var(--dsw-alias-state-business-primary)}",
      ".mneme-cardhead{display:flex;align-items:center;gap:6px;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      ".mneme-cardtitle{font-size:13.5px;font-weight:600;line-height:19px;color:var(--dsw-alias-label-primary);word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
      ".mneme-cardexcerpt{font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}",
      ".mneme-cardfoot{display:flex;align-items:center;gap:8px;margin-top:auto;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      ".mneme-cardsrc{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      // 徽章：冲突待确认 / 已归档
      ".mneme-badge{flex:none;display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 7px;border-radius:6px;font-size:11px;line-height:14px}",
      ".mneme-badge--conflict{color:var(--dsw-alias-state-error,#c33);background:color-mix(in srgb,var(--dsw-alias-state-error,#c33) 10%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error,#c33) 30%,transparent)}",
      ".mneme-badge--archived{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover)}",
      // 详情抽屉：sheet 内右侧滑出，覆盖在浏览区之上
      ".mneme-xmain{position:relative}",
      "@keyframes mneme-slidein{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:translateX(0)}}",
      ".mneme-drawer{position:absolute;top:0;right:0;bottom:0;width:min(432px,52%);display:flex;flex-direction:column;border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:-16px 0 40px color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);animation:mneme-slidein .18s ease-out;z-index:6}",
      ".mneme-drawerbar{flex:none;display:flex;align-items:center;gap:8px;height:44px;padding:0 10px 0 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
      ".mneme-drawertype{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-secondary)}",
      ".mneme-drawerbody{flex:1;min-height:0;overflow-y:auto;padding:20px 22px 28px}",
      ".mneme-drawertitle{width:100%;font-size:16px;font-weight:600;line-height:23px;color:var(--dsw-alias-label-primary);word-break:break-word}",
      ".mneme-drawertitle-input{width:100%;box-sizing:border-box;font-size:15px;font-weight:600;line-height:22px;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent)}",
      ".mneme-dmeta{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin-top:12px;font-size:12.5px;line-height:19px}",
      ".mneme-dmetakey{color:var(--dsw-alias-label-tertiary)}",
      ".mneme-dmetaval{color:var(--dsw-alias-label-secondary);min-width:0;word-break:break-word}",
      ".mneme-dcontent{margin-top:14px;font-size:13.5px;line-height:1.75;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}",
      ".mneme-dcontent-input{width:100%;box-sizing:border-box;min-height:180px;font-size:13.5px;line-height:1.7;padding:9px 11px;border-radius:8px;border:1px solid var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font-family:inherit;outline:none;resize:vertical;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent)}",
      ".mneme-dentities{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}",
      ".mnementity-chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);cursor:default}",
      ".mneme-dactions{flex:none;display:flex;flex-wrap:wrap;gap:8px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l2)}",
      // 更多操作菜单（导入/导出）与导入弹层
      ".mneme-menuwrap{position:relative}",
      ".mneme-menu{position:absolute;right:0;top:calc(100% + 6px);min-width:180px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 32px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);padding:5px;z-index:20;animation:mneme-fadein .1s ease-out}",
      ".mneme-menu button{display:flex;align-items:center;gap:8px;width:100%;border:none;background:none;color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;font-size:13px;line-height:18px;padding:8px 10px;border-radius:8px;text-align:left}",
      ".mneme-menu button:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mneme-impdialog{position:absolute;right:0;top:calc(100% + 6px);width:300px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 32px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);padding:14px;z-index:20;animation:mneme-fadein .1s ease-out}",
      ".mneme-improw{display:flex;align-items:center;gap:8px;margin-top:10px}",
      // 瞬时操作提示（删除/归档）：挂在浏览层底部居中，不被抽屉卸载吞掉
      ".mneme-x{position:relative}",
      ".mneme-toast{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1);font-size:12.5px;line-height:18px;padding:7px 16px;border-radius:10px;z-index:30;box-shadow:0 8px 24px color-mix(in srgb,var(--dsw-alias-label-primary) 25%,transparent);animation:mneme-fadein .15s ease-out}",
      // --- explorer refresh: paged month tree, sticky headers, inline icons ---
      ".mneme-vtabico{flex:none;opacity:.85}",
      ".mneme-xsearchwrap{position:relative;flex:none}",
      ".mneme-xsearchico{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--dsw-alias-label-tertiary);pointer-events:none}",
      ".mneme-xsearchwrap .mneme-xsearch{padding-left:27px}",
      ".mneme-footbtn{display:inline-flex;align-items:center;gap:4px}",
      ".mneme-xmonth{position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-layer-1);display:flex;align-items:center;gap:6px}",
      ".mneme-xmonthcount{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-weight:400;font-variant-numeric:tabular-nums}",
      ".mneme-xcaret{display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}",
      ".mneme-xmore{display:flex;justify-content:center;align-items:center;padding:10px 0 24px;min-height:20px}",
      ".mneme-xemptyico{display:block;margin:0 auto 6px;opacity:.7}",
      // --- status sub-view: responsive stat-card grid (auto-fill, ~220px min) ---
      ".mneme-status{flex:1;min-height:0;overflow-y:auto;padding:20px 24px 40px;box-sizing:border-box}",
      ".mneme-statusgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;max-width:1000px;margin:0 auto}",
      ".mneme-statuscard{min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px}",
      // --- 状态页工作台：让用户看见插件在干活（动态/沉淀/归档） ---
      ".mneme-wbhead{margin:28px auto 10px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);max-width:1000px;display:flex;align-items:baseline;justify-content:space-between;gap:8px}",
      ".mneme-wblist{max-width:1000px;display:flex;flex-direction:column;gap:6px}",
      ".mneme-wbrow{display:flex;gap:10px;align-items:flex-start;padding:10px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}",
      ".mneme-wbdot{flex:none;width:8px;height:8px;border-radius:50%;margin-top:6px;background:var(--dsw-alias-state-success,#2a9d6a)}",
      ".mneme-wbdot--err{background:var(--dsw-alias-state-error,#c33)}",
      ".mneme-wbmain{min-width:0;flex:1}",
      ".mneme-wbtitle{font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary)}",
      ".mneme-wbsub{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary);margin-top:1px}",
      ".mneme-wbmemo{display:flex;gap:10px;align-items:center;padding:10px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}",
      ".mneme-wbmemo .mneme-xdot{flex:none}",
      ".mneme-wbmemo-main{min-width:0;flex:1}",
      ".mneme-statusnum{font-size:24px;font-weight:600;line-height:32px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}",
      ".mneme-statuscap{margin-top:4px;font-size:13px;line-height:19px;color:var(--dsw-alias-label-tertiary);word-break:break-word}",
      // --- destructive actions: red outline = delete, solid red = confirm ---
      ".mneme-btndanger{color:var(--dsw-alias-state-error,#c33);border-color:var(--dsw-alias-state-error,#c33)}",
      ".mneme-btndanger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error,#c33) 12%,transparent)}",
      ".mneme-btndangerconfirm{background:var(--dsw-alias-state-error,#c33);border-color:var(--dsw-alias-state-error,#c33);color:#fff}",
      ".mneme-btndangerconfirm:hover{filter:brightness(.9)}",
      // --- settings cards: boxed cards for the runtime-mode and external-API
      // sections — each card owns its fetch/PUT state, so it renders as a
      // self-contained unit inside the stacked settings view ---
      ".mneme-set-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px;margin-bottom:12px}",
      ".mneme-set-token{font-family:monospace;font-size:12px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);word-break:break-all;user-select:all}",
      ".mneme-set-hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}"
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

    // Memory-type → dot fill, shared by the type filter, timeline rows and the
    // detail meta so one hue always means one memory type across the panel.
    // Same palette rules as TYPE_COLORS: fixed hues, medium saturation,
    // similar luminance, legible on light and dark themes.
    const MEMORY_TYPE_COLORS = {
      preference: "#f59e0b",
      project: "#22c55e",
      decision: "#3b82f6",
      summary: "#a855f7",
      history: "#94a3b8",
      // codingRetrospect 的三类编码记忆：警示色区分度最高——踩坑/被否决方案
      // 天然带"注意"语义，工程约束用冷色表达"规则"。
      rejected_solution: "#fb923c",
      pitfall: "#ef4444",
      constraint: "#0ea5e9"
    };
    function memoryTypeColor(type) {
      return MEMORY_TYPE_COLORS[type] || "#94a3b8";
    }

    // Compact date for the detail meta ("2026/8/16"); the full timestamp
    // stays in the tooltip.
    function formatDateShort(value) {
      if (!value) return "—";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
    }
    // Graph canvas space: the svg's fixed viewBox. The simulation runs in
    // these user units — never in CSS pixels — so node positions always land
    // inside the drawn area; the browser scales the viewBox to whatever the
    // element's CSS size is (small window, hidden tab, maximized #72).
    const VIEW_W = 380, VIEW_H = 300;

    function nodeRadius(n) {
      // mention_count → area-ish growth, clamped so hubs stay legible.
      const base = 7 + Math.min(20, Math.max(1, n.mention_count ?? 1)) * 0.55;
      // heat projection (0-1 or null): hot entities render slightly larger.
      if (n.heat == null) return base;
      return base + (Math.max(0, Math.min(1, n.heat)) - 0.5) * 4;
    }

    function nodeOpacity(n) {
      // heat projection: hot entities are bright (opacity 1), cold fade to 0.4.
      if (n.heat == null) return 1;
      return 0.4 + 0.6 * Math.max(0, Math.min(1, n.heat));
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

    // --- Entity explorer: the entity-gene layers made visible ---
    // Rail = the entity directory (grouped by type, mention-ranked inside a
    // type). Detail = the layered structure from docs/ENTITIES.md:
    //   ① 属性  current snapshot of entity_attrs (saveAttr invalidates old rows)
    //   ② 关系  entity_relations touching the entity (from the 1-hop ego walk)
    //   ③ 关联记忆  memories recalled through the entity: prefix search
    //   ④ 关系图谱  the same ego graph the old graph-only tab drew
    function EntityPanel({ t, focusEntity, onJumpMemory }) {
      const [entities, setEntities] = useState(null); // null = still loading
      const [railQuery, setRailQuery] = useState("");
      const [entityName, setEntityName] = useState(focusEntity || "");
      const [depth, setDepth] = useState(1);
      const [data, setData] = useState(null);
      const [status, setStatus] = useState("idle"); // idle | loading | ready | notfound | error
      const [selected, setSelected] = useState(null); // { kind: "node"|"edge", node?|edge? }
      const [attrs, setAttrs] = useState([]);
      const [related, setRelated] = useState([]);
      const svgRef = useRef(null);
      const posRef = useRef([]); // live simulation positions, not React state
      const dragRef = useRef(null); // { id, moved }
      const viewRef = useRef({ x: 0, y: 0, k: 1 }); // pan/zoom viewport, viewBox units
      const [frame, setFrame] = useState(0); // re-render tick driven by the simulation

      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/entities?limit=500")
          .then((r) => (r.ok ? r.json() : { entities: [] }))
          .then((j) => { if (!cancelled) setEntities(Array.isArray(j.entities) ? j.entities : []); })
          .catch(() => { if (!cancelled) setEntities([]); });
        return () => { cancelled = true; };
      }, []);

      useEffect(() => {
        if (focusEntity && focusEntity !== entityName) {
          setEntityName(focusEntity);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [focusEntity]);

      // Auto-select the most recently seen entity so the layers are never a
      // dead end on first open (the rail still allows picking another one).
      useEffect(() => {
        if (!entities || entityName || entities.length === 0) return;
        setEntityName(entities[0].name);
      }, [entities, entityName]);

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

      // Layer data for the selected entity: current attrs + related memories.
      useEffect(() => {
        setAttrs([]);
        setRelated([]);
        if (!entityName) return;
        let cancelled = false;
        apiFetch(`/api/dsh-mneme/semantic/graph/entity-attrs?entity=${encodeURIComponent(entityName)}`)
          .then((r) => (r.ok ? r.json() : { attrs: [] }))
          .then((j) => { if (!cancelled) setAttrs(Array.isArray(j.attrs) ? j.attrs : []); })
          .catch(() => {});
        apiFetch(`/api/dsh-mneme/search?q=${encodeURIComponent("entity:" + entityName)}&limit=10`)
          .then((r) => (r.ok ? r.json() : { items: [] }))
          .then((j) => { if (!cancelled) setRelated(Array.isArray(j.items) ? j.items : []); })
          .catch(() => {});
        return () => { cancelled = true; };
      }, [entityName]);

      // Simulation: run in rAF against posRef, tick React only every few frames.
      // Re-seeds when data changes; dragging writes straight into posRef.
      useEffect(() => {
        if (!data || data.nodes.length === 0) return;
        // Bounds in viewBox units: measuring clientWidth here put the gravity
        // center and clamp range outside the 380-wide viewBox once the window
        // (or its hidden-then-shown container) got wide, and every node was
        // clipped off-canvas — the maximized-invisible bug (#72).
        posRef.current = initialPositions(data.nodes, VIEW_W, VIEW_H);
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
            node.vx += (VIEW_W / 2 - node.x) * 0.002;
            node.vy += (VIEW_H / 2 - node.y) * 0.002;
            if (node.pinned || node === dragRef.current?.node) { node.vx = 0; node.vy = 0; continue; }
            node.vx *= 0.85; node.vy *= 0.85;
            node.x = Math.max(nodeRadius(node) + 4, Math.min(VIEW_W - nodeRadius(node) - 4, node.x + node.vx));
            node.y = Math.max(nodeRadius(node) + 14, Math.min(VIEW_H - nodeRadius(node) - 14, node.y + node.vy));
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
        e.stopPropagation(); // node drag must not start a background pan
        dragRef.current = { node, moved: false };
        const startX = e.clientX, startY = e.clientY;
        const origX = node.x, origY = node.y;
        const svg = svgRef.current;
        const rect = svg.getBoundingClientRect();
        const scale = VIEW_W / Math.max(1, rect.width) / viewRef.current.k; // viewBox units per css px, zoom-aware
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

      // --- canvas pan & zoom ---
      // The viewport (translate + scale) lives in viewRef so the simulation
      // and the handlers share it without re-mounting; every mutation bumps
      // `frame` to re-render. Panning starts on the bare svg surface (node
      // mousedowns stopPropagation above); zooming is a native non-passive
      // wheel listener because React attaches wheel handlers passively and
      // could not preventDefault the page scroll.
      const svgToView = (clientX, clientY) => {
        const svg = svgRef.current;
        const rect = svg.getBoundingClientRect();
        const sx = VIEW_W / Math.max(1, rect.width);
        const sy = VIEW_H / Math.max(1, rect.height);
        return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
      };

      const onSurfaceMouseDown = (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const start = { x: e.clientX, y: e.clientY };
        const orig = { ...viewRef.current };
        const onMove = (ev) => {
          const rect = svgRef.current?.getBoundingClientRect();
          if (!rect) return;
          const sx = VIEW_W / Math.max(1, rect.width);
          const sy = VIEW_H / Math.max(1, rect.height);
          const v = viewRef.current;
          v.x = orig.x + (ev.clientX - start.x) * sx;
          v.y = orig.y + (ev.clientY - start.y) * sy;
          setFrame((f) => f + 1);
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      };

      useEffect(() => {
        const svg = svgRef.current;
        if (!svg) return undefined;
        const onWheel = (e) => {
          e.preventDefault();
          const v = viewRef.current;
          const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
          const k = Math.min(3, Math.max(0.5, v.k * factor));
          const s = svgToView(e.clientX, e.clientY);
          // keep the point under the cursor pinned while the scale changes
          const px = (s.x - v.x) / v.k;
          const py = (s.y - v.y) / v.k;
          v.k = k;
          v.x = s.x - px * k;
          v.y = s.y - py * k;
          setFrame((f) => f + 1);
        };
        svg.addEventListener("wheel", onWheel, { passive: false });
        return () => svg.removeEventListener("wheel", onWheel);
      });

      const resetView = () => {
        viewRef.current = { x: 0, y: 0, k: 1 };
        setFrame((f) => f + 1);
      };

      const nodes = posRef.current;
      const nodeById = new Map(nodes.map((n) => [n.id, n]));

      // --- rail: entity directory grouped by type ---
      const q = railQuery.trim().toLowerCase();
      const visibleEntities = (entities || []).filter((e) => !q || (e.name || "").toLowerCase().includes(q));
      const ENTITY_TYPE_ORDER = ["person", "project", "concept", "technology", "organization"];
      const groups = [];
      const byType = new Map();
      for (const e of visibleEntities) {
        const key = ENTITY_TYPE_ORDER.includes(e.type) ? e.type : "other";
        if (!byType.has(key)) { const g = { key, items: [] }; byType.set(key, g); groups.push(g); }
        byType.get(key).items.push(e);
      }

      const entity = entities?.find((e) => e.name === entityName) || null;
      const rootEdges = (data?.edges || []).filter((e) => e.from === data?.root?.id || e.to === data?.root?.id);
      const graphStatus = status === "ready" && data && data.nodes.length <= 1 ? "empty" : status;

      const rail = h("div", { className: "mneme-entrail" },
        h("div", { className: "mneme-xcolhead" }, t("memory.view.label")),
        h("input", {
          className: "mneme-search mneme-xsearch",
          placeholder: t("memory.graph.placeholder"),
          value: railQuery,
          onChange: (e) => setRailQuery(e.target.value)
        }),
        entities === null && h("div", { className: "mneme-xempty" }, "…"),
        entities !== null && entities.length === 0 && h("div", { className: "mneme-xempty" }, t("memory.entities.none")),
        entities !== null && entities.length > 0 && h("div", { className: "mneme-xcount" },
          t("memory.entities.count").replace("{n}", String(entities.length))),
        groups.map((g) => h("div", { key: g.key },
          h("div", { className: "mneme-enttype" },
            h("span", { className: "mneme-xdot", style: { color: typeColor(g.key === "other" ? null : g.key) }, "aria-hidden": "true" }),
            entityTypeLabel(t, g.key)
          ),
          g.items.map((e) => h("button", {
            key: e.id,
            className: e.name === entityName ? "mneme-entitem mneme-active" : "mneme-entitem",
            onClick: () => setEntityName(e.name)
          },
            h("span", { className: "mneme-entname" }, e.name),
            h("span", { className: "mneme-entmentions" }, `×${e.mention_count ?? 1}`)
          ))
        ))
      );

      // side card for a clicked (non-root) node or edge inside the graph layer
      const side = selected?.kind === "node"
        ? h("div", { className: "mneme-graphside" },
            h("div", { className: "mneme-gs-title" },
              h("span", null, selected.node.name),
              h("span", { className: "mneme-gs-meta" },
                `${entityTypeLabel(t, selected.node.type || "concept")} · ★${selected.node.mention_count ?? 1}`)
            ),
            selected.node.name !== entityName && h("button", {
              className: "mneme-footbtn",
              onClick: () => setEntityName(selected.node.name)
            }, t("memory.graph.viewInGraph")),
            attrs.length > 0 && h("div", null,
              h("div", { className: "mneme-gs-meta" }, t("memory.graph.attrs")),
              attrs.map((a, i) => h("div", { key: i, className: "mneme-gs-attr" },
                h("span", { className: "mneme-gs-attrkey" }, `${a.key}:`),
                h("span", { className: "mneme-gs-attrval" }, a.value)
              ))
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

      const detail = h("div", { className: "mneme-entdetail" },
        h("div", { className: "mneme-entinner" },
          status === "idle" && h("div", { className: "mneme-hint" }, t("memory.entities.pick")),
          status === "loading" && h("div", { className: "mneme-hint" }, t("memory.graph.loading")),
          status === "notfound" && h("div", { className: "mneme-hint" }, t("memory.graph.notFound")),
          status === "error" && h("div", { className: "mneme-hint" }, t("memory.panel.empty")),
          status === "ready" && entity && h(react.Fragment, null,
            h("div", { className: "mneme-enttitle" },
              h("span", { className: "mneme-xdot", style: { color: typeColor(entity.type) }, "aria-hidden": "true" }),
              entity.name
            ),
            h("div", { className: "mneme-entmeta" },
              h("span", null, entityTypeLabel(t, entity.type || "other")),
              h("span", null, t("memory.entities.mentions").replace("{n}", String(entity.mention_count ?? 1))),
              h("span", { title: formatDate(entity.last_seen) },
                `${t("memory.entities.lastSeen")}: ${formatRelativeTime(entity.last_seen, t)}`)
            ),
            // ① 属性 — current snapshot (valid_until IS NULL)
            h("div", { className: "mneme-layer" },
              h("div", { className: "mneme-layerhead" },
                t("memory.entities.attrs"),
                h("span", { className: "mneme-layercount" }, String(attrs.length))
              ),
              attrs.length === 0
                ? h("div", { className: "mneme-xempty" }, t("memory.settings.empty"))
                : h("div", { className: "mneme-attrgrid" },
                    attrs.map((a, i) => h("div", { key: i, className: "mneme-attrcard", title: a.value },
                      h("div", { className: "mneme-attrkey" }, a.key),
                      h("div", { className: "mneme-attrval" }, a.value)
                    ))
                  )
            ),
            // ② 关系 — both directions from the 1-hop ego walk
            h("div", { className: "mneme-layer" },
              h("div", { className: "mneme-layerhead" },
                t("memory.entities.relations"),
                h("span", { className: "mneme-layercount" }, String(rootEdges.length))
              ),
              rootEdges.length === 0
                ? h("div", { className: "mneme-xempty" }, t("memory.settings.empty"))
                : rootEdges.map((e) => {
                    const out = e.from === data.root.id;
                    const other = nodeById.get(out ? e.to : e.from);
                    const otherName = other?.name ?? (out ? e.to : e.from);
                    return h("button", {
                      key: e.id,
                      className: "mneme-relrow",
                      title: e.memory_id ? t("memory.graph.sourceMemory") : undefined,
                      onClick: () => { if (e.memory_id && onJumpMemory) onJumpMemory({ id: e.memory_id }); }
                    },
                      h("span", { className: "mneme-relname", style: { textAlign: "right", flex: 1 } }, entity.name),
                      h("span", { className: "mneme-reltype" }, e.relation_type),
                      h("span", { className: "mneme-relname", style: { flex: 1 } }, otherName)
                    );
                  })
            ),
            // ③ 关联记忆 — entity: prefix recall
            related.length > 0 && h("div", { className: "mneme-layer" },
              h("div", { className: "mneme-layerhead" },
                t("memory.graph.related"),
                h("span", { className: "mneme-layercount" }, String(related.length))
              ),
              related.map((m) => h("button", {
                key: m.id,
                type: "button",
                className: "mneme-gs-link",
                title: t("memory.card.open"),
                onClick: () => onJumpMemory && onJumpMemory(m)
              }, m.title || m.content?.slice(0, 60)))
            ),
            // ④ 关系图谱 — the ego graph
            h("div", { className: "mneme-layer" },
              h("div", { className: "mneme-layerhead" },
                t("memory.entities.graph"),
                h("span", { className: "mneme-layercount" },
                  h("button", {
                    className: depth === 2 ? "mneme-chip mneme-active" : "mneme-chip",
                    title: t("memory.graph.depth"),
                    onClick: () => setDepth(depth === 1 ? 2 : 1)
                  }, `${depth} ${t("memory.graph.depth")}`)),
                h("span", { className: "mneme-layercount" },
                  h("button", {
                    className: "mneme-chip",
                    title: t("memory.graph.resetView"),
                    onClick: resetView
                  }, t("memory.graph.resetView")))
              ),
              graphStatus === "empty"
                ? h("div", { className: "mneme-hint" }, t("memory.graph.empty"))
                : h(react.Fragment, null,
                    h("svg", {
                      ref: svgRef,
                      className: "mneme-graphsvg",
                      viewBox: `0 0 ${VIEW_W} ${VIEW_H}`,
                      style: { height: 320 },
                      onMouseDown: onSurfaceMouseDown
                    },
                      h("g", {
                        transform: `translate(${viewRef.current.x},${viewRef.current.y}) scale(${viewRef.current.k})`
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
                          h("circle", { r: nodeRadius(n), fill: typeColor(n.type), fillOpacity: nodeOpacity(n) }),
                          h("text", { className: "mneme-glabel", y: nodeRadius(n) + 13 }, n.name)
                        ))
                      )
                    ),
                    h("div", { className: "mneme-graphhint" }, t("memory.graph.hint"))
                  ),
              side
            )
          )
        )
      );

      return h("div", { className: "mneme-ent" }, rail, detail);
    }


    // --- 功能开关卡片（可插拔后端能力）---
    // GET /features 拿 overrides + effective，PUT 提交增量；启动时 index.js
    // 把持久化的 kv 合并进配置，因此每个开关都标注「重启 DSH 后生效」。
    // 分组排版：核心/增强/巩固常驻，注入策略等收进「高级」折叠，普通用户
    // 不被专业项淹没。429 调速器参数、distillMaxChars、codingBoostFactor
    // 属调优噪音，按对齐结论留在配置文件，不上 UI。
    const FEATURE_GROUPS = [
      { key: "group.core", items: ["autoInject", "autoSummarize", "hotMemoryEnabled", "memoryQualityFilter.enabled", "llmAudit.enabled"] },
      { key: "group.enhance", items: ["entityExtractionEnabled", "codingRetrospect", "rerankEnabled", "searchSemanticDedup", "bm25SearchEnabled"] },
      { key: "group.dream", items: ["autoDream", "sleepModeEnabled"] }
    ];
    const FEATURE_ADVANCED_BOOLS = ["hybridInject", "selectiveInjectEnabled", "adaptiveThresholdEnabled", "reflectionUpdateEnabled", "reflectionFailureTracking", "conflictFreezeEnabled", "trustEpistemicWeighting"];
    // 字符串键（blur/Enter 提交，空串合法 = 跟随默认）：巩固模型与语义
    // 检索路线。embedProvider 是枚举，用下拉单独渲染。
    const FEATURE_STRINGS = ["dreamProvider", "dreamModel", "sleepProvider", "sleepModel", "entityExtractionProvider", "entityExtractionModel", "localEmbedModel", "ollamaBaseUrl", "ollamaModel"];
    const EMBED_PROVIDERS = ["openai", "local", "ollama"];
    // 实体抽取思考强度（issue #109）：与后端 FEATURE_FLAG_ENUMS 枚举对齐。
    const ENTITY_REASONING = ["none", "low", "medium", "high"];

    function FeatureRow({ name, hint, on, disabled, onToggle }) {
      return h("div", { className: "mneme-featrow" },
        h("div", { className: "mneme-featmain" },
          h("div", { className: "mneme-featname" }, name),
          h("div", { className: "mneme-feathint" }, hint)
        ),
        h("button", {
          type: "button",
          className: on ? "mneme-switch mneme-on" : "mneme-switch",
          role: "switch",
          "aria-checked": String(on),
          "aria-label": name,
          disabled,
          onClick: onToggle
        })
      );
    }

    function FeaturesCard({ t }) {
      const [state, setState] = useState(null); // { overrides, effective }
      const [error, setError] = useState("");
      const [busy, setBusy] = useState(false);
      const [savedTick, setSavedTick] = useState(false);
      const [showAdv, setShowAdv] = useState(false);
      const [strs, setStrs] = useState({}); // 字符串输入的本地草稿：key -> string
      // 巩固/睡眠模型路由下拉的数据源：GET /llm-providers 探测（云端 v0.7.26+
      // 的插件侧端点）。null = 端点不可用（404/失败）→ 回退纯文本输入，不挡旧后端。
      const [routes, setRoutes] = useState(null);
      // 连通性测试结果（巩固/睡眠/实体抽取各一份，互不串扰）：{ running: true } | { ok, ms, detail }
      const [dreamTest, setDreamTest] = useState(null);
      const [sleepTest, setSleepTest] = useState(null);
      const [entityTest, setEntityTest] = useState(null);

      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/features")
          .then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
          .then((j) => {
            if (cancelled) return;
            setState(j);
            const e = (j && j.effective) || {};
            const draft = {};
            for (const key of FEATURE_STRINGS) draft[key] = String(e[key] ?? "");
            setStrs(draft);
          })
          .catch(() => { if (!cancelled) setError(t("memory.features.loadFailed")); });
        return () => { cancelled = true; };
      }, [t]);

      // 插件侧枚举端点探测：不可用时静默保持 routes=null（文本框回退）。
      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/llm-providers")
          .then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
          .then((j) => { if (!cancelled) setRoutes(Array.isArray(j && j.providers) ? j.providers : []); })
          .catch(() => {});
        return () => { cancelled = true; };
      }, [t]);

      const eff = (state && state.effective) || {};

      const put = async (patch) => {
        setBusy(true);
        try {
          const res = await apiFetch("/api/dsh-mneme/features", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch)
          });
          if (!res.ok) throw new Error("HTTP " + res.status);
          setState(await res.json());
          setSavedTick(true);
          setTimeout(() => setSavedTick(false), 1800);
        } catch {
          setError(t("memory.features.loadFailed"));
        } finally {
          setBusy(false);
        }
      };

      // 字符串项失焦/回车提交：trim 后与生效值相同则回填放弃，否则交给
      // 后端校验（ollamaBaseUrl 的协议、embedProvider 的枚举在后端把关）。
      const commitString = (key) => {
        const raw = (strs[key] ?? "").trim();
        if (raw === String(eff[key] ?? "")) {
          setStrs((c) => ({ ...c, [key]: String(eff[key] ?? "") }));
          return;
        }
        put({ [key]: raw });
      };

      const boolRow = (k) => h(FeatureRow, {
        key: k,
        name: t(`memory.features.${k}`),
        hint: t(`memory.features.${k}.hint`),
        on: !!eff[k],
        disabled: busy,
        onToggle: () => put({ [k]: !eff[k] })
      });

      // 模型枚举项的统一形状：string 或 {id, name?}（/llm-providers 契约）。
      const modelLabel = (m) => (typeof m === "string" ? m : String((m && (m.name || m.id)) ?? ""));
      const modelValue = (m) => (typeof m === "string" ? m : String((m && m.id) ?? ""));

      // 连通性测试：POST /test-model，空 provider/model = 按巩固路由解析
      // （agent 默认）。durationMs 优先后端值，缺失时客户端兜底计时；成功行
      // 附模型的实际回复（reply，后端截 100 字符）——「真的答了 ok」而非只报通。
      const runModelTest = async (provider, model, setTestState) => {
        setTestState({ running: true });
        const started = Date.now();
        try {
          const res = await apiFetch("/api/dsh-mneme/test-model", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider, model })
          });
          const j = await res.json().catch(() => ({}));
          const ms = typeof j.durationMs === "number" ? j.durationMs : Date.now() - started;
          if (!res.ok || j.ok === false) {
            setTestState({
              ok: false,
              ms,
              detail: [j.modelId, j.error || "HTTP " + res.status].filter(Boolean).join(" · ")
            });
            return;
          }
          setTestState({
            ok: true,
            ms,
            detail: [j.modelId, j.reply ? "「" + j.reply + "」" : ""].filter(Boolean).join(" · ")
          });
        } catch (err) {
          setTestState({ ok: false, ms: Date.now() - started, detail: String((err && err.message) ?? err) });
        }
      };

      // 巩固/睡眠路由行：provider/model 级联下拉（数据来自宿主侧已注册的
      // 适配器，用户不会选到不存在的模型）+ 连通性测试。空值 = 跟随默认
      // 路由；改动即提交（与 embedProvider 下拉一致）。当前值不在枚举里时
      // 保留为额外选项，避免静默改值。
      const routeSelects = (providerKey, modelKey, testState, setTestState) => {
        const curP = strs[providerKey] ?? "";
        const curM = strs[modelKey] ?? "";
        const entries = Array.isArray(routes) ? routes : [];
        const entry = entries.find((p) => p && p.provider === curP);
        const models = (entry && Array.isArray(entry.models)) ? entry.models : [];
        const mVals = models.map(modelValue);
        const pList = entries.map((p) => p.provider).concat(
          curP && !entries.some((p) => p.provider === curP) ? [curP] : []);
        const putKey = (key) => (e) => {
          const v = e.target.value;
          setStrs((c) => ({ ...c, [key]: v }));
          put({ [key]: v });
        };
        return h(react.Fragment, null,
          h("div", { className: "mneme-featnum" },
            h("span", { className: "mneme-featnumlabel" }, t(`memory.features.${providerKey}`)),
            h("select", {
              className: "mneme-select mneme-routeselect", value: curP, disabled: busy,
              "aria-label": t(`memory.features.${providerKey}`), onChange: putKey(providerKey)
            },
              h("option", { value: "" }, t("memory.features.routeFollowDefault")),
              pList.map((p) => h("option", { key: p, value: p }, p)))),
          h("div", { className: "mneme-featnum" },
            h("span", { className: "mneme-featnumlabel" }, t(`memory.features.${modelKey}`)),
            h("select", {
              className: "mneme-select mneme-routeselect", value: curM, disabled: busy,
              "aria-label": t(`memory.features.${modelKey}`), onChange: putKey(modelKey)
            },
              h("option", { value: "" }, t("memory.features.routeFollowDefault")),
              models.map((m, i) => h("option", { key: modelValue(m) + "|" + i, value: modelValue(m) }, modelLabel(m))),
              curM && !mVals.includes(curM) ? h("option", { key: "current", value: curM }, curM) : null)),
          h("div", { className: "mneme-featnum" },
            h("button", {
              type: "button", className: "mneme-btn",
              disabled: busy || (testState && testState.running),
              onClick: () => runModelTest(curP, curM, setTestState)
            }, t((testState && testState.running) ? "memory.features.modelTesting" : "memory.features.modelTest")),
            testState && !testState.running && h("div", { className: "mneme-featsubhint" },
              (testState.ok ? "✓ " + t("memory.features.modelTestOk") : "✗ " + t("memory.features.modelTestFail"))
              + (typeof testState.ms === "number" ? " · " + (testState.ms / 1000).toFixed(1) + "s" : "")
              + (testState.detail ? " · " + testState.detail : "")))
        );
      };

      const strRow = (key) => h("div", { className: "mneme-featnum", key },
        h("span", { className: "mneme-featnumlabel" }, t(`memory.features.${key}`)),
        h("input", {
          className: "mneme-strinput",
          value: strs[key] ?? "",
          onChange: (e) => setStrs((c) => ({ ...c, [key]: e.target.value })),
          onBlur: () => commitString(key),
          onKeyDown: (e) => { if (e.key === "Enter") e.target.blur(); }
        }));

      // 语义检索路线：provider 下拉即时提交；local/ollama 选中时展开各自
      // 的连接字段，openai 的连接信息由「向量搜索」卡片持有，只给指引。
      const embedSub = h("div", { className: "mneme-featsub" },
        h("div", { className: "mneme-featnum" },
          h("span", { className: "mneme-featnumlabel" }, t("memory.features.embedProvider")),
          h("select", {
            className: "mneme-select",
            value: eff.embedProvider || "openai",
            disabled: busy,
            onChange: (e) => put({ embedProvider: e.target.value })
          },
            EMBED_PROVIDERS.map((p) => h("option", { key: p, value: p }, t(`memory.features.embedProvider.${p}`))))
        ),
        h("div", { className: "mneme-featsubhint" },
          t(`memory.features.embedProvider.${eff.embedProvider || "openai"}.hint`)),
        eff.embedProvider === "local" && strRow("localEmbedModel"),
        eff.embedProvider === "ollama" && strRow("ollamaBaseUrl"),
        eff.embedProvider === "ollama" && strRow("ollamaModel")
      );

      // 巩固模型：autoDream 开着才展开，避免闲置配置占版面。/llm-providers
      // 可用时用级联下拉 + 连通性测试；旧后端（端点 404）回退纯文本输入。
      const dreamSub = eff.autoDream && h("div", { className: "mneme-featsub" },
        Array.isArray(routes)
          ? routeSelects("dreamProvider", "dreamModel", dreamTest, setDreamTest)
          : h(react.Fragment, null, strRow("dreamProvider"), strRow("dreamModel")),
        h("div", { className: "mneme-featsubhint" }, t("memory.features.dreamModelHint"))
      );

      // 睡眠模型：sleepModeEnabled 开着才展开（sleepProvider/sleepModel 随本版
      // 进白名单；下拉与测试复用同一 /llm-providers 数据源）。
      const sleepSub = eff.sleepModeEnabled && Array.isArray(routes) && h("div", { className: "mneme-featsub" },
        routeSelects("sleepProvider", "sleepModel", sleepTest, setSleepTest),
        h("div", { className: "mneme-featsubhint" }, t("memory.features.sleepModelHint"))
      );

      // 实体抽取路由与思考强度（issue #109）：entityExtractionEnabled 开着才
      // 展开。provider/model 级联下拉 + 连通性测试（同巩固/睡眠），reasoning
      // 枚举即时提交；旧后端（/llm-providers 404）回退纯文本输入。
      const entitySub = eff.entityExtractionEnabled && h("div", { className: "mneme-featsub" },
        Array.isArray(routes)
          ? routeSelects("entityExtractionProvider", "entityExtractionModel", entityTest, setEntityTest)
          : h(react.Fragment, null, strRow("entityExtractionProvider"), strRow("entityExtractionModel")),
        h("div", { className: "mneme-featnum" },
          h("span", { className: "mneme-featnumlabel" }, t("memory.features.entityExtractionReasoning")),
          h("select", {
            className: "mneme-select",
            value: eff.entityExtractionReasoning || "none",
            disabled: busy,
            onChange: (e) => put({ entityExtractionReasoning: e.target.value })
          },
            ENTITY_REASONING.map((r) => h("option", { key: r, value: r }, t(`memory.features.entityExtractionReasoning.${r}`))))
        ),
        h("div", { className: "mneme-featsubhint" }, t("memory.features.entityExtractionModelHint"))
      );

      if (error && !state) return h("section", { className: "mneme-set-card" },
        h("div", { className: "mneme-set-title" }, t("memory.features.title")),
        h("div", { className: "mneme-set-hint" }, error));

      return h("section", { className: "mneme-set-card" },
        h("div", { className: "mneme-set-title" },
          t("memory.features.title"),
          savedTick && h("span", { className: "mneme-saved", style: { marginLeft: 8, fontWeight: 400 } }, t("memory.features.restartHint"))
        ),
        h("div", { className: "mneme-set-desc" }, t("memory.features.desc")),
        state === null && !error
          ? h("div", { className: "mneme-set-hint" }, "…")
          : h(react.Fragment, null,
              FEATURE_GROUPS.map((g) => h(react.Fragment, { key: g.key },
                h("div", { className: "mneme-featgroup" }, t(`memory.features.${g.key}`)),
                g.items.map(boolRow),
                g.key === "group.enhance" && h(react.Fragment, null, embedSub, entitySub),
                g.key === "group.dream" && h(react.Fragment, null, dreamSub, sleepSub)
              )),
              h("div", { className: "mneme-featgroup" },
                h("button", {
                  type: "button",
                  className: "mneme-footbtn",
                  "aria-expanded": String(showAdv),
                  onClick: () => setShowAdv(!showAdv)
                },
                  h(Icon, { name: showAdv ? "chevronDown" : "chevronRight", size: 12 }),
                  t("memory.features.advancedToggle"))
              ),
              showAdv && FEATURE_ADVANCED_BOOLS.map(boolRow)
            )
      );
    }

    // 令牌遮蔽：保留首尾少量字符便于辨认，中间全部打点；完整值只经复制
    // 通道离开面板。
    function maskToken(value) {
      const s = String(value ?? "");
      if (s.length <= 8) return "•".repeat(Math.max(6, s.length));
      return `${s.slice(0, 5)}${"•".repeat(10)}${s.slice(-4)}`;
    }

    // 反馈预填用的平台标签：从 userAgent 提一个粗粒度 OS 名，够定位问题即可，
    // 不引第三方解析库。浏览器/Electron webview 里都能取到。
    const platformLabel = () => {
      const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
      if (/Windows NT/.test(ua)) return "Windows";
      if (/Mac OS X/.test(ua)) return "macOS";
      if (/Android/.test(ua)) return "Android";
      if (/iPhone|iPad/.test(ua)) return "iOS";
      if (/Linux/.test(ua)) return "Linux";
      return "Unknown";
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
      // 反馈入口的插件版本（GET /info）。失败保持 "unknown"，链接仍可用。
      const [pkgVersion, setPkgVersion] = react.useState("unknown");
      // 运行模式 — light vs standard; null = still loading. The card keeps
      // its own busy/saved/error state so it never blocks the others.
      const [mode, setMode] = react.useState(null);
      const [modeBusy, setModeBusy] = react.useState(false);
      const [modeSaved, setModeSaved] = react.useState(false);
      const [modeError, setModeError] = react.useState("");
      // 外部访问 API — config fetched from the backend (the token is generated
      // and kept server-side); host/port inputs are drafts, PUT only on save.
      const [extapi, setExtapi] = react.useState(null);
      const [extapiHost, setExtapiHost] = react.useState("127.0.0.1");
      const [extapiPort, setExtapiPort] = react.useState("");
      const [extapiBusy, setExtapiBusy] = react.useState(false);
      const [extapiSaved, setExtapiSaved] = react.useState(false);
      const [extapiCopied, setExtapiCopied] = react.useState(false);
      const [extapiError, setExtapiError] = react.useState("");
      // 令牌默认遮蔽显示：完整值只经「复制」离开面板，不直接铺在页面上。
      const [extapiTokenShown, setExtapiTokenShown] = react.useState(false);

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

      // 帮助与反馈卡片的版本号：独立小请求，失败不影响其它卡片。
      react.useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/info")
          .then((res) => (res.ok ? res.json() : null))
          .then((j) => { if (!cancelled && j && typeof j.version === "string") setPkgVersion(j.version); })
          .catch(() => {});
        return () => { cancelled = true; };
      }, []);

      // 反馈链接预填：环境信息（插件版本 + 平台）+ 问题描述骨架。邮件主题带
      // 版本/平台方便归档，正文同款模板；纯链接零后端成本。
      const feedbackEnv = `**插件版本**: ${pkgVersion}\n**平台**: ${platformLabel()}\n`;
      const feedbackBody = feedbackEnv + "**问题描述**:\n- 期望行为:\n- 实际行为:\n- 复现步骤:\n";
      const issueHref = "https://github.com/modusensus/dsh-mneme/issues/new?title="
        + encodeURIComponent("[dsh-mneme] 问题反馈")
        + "&body=" + encodeURIComponent(feedbackBody);
      const mailHref = "mailto:work@modusensus.space?subject="
        + encodeURIComponent(`[dsh-mneme 反馈] ${pkgVersion} / ${platformLabel()}`)
        + "&body=" + encodeURIComponent(feedbackBody);

      // Runtime mode + external API — two independent fetches: one failing
      // endpoint only errors its own card, never the other one.
      react.useEffect(() => {
        let cancelled = false;
        const toErr = (err) => (err && err.message) || "failed";
        apiFetch("/api/dsh-mneme/mode")
          .then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
          .then((j) => { if (!cancelled) setMode(j.mode === "light" ? "light" : "standard"); })
          .catch((err) => { if (!cancelled) setModeError(toErr(err)); });
        apiFetch("/api/dsh-mneme/external-api")
          .then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
          .then((j) => {
            if (cancelled) return;
            const cfg = (j && j.config) || {};
            const next = {
              enabled: !!cfg.enabled,
              host: cfg.host || "127.0.0.1",
              port: Number(cfg.port) || 0,
              token: cfg.token || ""
            };
            setExtapi(next);
            setExtapiHost(next.host);
            setExtapiPort(next.port ? String(next.port) : "");
          })
          .catch((err) => { if (!cancelled) setExtapiError(toErr(err)); });
        return () => { cancelled = true; };
      }, []);

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

      // Runtime mode: optimistic chip flip, rolled back on failure. Both
      // changes only take effect after a DSH restart — the saved hint says so.
      async function saveMode(next) {
        if (modeBusy) return;
        const prev = mode;
        setModeBusy(true);
        setModeError("");
        setMode(next);
        try {
          const res = await apiFetch("/api/dsh-mneme/mode", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: next })
          });
          if (!res.ok) throw new Error("HTTP " + res.status);
          setModeSaved(true);
          setTimeout(() => setModeSaved(false), 2500);
        } catch (err) {
          setMode(prev);
          setModeError((err && err.message) || "failed");
        }
        setModeBusy(false);
      }

      // External API: the backend owns the token and returns the full config,
      // so every PUT response refreshes host/port/token from the server.
      async function putExtapi(body) {
        setExtapiBusy(true);
        setExtapiError("");
        try {
          const res = await apiFetch("/api/dsh-mneme/external-api", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
          const cfg = data.config || {};
          const next = {
            enabled: !!cfg.enabled,
            host: cfg.host || "127.0.0.1",
            port: Number(cfg.port) || 0,
            token: cfg.token || ""
          };
          setExtapi(next);
          setExtapiHost(next.host);
          setExtapiPort(next.port ? String(next.port) : "");
          setExtapiSaved(true);
          setTimeout(() => setExtapiSaved(false), 2500);
        } catch (err) {
          setExtapiError((err && err.message) || "failed");
        }
        setExtapiBusy(false);
      }

      function saveExtapiEnabled(enabled) {
        if (extapiBusy) return;
        putExtapi({ enabled });
      }

      function saveExtapiAddress() {
        if (extapiBusy) return;
        const raw = String(extapiPort).trim();
        const port = Number(raw);
        if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
          setExtapiError(t("memory.settings.extapi.invalidPort"));
          return;
        }
        putExtapi({ port, host: extapiHost.trim() || "127.0.0.1" });
      }

      function copyExtapiToken() {
        const token = extapi ? extapi.token || "" : "";
        navigator.clipboard?.writeText(token).then(
          () => { setExtapiCopied(true); setTimeout(() => setExtapiCopied(false), 1500); },
          () => {}
        );
      }

      return h("div", null,
        // 用户画像 — who the agent is talking to
        h("section", { className: "mneme-set-sec" },
          h("div", { className: "mneme-set-title" }, t("memory.settings.profile")),
          h("div", { className: "mneme-set-desc" }, t("memory.settings.profileHint")),
          h("textarea", {
            className: "mneme-set-input mneme-set-input--area",
            value: profile,
            placeholder: t("memory.settings.profile"),
            onChange: (e) => setProfile(e.target.value)
          }),
          h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
            h("button", { className: "mneme-btn", onClick: saveProfile }, t("memory.settings.profileSave")),
            saved && h("span", { className: "mneme-saved" }, t("memory.settings.profileSaved"))
          )
        ),
        // 规则 — numbered rows, hover reveals the delete affordance
        h("section", { className: "mneme-set-sec" },
          h("div", { className: "mneme-set-title" }, t("memory.settings.rules")),
          h("div", { className: "mneme-set-desc" }, t("memory.settings.rulesHint")),
          rules.length === 0 && h("div", { className: "mneme-xempty" }, t("memory.settings.empty")),
          rules.map((rule, i) =>
            h("div", { key: i, className: "mneme-set-row" },
              h("span", { className: "mneme-set-idx" }, String(i + 1)),
              h("span", { className: "mneme-set-ruletext" }, rule),
              h("button", {
                className: "mneme-set-del",
                title: t("memory.settings.cmdDelete"),
                "aria-label": t("memory.settings.cmdDelete"),
                onClick: () => removeRule(i)
              }, "×")
            )
          ),
          h("div", { style: { display: "flex", gap: 8 } },
            h("input", {
              className: "mneme-set-input",
              style: { marginBottom: 0 },
              value: newRule,
              placeholder: t("memory.settings.rulePlaceholder"),
              onChange: (e) => setNewRule(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") addRule(); }
            }),
            h("button", { className: "mneme-btn", onClick: addRule }, t("memory.settings.ruleAdd"))
          )
        ),
        // 自定义指令 — slash commands as titled rows
        h("section", { className: "mneme-set-sec" },
          h("div", { className: "mneme-set-title" }, t("memory.settings.commands")),
          h("div", { className: "mneme-set-desc" }, t("memory.settings.commandsHint")),
          commands.length === 0 && h("div", { className: "mneme-xempty" }, t("memory.settings.empty")),
          commands.map((cmd) =>
            h("div", { key: cmd.id, className: "mneme-set-row" },
              h("div", { className: "mneme-set-cmd" },
                h("div", { className: "mneme-set-cmdname" }, `/${cmd.name}`),
                (cmd.description || cmd.instruction) && h("div", { className: "mneme-set-cmddesc" }, cmd.description || cmd.instruction)
              ),
              h("button", {
                className: "mneme-set-del",
                title: t("memory.settings.cmdDelete"),
                "aria-label": t("memory.settings.cmdDelete"),
                onClick: () => removeCommand(cmd.id)
              }, "×")
            )
          ),
          h("div", { style: { display: "grid", gap: 8, marginTop: 10 } },
            h("div", { style: { display: "flex", gap: 8 } },
              h("input", { className: "mneme-set-input", style: { marginBottom: 0 }, value: newCmd.name, placeholder: t("memory.settings.cmdName"), onChange: (e) => setNewCmd({ ...newCmd, name: e.target.value }) }),
              h("input", { className: "mneme-set-input", style: { marginBottom: 0 }, value: newCmd.description, placeholder: t("memory.settings.cmdDesc"), onChange: (e) => setNewCmd({ ...newCmd, description: e.target.value }) })
            ),
            h("textarea", { className: "mneme-set-input mneme-set-input--area", style: { minHeight: 56 }, value: newCmd.instruction, placeholder: t("memory.settings.cmdInstruction"), onChange: (e) => setNewCmd({ ...newCmd, instruction: e.target.value }) }),
            h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
              h("button", { className: "mneme-btn", onClick: addCommand }, t("memory.settings.cmdAdd")),
              cmdError && h("span", { style: { fontSize: 12, color: "var(--dsw-alias-state-error, #c33)" } }, cmdError)
            )
          )
        ),
        // 功能开关 — 0.7.13/0.7.14 后端能力的前端总闸（codingRetrospect、
        // 智能调速器参数、实体抽取、巩固等）；重启 DSH 后生效。
        h(FeaturesCard, { t }),
        // 运行模式 — light vs standard chip radios; each click PUTs and the
        // change only lands after a DSH restart (green saved hint says so).
        h("section", { className: "mneme-set-card" },
          h("div", { className: "mneme-set-title" }, t("memory.settings.mode.title")),
          h("div", { className: "mneme-set-desc" }, t("memory.settings.mode.desc")),
          modeError && h("div", { style: { fontSize: 12, color: "var(--dsw-alias-state-error,#c33)", marginBottom: 8 } }, modeError),
          mode === null && !modeError
            ? h("div", { className: "mneme-set-hint" }, "…")
            : h(react.Fragment, null,
                h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
                  h("button", {
                    className: mode === "light" ? "mneme-chip mneme-active" : "mneme-chip",
                    disabled: modeBusy,
                    onClick: () => saveMode("light")
                  }, t("memory.settings.mode.light")),
                  h("button", {
                    className: mode === "standard" ? "mneme-chip mneme-active" : "mneme-chip",
                    disabled: modeBusy,
                    onClick: () => saveMode("standard")
                  }, t("memory.settings.mode.standard")),
                  modeSaved && h("span", { className: "mneme-saved" }, t("memory.settings.mode.savedHint"))
                ),
                mode === "light" && h("div", { className: "mneme-set-hint", style: { marginTop: 8 } },
                  t("memory.settings.mode.offList"))
              )
        ),
        // 外部访问 API — standalone HTTP service for plugins/CLI/desktop tools;
        // the token is generated and kept by the backend, so it is read-only
        // here with a copy affordance. Changes need a DSH restart.
        h("section", { className: "mneme-set-card" },
          h("div", { className: "mneme-set-title" }, t("memory.settings.extapi.title")),
          h("div", { className: "mneme-set-desc" }, t("memory.settings.extapi.desc")),
          extapiError && h("div", { style: { fontSize: 12, color: "var(--dsw-alias-state-error,#c33)", marginBottom: 8 } }, extapiError),
          extapi === null && !extapiError
            ? h("div", { className: "mneme-set-hint" }, "…")
            : h(react.Fragment, null,
                h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
                  h("button", {
                    className: extapi && extapi.enabled ? "mneme-chip mneme-active" : "mneme-chip",
                    disabled: extapiBusy,
                    onClick: () => saveExtapiEnabled(true)
                  }, t("memory.settings.extapi.enabled")),
                  h("button", {
                    className: extapi && !extapi.enabled ? "mneme-chip mneme-active" : "mneme-chip",
                    disabled: extapiBusy,
                    onClick: () => saveExtapiEnabled(false)
                  }, t("memory.settings.extapi.disabled")),
                  extapiSaved && h("span", { className: "mneme-saved" }, t("memory.settings.extapi.savedHint"))
                ),
                extapi && extapi.enabled && h(react.Fragment, null,
                  h("div", { className: "mneme-set-hint", style: { marginTop: 10 } },
                    `${t("memory.settings.extapi.address")}: http://${extapi.host}:${extapi.port}`),
                  h("div", { style: { display: "flex", gap: 8, marginTop: 8 } },
                    h("input", {
                      className: "mneme-set-input",
                      style: { marginBottom: 0, flex: 2, minWidth: 0, width: "auto" },
                      value: extapiHost,
                      placeholder: "127.0.0.1",
                      onChange: (e) => setExtapiHost(e.target.value)
                    }),
                    h("input", {
                      className: "mneme-set-input",
                      style: { marginBottom: 0, flex: 1, minWidth: 0, width: "auto" },
                      value: extapiPort,
                      placeholder: t("memory.settings.extapi.port"),
                      inputMode: "numeric",
                      onChange: (e) => setExtapiPort(e.target.value)
                    }),
                    h("button", { className: "mneme-btn", disabled: extapiBusy, onClick: saveExtapiAddress },
                      t("memory.settings.vectorSave"))
                  ),
                  h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 10 } },
                    h("div", {
                      className: "mneme-set-token",
                      style: { flex: 1, minWidth: 0 },
                      title: extapi.token && !extapiTokenShown ? t("memory.settings.extapi.maskHint") : undefined
                    }, !extapi.token ? "—" : (extapiTokenShown ? extapi.token : maskToken(extapi.token))),
                    h("button", {
                      className: "mneme-footbtn",
                      onClick: () => setExtapiTokenShown(!extapiTokenShown),
                      "aria-label": extapiTokenShown ? t("memory.settings.extapi.hide") : t("memory.settings.extapi.reveal")
                    }, extapiTokenShown ? t("memory.settings.extapi.hide") : t("memory.settings.extapi.reveal")),
                    h("button", { className: "mneme-btn", onClick: copyExtapiToken },
                      t("memory.settings.extapi.copy")),
                    extapiCopied && h("span", { className: "mneme-saved" }, t("memory.settings.extapi.copied"))
                  )
                )
              )
        ),
        // 向量搜索 — semantic recall over an embeddings API
        h("section", { className: "mneme-set-sec" },
          h("div", { className: "mneme-set-title" }, t("memory.settings.vectorTitle")),
          h("div", { className: "mneme-set-desc" }, t("memory.settings.vectorHint")),
          h("label", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 13, color: "var(--dsw-alias-label-primary)" } },
            h("input", { type: "checkbox", checked: !!vector.enabled, onChange: (e) => setVector({ ...vector, enabled: e.target.checked }) }),
            h("span", null, t("memory.settings.vectorEnabled"))
          ),
          h("input", { className: "mneme-set-input", value: vector.baseUrl, placeholder: t("memory.settings.vectorBaseUrl"), onChange: (e) => setVector({ ...vector, baseUrl: e.target.value }) }),
          h("input", { className: "mneme-set-input", type: "password", value: vector.apiKey, placeholder: t("memory.settings.vectorApiKey"), onChange: (e) => setVector({ ...vector, apiKey: e.target.value }) }),
          h("input", { className: "mneme-set-input", value: vector.model, placeholder: t("memory.settings.vectorModel"), onChange: (e) => setVector({ ...vector, model: e.target.value }) }),
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
            h("button", { className: "mneme-btn", onClick: saveVector }, t("memory.settings.vectorSave")),
            vectorSaved && h("span", { className: "mneme-saved" }, t("memory.settings.vectorSaved")),
            h("button", { className: "mneme-btn", onClick: reindex, disabled: reindexing }, reindexing ? t("memory.settings.vectorReindexing") : t("memory.settings.vectorReindex")),
            reindexMsg && h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #666)" } }, reindexMsg)
          )
        ),
        // API Token — advanced, last
        h("section", { className: "mneme-set-sec" },
          h("div", { className: "mneme-set-title" }, t("memory.settings.apiTokenTitle")),
          h("div", { className: "mneme-set-desc" }, t("memory.settings.apiTokenHint")),
          h("div", { style: { display: "flex", gap: 8 } },
            h("input", {
              className: "mneme-set-input",
              style: { marginBottom: 0 },
              type: "password",
              value: apiToken,
              placeholder: t("memory.settings.apiTokenPlaceholder"),
              onChange: (e) => setApiToken(e.target.value)
            }),
            h("button", { className: "mneme-btn", onClick: saveToken }, t("memory.settings.apiTokenSave"))
          ),
          apiTokenSaved && h("div", { style: { marginTop: 8 } }, h("span", { className: "mneme-saved" }, t("memory.settings.apiTokenSaved")))
        ),
        // 帮助与反馈 — 反馈问题三入口（新建 issue 预填 / 邮件 / 浏览已知问题）。
        // 纯前端链接零后端成本；插件版本来自 /info，平台取 userAgent。GitHub
        // 仓库当前没有 issue 模板，故用 issues/new?title=&body= 直接预填。
        h("section", { className: "mneme-set-sec" },
          h("div", { className: "mneme-set-title" }, t("memory.settings.feedback.title")),
          h("div", { className: "mneme-set-desc" }, t("memory.settings.feedback.desc")),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 2 } },
            h("a", { className: "mneme-feed-link", href: issueHref, target: "_blank", rel: "noopener noreferrer" }, t("memory.settings.feedback.newIssue")),
            h("a", { className: "mneme-feed-link", href: mailHref }, t("memory.settings.feedback.email")),
            h("a", { className: "mneme-feed-link", href: "https://github.com/modusensus/dsh-mneme/issues", target: "_blank", rel: "noopener noreferrer" }, t("memory.settings.feedback.browse"))
          ),
          h("div", { className: "mneme-featsubhint", style: { marginTop: 8 } }, t("memory.settings.feedback.hint"))
        )
      );
    }

    // --- 打开记忆库 ---
    // v0.7.15 起记忆库不再注册 conversation.view tab：对话内嵌体验差
    // （面板被悬浮输入框遮挡、挤压会话布局）。唯一入口是侧边栏记忆按钮，
    // 直接打开居中 sheet——对话留在背板之后，不占全屏。保留这层间接函数
    // 是给图/实体视图的「查看来源记忆」跳转一个稳定语义：打开 sheet，
    // MemoryExplorer 内部状态（选中行、过滤）由各自的跳转回调处理。
    function openLibrary() {
      setOverlayOpen(true);
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

    // 居中 sheet 记忆库：任何状态下（含新会话 hero、无 tab 环）都能从侧边栏
    // 入口直接打开。背板点击 / Esc 关闭。portal 到 <body>，侧边栏的层叠
    // 上下文裁不住它；运行时拒绝 react-dom 时就地渲染（position:fixed 仍然成立）。
    function MemoryOverlay({ t }) {
      const [open, setOpen] = useOverlayOpen();
      useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [open]);
      if (!open) return null;
      // 背板与 sheet 是兄弟节点而不是嵌套：点击背板自身才关闭，sheet 内部
      // 的任何点击都不会冒泡到背板，不需要额外拦截。
      const tree = h(react.Fragment, null,
        h("div", {
          className: "mneme-backdrop",
          onClick: () => setOpen(false),
          "aria-hidden": "true"
        }),
        h("div", { className: "mneme-overlay", role: "region", "aria-label": t("memory.view.label") },
          h("div", { className: "mneme-overlaybar" },
            h("span", { className: "mneme-overlaytitle" },
              h(IconArchiveOutline20, { size: 15 }),
              t("memory.view.label")
            ),
            h("button", {
              type: "button",
              className: "mneme-footbtn",
              "aria-label": t("memory.overlay.close"),
              title: t("memory.overlay.close"),
              onClick: () => setOpen(false)
            }, "✕")
          ),
          h("div", { className: "mneme-overlaybody" }, h(MemoryExplorer, { t }))
        )
      );
      if (reactDom && typeof document !== "undefined") return reactDom.createPortal(tree, document.body);
      return tree;
    }

    const EXPLORER_TYPES = ["preference", "project", "decision", "summary", "history"];
    const PAGE_SIZE = 100; // browse page size — the tree grows by 100-row pages

    // --- Status sub-view: a responsive grid of stat cards. Every card owns
    // its fetch, loading ("…") and error state, so one failing endpoint
    // never blanks or blocks the others. ---
    function StatusCard({ t, title, loading, error, num, cap }) {
      return h("div", { className: "mneme-statuscard" },
        h("div", { className: "mneme-xcolhead" }, title),
        loading
          ? h("div", { className: "mneme-statusnum" }, "…")
          : error
            ? h("div", { className: "mneme-statuscap", style: { color: "var(--dsw-alias-state-error,#c33)" } }, t("memory.status.error"))
            : h(react.Fragment, null,
                h("div", { className: "mneme-statusnum" }, num),
                cap ? h("div", { className: "mneme-statuscap" }, cap) : null
              )
      );
    }

    // 记忆总数 — list total plus per-type subtotals; each subtotal request
    // may fail independently (rendered as "—") without sinking the card.
    function MemoriesStatusCard({ t }) {
      const [state, setState] = useState({ loading: true, error: false, total: 0, byType: [] });
      useEffect(() => {
        let cancelled = false;
        const one = (ty) =>
          apiFetch(`/api/dsh-mneme/list?limit=1&order=chrono${ty ? `&type=${encodeURIComponent(ty)}` : ""}`)
            .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); });
        one()
          .then((all) => {
            if (cancelled) return null;
            const total = all.total || 0;
            return Promise.all(EXPLORER_TYPES.map((ty) =>
              one(ty).then((j) => [ty, j.total || 0]).catch(() => [ty, null])
            )).then((byType) => {
              if (!cancelled) setState({ loading: false, error: false, total, byType });
            });
          })
          .catch(() => { if (!cancelled) setState({ loading: false, error: true, total: 0, byType: [] }); });
        return () => { cancelled = true; };
      }, []);
      const cap = state.byType
        .map(([ty, n]) => `${typeLabel(t, ty)} ${n === null ? "—" : n}`)
        .join(" · ");
      return h(StatusCard, {
        t,
        title: t("memory.status.memories"),
        loading: state.loading,
        error: state.error,
        num: state.total.toLocaleString(),
        cap
      });
    }

    // 实体 — directory snapshot grouped by entity type.
    function EntitiesStatusCard({ t }) {
      const [state, setState] = useState({ loading: true, error: false, total: 0, byType: [] });
      useEffect(() => {
        let cancelled = false;
        const order = ["organization", "person", "project", "technology", "concept"];
        apiFetch("/api/dsh-mneme/entities?limit=500")
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((j) => {
            if (cancelled) return;
            const list = Array.isArray(j.entities) ? j.entities : [];
            const counts = new Map();
            for (const e of list) {
              const key = order.includes(e.type) ? e.type : "other";
              counts.set(key, (counts.get(key) || 0) + 1);
            }
            const byType = order.concat("other")
              .filter((k) => counts.has(k))
              .map((k) => [k, counts.get(k)]);
            setState({ loading: false, error: false, total: list.length, byType });
          })
          .catch(() => { if (!cancelled) setState({ loading: false, error: true, total: 0, byType: [] }); });
        return () => { cancelled = true; };
      }, []);
      const cap = state.byType.map(([ty, n]) => `${entityTypeLabel(t, ty)} ${n}`).join(" · ");
      return h(StatusCard, {
        t,
        title: t("memory.status.entities"),
        loading: state.loading,
        error: state.error,
        num: state.total.toLocaleString(),
        cap
      });
    }

    // 向量索引 — whether semantic recall is switched on.
    function VectorStatusCard({ t }) {
      const [state, setState] = useState({ loading: true, error: false, provider: null, ready: null, configured: null, degraded: false, dimension: 0, embedded: 0, total: 0, localRuntime: null });
      // 收编是写操作、耗时数秒，所以要有忙碌态与就地结果；reload 只是用来让上面的
      // 加载 useEffect 重跑一次，从而把最新状态拉回来。
      const [reload, setReload] = useState(0);
      const [adopting, setAdopting] = useState(false);
      const [adoptMsg, setAdoptMsg] = useState("");
      useEffect(() => {
        let cancelled = false;
        // #118: /vector-config is secret-bearing (401 without a stored token →
        // "加载失败") and its `enabled` only reflects the OpenAI-compat external
        // service, so ollama/local mode always showed "未启用". /semantic is open
        // and covers every embedder provider + index stats.
        apiFetch("/api/dsh-mneme/semantic")
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((j) => {
            if (cancelled) return;
            setState({
              loading: false,
              error: false,
              provider: j?.embedProvider || null,
              ready: j?.ready ?? null,
              // issue #135: missing on older servers → null/false，卡片退化成
              // 旧行为（只按 ready 判断），不会误报「未配置」。
              configured: typeof j?.configured === "boolean" ? j.configured : null,
              degraded: j?.degraded === true,
              // Legacy OpenAI embedder exposes dimension only after its first
              // successful embed — fall back to the index stats' dimension.
              dimension: Number(j?.dimension ?? j?.index?.dimension ?? 0),
              embedded: Number(j?.index?.embeddedCount ?? 0),
              total: Number(j?.index?.totalCount ?? 0),
              // issue #131: 自管运行时状态。与 provider 无关地拿来，由下面决定是否要展示。
              localRuntime: j?.localRuntime ?? null
            });
          })
          .catch(() => { if (!cancelled) setState({ loading: false, error: true, provider: null, ready: null, dimension: 0, embedded: 0, localRuntime: null }); });
        return () => { cancelled = true; };
      }, [reload]);
      const off = !state.provider;
      // issue #135: 先把「没配」和「配了但在初始化」分开。此前两者都落到
      // ready !== true，于是未配置的 legacy embedder（ready 恒 true）反而
      // 一路显示成正常状态。
      const unconfigured = !off && state.configured === false;
      const pending = !off && !unconfigured && state.ready !== true;
      // 配好了、库里有东西、却一条都没嵌上 —— 这才是真正的降级。
      const degraded = !off && !unconfigured && !pending && state.degraded === true;
      // 本地 provider 缺运行时：绝不能显示「初始化中」——它永远不会初始化，只会一直重试，
      // 而那正是那份运行时（数百 MB）缺位的真实原因。这里必须说真话并给出下一步。
      const localBlocked = /^Local/.test(state.provider || "") && state.localRuntime?.status !== "available" && state.localRuntime != null;
      // 运行时已就绪但 embedder 还没起来 —— 这就是「刚取回运行时、但进程里的 embedder 早已失败」的过渡态。
      // 这时候继续说「embedder 不可达，正在重试」会让人以为永远好不了；要说的是可操作的那句：重启 DSH。
      const runtimeReadyPending = pending && state.localRuntime?.status === "available";
      const num = off
        ? t("memory.status.vectorOff")
        : localBlocked
          ? t("memory.status.vectorRuntimeMissing")
          : unconfigured
            ? t("memory.status.vectorUnconfigured")
            : runtimeReadyPending
              ? t("memory.status.vectorRuntimeReady")
              : pending
                ? t("memory.status.vectorInit")
                : `${state.provider.replace(/Embedder$/, "")} · ${state.dimension}D`;
      const cap = localBlocked
        ? t("memory.status.vectorRuntimeHint").replace("{status}", state.localRuntime.status)
        : unconfigured
          ? t("memory.status.vectorUnconfiguredHint")
          : runtimeReadyPending
            ? t("memory.status.vectorRuntimeReadyHint")
            : pending
              ? t("memory.status.vectorInitHint")
              : off ? ""
                : degraded
                  ? t("memory.status.vectorDegradedHint").replace("{m}", state.total)
                  : t("memory.status.vectorIndexed").replace("{n}", state.embedded).replace("{m}", state.total);

      // 一键取回自管运行时（issue #131 / PR-C）：服务侧依次尝试三档来源 —— 收编本机已有的、
      // 本地 .tgz 目录、registry 按固定清单下载。面板不需要用户输入任何路径。
      //
      // mneme 的取向是「本体保持完善但轻量；重的功能存在、默认不开、不被依赖，只留口子」。
      // 所以这里的代价必须写在按钮旁边（见下面的 vectorRuntimeCost）：本地向量化的代价就是
      // 这额外一份运行时 —— 瞒着用户，他会在「为什么装个插件这么慢」上再撞一次墙。
      //
      // 只有 payload 坏了才覆盖重建：只是缺就别覆盖，免得动到已经好用的文件。
      const fetchRuntime = async () => {
        setAdopting(true);
        setAdoptMsg("");
        try {
          const res = await apiFetch("/api/dsh-mneme/runtime/provision", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ overwrite: state.localRuntime?.status === "broken" })
          });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const j = await res.json();
          if (j?.ok) {
            // 按实际走的那一档给结果：收编（同盘硬链接、不占额外空间）与下载是两回事，
            // 报成同一句话会让用户不知道自己的磁盘发生了什么。
            const key = j.strategy === "download"
              ? "memory.status.vectorRuntimeFetchDownloaded"
              : "memory.status.vectorRuntimeFetchAdopted";
            setAdoptMsg(
              t(key)
                .replace("{n}", j.packages ?? 0)
                .replace("{m}", j.files ?? 0)
                .replace("{mode}", j.materialize ?? "?")
            );
          } else {
            setAdoptMsg(t("memory.status.vectorRuntimeFetchFailed").replace("{reason}", j?.reason ?? j?.status ?? "?"));
          }
          setReload((n) => n + 1);
        } catch (error) {
          setAdoptMsg(
            t("memory.status.vectorRuntimeFetchFailed").replace("{reason}", String((error && error.message) || error))
          );
        } finally {
          setAdopting(false);
        }
      };

      return h(react.Fragment, null,
        h(StatusCard, {
          t,
          title: t("memory.status.vector"),
          loading: state.loading,
          error: state.error,
          num,
          cap
        }),
        !state.loading && !state.error && localBlocked
          ? h("div", { className: "mneme-statuscap", style: { marginTop: "6px" } },
              // 代价与替代路径先于按钮出现：即便用户不点，也知道「本地向量化要额外一份运行时，
              // 也可以交给 agent 或自己在终端跑」。
              h("div", { style: { opacity: 0.85, marginBottom: "6px" } }, t("memory.status.vectorRuntimeCost")),
              h("button", {
                className: "mneme-chip",
                disabled: adopting,
                onClick: fetchRuntime
              }, adopting ? t("memory.status.vectorRuntimeFetchBusy") : t("memory.status.vectorRuntimeFetch")),
              adoptMsg ? h("div", { style: { marginTop: "4px" } }, adoptMsg) : null
            )
          : null
      );
    }

    // LLM 消耗 — calls + tokens over the trailing 7 days.
    function LlmStatusCard({ t }) {
      const [state, setState] = useState({ loading: true, error: false, calls: 0, tokens: 0 });
      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/semantic/llm-audit/stats?days=7")
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((j) => {
            if (cancelled) return;
            const s = j && typeof j === "object" ? (j.stats || j) : {};
            setState({ loading: false, error: false, calls: Number(s.total_calls ?? 0), tokens: Number(s.total_tokens ?? 0) });
          })
          .catch(() => { if (!cancelled) setState({ loading: false, error: true, calls: 0, tokens: 0 }); });
        return () => { cancelled = true; };
      }, []);
      return h(StatusCard, {
        t,
        title: t("memory.status.llm"),
        loading: state.loading,
        error: state.error,
        num: state.tokens.toLocaleString(),
        cap: t("memory.status.llmCalls").replace("{n}", state.calls.toLocaleString())
      });
    }

    // 巩固状态卡（×2）：最近一次 autoDream 运行 + 待确认冲突计数。数据来自
    // /dream-status，一次取回两张卡共用；失败只影响这两张卡自身。
    function DreamStatusCards({ t }) {
      const [state, setState] = useState({ loading: true, error: false, lastRun: null, pending: 0 });
      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/dream-status")
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((d) => {
            if (cancelled) return;
            setState({
              loading: false,
              error: false,
              lastRun: (d && d.lastRun) || null,
              pending: Number((d && d.pendingConflicts) ?? 0)
            });
          })
          .catch(() => { if (!cancelled) setState({ loading: false, error: true, lastRun: null, pending: 0 }); });
        return () => { cancelled = true; };
      }, []);
      const run = state.lastRun;
      const num = run ? formatRelativeTime(run.created_at, t) : t("memory.status.dreamNever");
      const cap = run
        ? `${run.status || "—"}${run.model ? ` · ${run.model}` : ""}`
        : t("memory.settings.mode.offList");
      return h(react.Fragment, null,
        h(StatusCard, { t, title: t("memory.status.dream"), loading: state.loading, error: state.error, num, cap }),
        h(StatusCard, {
          t,
          title: t("memory.status.conflicts"),
          loading: state.loading,
          error: state.error,
          num: state.pending.toLocaleString(),
          cap: t("memory.status.conflictsHint")
        })
      );
    }

    // --- 状态页工作台：让用户切实看见插件在干活 ---
    // 活动流合并 llm_audit 里 autoDream/autoSummarize 的后台调用（状态、
    // token、沉淀条数）；沉淀记忆列表用 audit 行携带的 related_memory_ids
    // 对照最近列表解析出标题；归档列表走 /list?archived=only，「恢复」经
    // POST /update {archived:false} 送回主列表。
    function parseRelatedIds(v) {
      if (Array.isArray(v)) return v;
      if (typeof v === "string") {
        try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
      }
      return [];
    }

    function WorkbenchSection({ t, onBrowse }) {
      const [feed, setFeed] = useState(null); // audit rows（已过滤巩固/总结）
      const [deposited, setDeposited] = useState(null); // 沉淀记忆首页（服务端 deposited 视图）
      const [depositedTotal, setDepositedTotal] = useState(0);
      const [archived, setArchived] = useState(null); // 归档记忆首页
      const [archivedTotal, setArchivedTotal] = useState(0);
      const [restoring, setRestoring] = useState("");
      const [wbReload, setWbReload] = useState(0);

      const load = useCallback(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/semantic/llm-audit?pageSize=12")
          .then((r) => (r.ok ? r.json() : { items: [] }))
          .then((d) => {
            if (cancelled) return;
            setFeed((d.items || []).filter((r) =>
              r.trigger_source === "autoDream" || r.trigger_source === "autoSummarize"));
          })
          .catch(() => { if (!cancelled) setFeed([]); });
        // 仪表盘数据源：沉淀/归档各取一小页 + 服务端 total（/list 的 total
        // 与行同过滤）。长列表不再进状态页——「查看全部」跳记忆库的筛选
        // 视图，查询收敛到有搜索/分页的地方。
        apiFetch("/api/dsh-mneme/list?deposited=only&limit=8&order=chrono")
          .then((r) => (r.ok ? r.json() : { items: [], total: 0 }))
          .then((d) => {
            if (cancelled) return;
            setDeposited(d.items || []);
            setDepositedTotal(d.total || 0);
          })
          .catch(() => { if (!cancelled) setDeposited([]); });
        apiFetch("/api/dsh-mneme/list?archived=only&limit=3&order=chrono")
          .then((r) => (r.ok ? r.json() : { items: [], total: 0 }))
          .then((d) => {
            if (cancelled) return;
            setArchived(d.items || []);
            setArchivedTotal(d.total || 0);
          })
          .catch(() => { if (!cancelled) setArchived([]); });
        return () => { cancelled = true; };
      }, [wbReload]);
      useEffect(() => { load(); }, [load]);

      const restore = (id) => {
        setRestoring(id);
        apiFetch("/api/dsh-mneme/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, archived: false })
        })
          .then((r) => { if (!r.ok) throw new Error("http"); })
          .then(() => {
            setArchived((cur) => (cur || []).filter((m) => m.id !== id));
            setArchivedTotal((n) => Math.max(0, n - 1));
          })
          .catch(() => {})
          .finally(() => setRestoring(""));
      };

      const statusLabel = (s) => s === "error"
        ? t("memory.status.failed")
        : s === "skipped" ? t("memory.status.skipped") : t("memory.status.success");
      const triggerLabel = (s) => s === "autoDream"
        ? t("memory.status.dreamConsolidate") : t("memory.status.summarize");

      return h(react.Fragment, null,
        h("div", { className: "mneme-wbhead" }, t("memory.status.workbench")),
        feed === null
          ? h("div", { className: "mneme-featsubhint" }, "…")
          : feed.length === 0
            ? h("div", { className: "mneme-featsubhint" }, t("memory.status.emptyFeed"))
            : h("div", { className: "mneme-wblist" },
                feed.map((row) => {
                  const n = parseRelatedIds(row.related_memory_ids).length;
                  return h("div", { className: "mneme-wbrow", key: row.id ?? row.timestamp },
                    h("span", { className: row.status === "error" ? "mneme-wbdot mneme-wbdot--err" : "mneme-wbdot", "aria-hidden": "true" }),
                    h("div", { className: "mneme-wbmain" },
                      h("div", { className: "mneme-wbtitle" },
                        `${triggerLabel(row.trigger_source)} · ${statusLabel(row.status)}`),
                      h("div", { className: "mneme-wbsub" },
                        formatRelativeTime(row.timestamp, t),
                        n > 0 && ` · ${t("memory.status.deposited").replace("{n}", String(n))}`,
                        row.total_tokens ? ` · ${t("memory.status.tokens").replace("{n}", Number(row.total_tokens).toLocaleString())}` : "",
                        row.error_message ? ` · ${row.error_message}` : "")
                    ));
                })),
        deposited !== null && depositedTotal > 0 && h(react.Fragment, null,
          h("div", { className: "mneme-wbhead" },
            h("span", null, t("memory.status.depositedCount").replace("{n}", String(depositedTotal))),
            onBrowse && depositedTotal > deposited.length && h("button", {
              type: "button",
              className: "mneme-footbtn",
              onClick: () => onBrowse({ deposited: true })
            }, t("memory.status.viewAll"))),
          h("div", { className: "mneme-wblist" },
            deposited.map((m) => h("div", { className: "mneme-wbmemo", key: m.id },
              h("span", { className: "mneme-xdot", style: { color: memoryTypeColor(m.type) }, "aria-hidden": "true" }),
              h("div", { className: "mneme-wbmemo-main" },
                h("div", { className: "mneme-wbtitle" }, m.title || (m.content || "").slice(0, 40)),
                h("div", { className: "mneme-wbsub" },
                  `${typeLabel(t, m.type)} · ${formatRelativeTime(m.updated_at || m.created_at, t)}`))
              )))),
        archived !== null && h(react.Fragment, null,
          h("div", { className: "mneme-wbhead" },
            h("span", null, t("memory.status.archivedCount").replace("{n}", String(archivedTotal))),
            onBrowse && archivedTotal > archived.length && h("button", {
              type: "button",
              className: "mneme-footbtn",
              onClick: () => onBrowse({ archived: true })
            }, t("memory.status.viewAll"))),
          archived.length === 0
            ? h("div", { className: "mneme-featsubhint" }, t("memory.status.archivedEmpty"))
            : h("div", { className: "mneme-wblist" },
                archived.map((m) => h("div", { className: "mneme-wbmemo", key: m.id },
                  h("span", { className: "mneme-xdot", style: { color: memoryTypeColor(m.type) }, "aria-hidden": "true" }),
                  h("div", { className: "mneme-wbmemo-main" },
                    h("div", { className: "mneme-wbtitle" }, m.title || (m.content || "").slice(0, 40)),
                    h("div", { className: "mneme-wbsub" },
                      `${typeLabel(t, m.type)} · ${formatRelativeTime(m.updated_at || m.created_at, t)}`)),
                  h("button", {
                    type: "button",
                    className: "mneme-btn",
                    disabled: restoring === m.id,
                    onClick: () => restore(m.id)
                  }, t("memory.status.restore"))
                ))))
      );
    }

    // 热度分布卡（阶段二）：采样最近 200 条的 heat 值做三档分布。自门控——
    // /list 不下发 heat（heatEnabled=false）时整卡不渲染，前端不感知开关。
    function HeatStatusCard({ t }) {
      const [state, setState] = useState({ loading: true, off: false, hot: 0, warm: 0, cold: 0, sample: 0 });
      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/list?limit=200&order=chrono")
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((d) => {
            if (cancelled) return;
            const items = d.items || [];
            if (!items.length || typeof items[0].heat !== "number") {
              setState({ loading: false, off: true, hot: 0, warm: 0, cold: 0, sample: 0 });
              return;
            }
            let hot = 0, warm = 0, cold = 0;
            for (const m of items) {
              if (m.heat >= 0.66) hot++; else if (m.heat >= 0.33) warm++; else cold++;
            }
            setState({ loading: false, off: false, hot, warm, cold, sample: items.length });
          })
          .catch(() => { if (!cancelled) setState({ loading: false, off: true, hot: 0, warm: 0, cold: 0, sample: 0 }); });
        return () => { cancelled = true; };
      }, []);
      if (state.off) return null;
      return h(StatusCard, {
        t,
        title: t("memory.status.heatDistribution"),
        loading: state.loading,
        error: false,
        num: `${state.hot}`,
        cap: t("memory.status.heatHint")
          .replace("{hot}", String(state.hot))
          .replace("{warm}", String(state.warm))
          .replace("{cold}", String(state.cold))
          .replace("{sample}", String(state.sample))
      });
    }

    function StatusPanel({ t, onBrowse }) {
      return h("div", { className: "mneme-status" },
        h("div", { className: "mneme-statusgrid" },
          h(MemoriesStatusCard, { t }),
          h(EntitiesStatusCard, { t }),
          h(VectorStatusCard, { t }),
          h(LlmStatusCard, { t }),
          h(DreamStatusCards, { t }),
          h(HeatStatusCard, { t })
        ),
        h(WorkbenchSection, { t, onBrowse })
      );
    }


    // --- 详情抽屉 ---
    // 右侧滑出：全文、来源、质量分、关联实体与手动操作（编辑/归档/删除）。
    // 编辑态本地暂存草稿，保存经 POST /update 落库；后端成功后重渲染镜像，
    // 前端只做本地视图同步。两步删除确认在此完成（红钮武装 → 实心红提交）。
    function MemoryDrawer({ t, memory, conflict, deleting, deleteError, onClose, onDelete, onSaved }) {
      const [editing, setEditing] = useState(false);
      const [title, setTitle] = useState(memory.title || "");
      const [content, setContent] = useState(memory.content || "");
      const [importance, setImportance] = useState(memory.importance || 3);
      const [confirmDelete, setConfirmDelete] = useState(false);
      const [busy, setBusy] = useState(false);
      const [savedTick, setSavedTick] = useState(false);
      const [saveError, setSaveError] = useState(false);
      const [copied, setCopied] = useState(false);
      const [entities, setEntities] = useState(null);

      useEffect(() => {
        let cancelled = false;
        apiFetch(`/api/dsh-mneme/memories/entities?memoryId=${encodeURIComponent(memory.id)}`)
          .then((res) => (res.ok ? res.json() : { entities: [] }))
          .then((d) => { if (!cancelled) setEntities(d.entities || []); })
          .catch(() => { if (!cancelled) setEntities([]); });
        return () => { cancelled = true; };
      }, [memory.id]);

      const postUpdate = (patch, opts) => {
        setBusy(true);
        setSaveError(false);
        apiFetch("/api/dsh-mneme/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: memory.id, ...patch })
        })
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((d) => {
            onSaved(d.memory, opts);
            setEditing(false);
            setSavedTick(true);
            setTimeout(() => setSavedTick(false), 2000);
          })
          .catch(() => setSaveError(true))
          .finally(() => setBusy(false));
      };

      const save = () => {
        const t2 = title.trim();
        if (!t2) return;
        postUpdate({ title: t2, content, importance }, {});
      };

      return h("aside", { className: "mneme-drawer", "aria-label": t("memory.explorer.detail") },
        h("div", { className: "mneme-drawerbar" },
          h("span", { className: "mneme-drawertype" },
            h("span", { className: "mneme-xdot", style: { color: memoryTypeColor(memory.type) }, "aria-hidden": "true" }),
            typeLabel(t, memory.type)
          ),
          conflict && h("span", { className: "mneme-badge mneme-badge--conflict" }, "⚠ ", t("memory.explorer.conflictBadge")),
          h("button", {
            type: "button",
            className: "mneme-footbtn",
            style: { marginLeft: "auto" },
            "aria-label": t("memory.explorer.detail.closeAria"),
            title: t("memory.explorer.detail.closeAria"),
            onClick: onClose
          }, "✕")
        ),
        h("div", { className: "mneme-drawerbody" },
          editing
            ? h(react.Fragment, null,
                h("div", { className: "mneme-xcolhead", style: { padding: "0 0 4px" } }, t("memory.explorer.detail.editTitle")),
                h("input", { className: "mneme-drawertitle-input", value: title, onChange: (e) => setTitle(e.target.value) }))
            : h("div", { className: "mneme-drawertitle" }, memory.title || t("memory.panel.empty")),
          h("div", { className: "mneme-dmeta" },
            h("span", { className: "mneme-dmetakey" }, t("memory.explorer.importance")),
            editing
              ? h("select", {
                  className: "mneme-select",
                  style: { height: 26, fontSize: 12, justifySelf: "start" },
                  value: importance,
                  onChange: (e) => setImportance(Number(e.target.value))
                }, [1, 2, 3, 4, 5].map((n) => h("option", { key: n, value: n }, "★".repeat(n))))
              : h(ImportanceStars, { className: "mneme-dmetaval", value: memory.importance || 0 }),
            memory.heat != null && h(react.Fragment, null,
              h("span", { className: "mneme-dmetakey" }, t("memory.explorer.heat")),
              h("span", { className: "mneme-dmetaval" }, h(HeatBadge, { value: memory.heat, size: 13 }))),
            memory.source && h(react.Fragment, null,
              h("span", { className: "mneme-dmetakey" }, t("memory.explorer.source")),
              h("span", { className: "mneme-dmetaval", title: memory.source }, memory.source)),
            memory.quality_score != null && h(react.Fragment, null,
              h("span", { className: "mneme-dmetakey" }, t("memory.explorer.detail.quality")),
              h("span", { className: "mneme-dmetaval" }, String(memory.quality_score))),
            h("span", { className: "mneme-dmetakey" }, t("memory.explorer.created")),
            h("span", { className: "mneme-dmetaval", title: formatDate(memory.created_at) }, formatDateShort(memory.created_at)),
            h("span", { className: "mneme-dmetakey" }, t("memory.explorer.updated")),
            h("span", { className: "mneme-dmetaval", title: formatDate(memory.updated_at) },
              `${formatRelativeTime(memory.updated_at, t)}（${formatDateShort(memory.updated_at)}）`),
            Array.isArray(memory.tags) && memory.tags.length > 0 && h(react.Fragment, null,
              h("span", { className: "mneme-dmetakey" }, t("memory.explorer.tags")),
              h("span", { className: "mneme-dmetaval" }, memory.tags.join(" · ")))
          ),
          entities !== null && h(react.Fragment, null,
            h("div", { className: "mneme-xcolhead", style: { padding: "16px 0 0" } }, t("memory.explorer.detail.entities")),
            entities.length === 0
              ? h("div", { className: "mneme-featsubhint", style: { marginTop: 4 } }, t("memory.explorer.detail.entitiesEmpty"))
              : h("div", { className: "mneme-dentities" },
                  entities.map((e, i) => h("span", { key: `${e.name}-${i}`, className: "mnementity-chip" },
                    h("span", { className: "mneme-xdot", style: { color: typeColor(e.type) }, "aria-hidden": "true" }),
                    e.name
                  )))),
          editing && h("div", { className: "mneme-xcolhead", style: { padding: "16px 0 4px" } }, t("memory.explorer.detail.editContent")),
          editing
            ? h("textarea", { className: "mneme-dcontent-input", value: content, onChange: (e) => setContent(e.target.value) })
            : h("div", { className: "mneme-dcontent" }, memory.content)
        ),
        h("div", { className: "mneme-dactions" },
          editing
            ? h(react.Fragment, null,
                h("button", { type: "button", className: "mneme-btn", disabled: busy, onClick: save }, t("memory.explorer.detail.save")),
                h("button", {
                  type: "button",
                  className: "mneme-btn",
                  disabled: busy,
                  onClick: () => {
                    setEditing(false);
                    setTitle(memory.title || "");
                    setContent(memory.content || "");
                    setImportance(memory.importance || 3);
                  }
                }, t("memory.explorer.detail.cancel")),
                savedTick && h("span", { className: "mneme-saved" }, t("memory.explorer.detail.saved")),
                saveError && h("span", { style: { fontSize: 12, color: "var(--dsw-alias-state-error,#c33)" } }, t("memory.explorer.detail.archiveFailed"))
              )
            : h(react.Fragment, null,
                h("button", { type: "button", className: "mneme-btn", onClick: () => setEditing(true) }, t("memory.explorer.detail.edit")),
                memory.archived
                  ? h("button", { type: "button", className: "mneme-btn", disabled: busy, onClick: () => postUpdate({ archived: false }, { restored: true }) },
                      t("memory.explorer.detail.restore"))
                  : h("button", { type: "button", className: "mneme-btn", disabled: busy, onClick: () => postUpdate({ archived: true }, { archived: true }) },
                      t("memory.explorer.detail.archive")),
                h("button", {
                  type: "button",
                  className: "mneme-btn",
                  onClick: () => {
                    navigator.clipboard?.writeText(memory.content || "").then(
                      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
                      () => {}
                    );
                  }
                }, copied ? t("memory.explorer.copied") : t("memory.explorer.copy")),
                confirmDelete
                  ? h(react.Fragment, null,
                      h("button", { type: "button", className: "mneme-btn mneme-btndangerconfirm", disabled: deleting, onClick: () => onDelete(memory.id) },
                        t("memory.explorer.confirmDelete")),
                      h("button", { type: "button", className: "mneme-btn", onClick: () => setConfirmDelete(false) },
                        t("memory.explorer.cancel"))
                    )
                  : h("button", { type: "button", className: "mneme-btn mneme-btndanger", onClick: () => setConfirmDelete(true) },
                      t("memory.explorer.delete")),
                deleteError && h("span", { style: { fontSize: 12, color: "var(--dsw-alias-state-error,#c33)" } },
                  t("memory.explorer.deleteFailed"))
              )
        )
      );
    }

    // --- 导入弹层 ---
    // 选类型 → 选文件 → 解析合并。文件在本地读成文本，POST /import 只传
    // 文本与类型；成功后提示合并条数，并由父级刷新列表。
    function ImportDialog({ t, onClose, onImported }) {
      const [type, setType] = useState("preference");
      const [file, setFile] = useState(null);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState("");
      const [err, setErr] = useState("");
      const fileRef = useRef(null);
      const submit = () => {
        if (!file) { setErr(t("memory.explorer.importNoFile")); return; }
        setBusy(true);
        setErr("");
        file.text()
          .then((text) => apiFetch("/api/dsh-mneme/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type, markdown: text })
          }))
          .then((res) => { if (!res.ok) throw new Error("http"); return res.json(); })
          .then((d) => {
            setMsg(t("memory.explorer.imported").replace("{n}", String((d && d.merged) ?? 0)));
            setBusy(false);
            setTimeout(() => { onImported(); onClose(); }, 900);
          })
          .catch(() => { setBusy(false); setErr(t("memory.explorer.importFailed")); });
      };
      return h("div", { className: "mneme-impdialog", role: "region", "aria-label": t("memory.explorer.importTitle") },
        h("div", { className: "mneme-set-title" }, t("memory.explorer.importTitle")),
        h("div", { className: "mneme-featsubhint", style: { marginTop: 4 } }, t("memory.explorer.importHint")),
        h("div", { className: "mneme-improw" },
          h("span", { className: "mneme-featnumlabel" }, t("memory.explorer.importType")),
          h("select", { className: "mneme-select", value: type, onChange: (e) => setType(e.target.value) },
            ["preference", "project", "decision", "summary", "history"].map((k) =>
              h("option", { key: k, value: k }, typeLabel(t, k))))
        ),
        h("div", { className: "mneme-improw" },
          h("button", { type: "button", className: "mneme-btn", onClick: () => fileRef.current?.click() },
            file ? file.name : t("memory.explorer.importPick")),
          h("input", {
            ref: fileRef,
            type: "file",
            accept: ".md,.markdown,text/markdown",
            style: { display: "none" },
            onChange: (e) => { setFile((e.target.files && e.target.files[0]) || null); setErr(""); }
          })
        ),
        err && h("div", { className: "mneme-featsubhint", style: { color: "var(--dsw-alias-state-error,#c33)", marginTop: 8 } }, err),
        msg && h("div", { className: "mneme-saved", style: { marginTop: 8 } }, msg),
        h("div", { className: "mneme-improw", style: { justifyContent: "flex-end" } },
          h("button", { type: "button", className: "mneme-btn", disabled: busy, onClick: onClose }, t("memory.explorer.importCancel")),
          h("button", { type: "button", className: "mneme-btn", disabled: busy, onClick: submit },
            busy ? t("memory.explorer.importing") : t("memory.explorer.importConfirm"))
        )
      );
    }

    function MemoryExplorer({ t }) {
      const [view, setView] = useState("memory"); // memory | entity | status | settings
      const [items, setItems] = useState([]); // loaded browse pages, chrono desc
      const [total, setTotal] = useState(0); // server count for the current type filter
      const [loading, setLoading] = useState(true);
      const [loadingMore, setLoadingMore] = useState(false);
      const [type, setType] = useState("all");
      const [minImp, setMinImp] = useState(0); // importance floor: 0 = all, else 3/4/5
      const [query, setQuery] = useState("");
      const [semantic, setSemantic] = useState(false);
      const [vecEnabled, setVecEnabled] = useState(false);
      const [searchTopK, setSearchTopK] = useState(20);
      const [remoteItems, setRemoteItems] = useState(null);
      const [selectedId, setSelectedId] = useState(null);
      const [expandedMonths, setExpandedMonths] = useState(null); // null = 仅最新一个月展开
      const [collapsed, setCollapsed] = useState({});
      const [reloadKey, setReloadKey] = useState(0);
      const [deleting, setDeleting] = useState(false);
      const [deleteError, setDeleteError] = useState(false);
      const [toastMsg, setToastMsg] = useState(""); // 瞬时操作提示（删除/归档），挂在外层不被抽屉卸载吞掉
      const [graphFocus, setGraphFocus] = useState("");
      // 交互式面板新增：浏览模式（卡片/时间线，本地记住）、时间筛选、
      // 冲突冻结指示、更多操作菜单与导入弹层。
      const [viewMode, setViewMode] = useState(() => {
        try { return window.localStorage.getItem("dsh-mneme-view") === "cards" ? "cards" : "timeline"; }
        catch { return "timeline"; }
      });
      const [dateRange, setDateRange] = useState("all"); // all | 7d | 30d | 90d
      // 方案 A：沉淀/归档筛选 chip——状态页「查看全部」也会带着它们跳转过来。
      const [depositedOnly, setDepositedOnly] = useState(false); // 只看 autoDream 巩固
      const [archivedOnly, setArchivedOnly] = useState(false); // 只看已归档
      const [heatSort, setHeatSort] = useState(false); // 卡片页内热度降序（阶段二补口）
      const [pendingIds, setPendingIds] = useState(() => new Set());
      const [menuOpen, setMenuOpen] = useState(false);
      const [importOpen, setImportOpen] = useState(false);
      const itemRefs = useRef(new Map());
      const moreRef = useRef(null);

      const switchViewMode = (mode) => {
        setViewMode(mode);
        try { window.localStorage.setItem("dsh-mneme-view", mode); } catch { /* 隐私模式等 */ }
      };

      useEffect(() => {
        apiFetch("/api/dsh-mneme/vector-config")
          .then((res) => res.json())
          .then((d) => setVecEnabled(!!d.config?.enabled))
          .catch(() => {});
      }, []);

      // 冲突冻结指示：dream-status 一次带出待确认冲突涉及的记忆 id，
      // 卡片与详情抽屉据此画「冲突」徽章。
      useEffect(() => {
        let cancelled = false;
        apiFetch("/api/dsh-mneme/dream-status")
          .then((res) => (res.ok ? res.json() : { pendingMemoryIds: [] }))
          .then((d) => { if (!cancelled) setPendingIds(new Set(d.pendingMemoryIds || [])); })
          .catch(() => {});
        return () => { cancelled = true; };
      }, [reloadKey]);

      // One query string behind every browse-list fetch (initial page,
      // loadMore, auto-refresh): the type filter, importance floor and time
      // window always travel together, so counts and pagination stay
      // consistent.
      const dateFromIso = dateRange === "all" ? "" : new Date(
        Date.now() - (dateRange === "7d" ? 7 : dateRange === "30d" ? 30 : 90) * 86400000
      ).toISOString();
      const filterQS = (type === "all" ? "" : `&type=${encodeURIComponent(type)}`)
        + (minImp ? `&minImportance=${minImp}` : "")
        + (dateFromIso ? `&updatedFrom=${encodeURIComponent(dateFromIso)}` : "")
        + (depositedOnly ? "&deposited=only" : "")
        + (archivedOnly ? "&archived=only" : "");
      const listUrl = (offset) => `/api/dsh-mneme/list?limit=${PAGE_SIZE}&offset=${offset}${filterQS}&order=chrono`;

      // Browse = paged, pure-chronological pages (order=chrono). The default
      // importance ordering would interleave months across pages and break
      // the month tree; type filters server-side so pages stay consistent
      // however large the store grows.
      useEffect(() => {
        let cancelled = false;
        setLoading(true);
        apiFetch(listUrl(0))
          .then((res) => (res.ok ? res.json() : { items: [], total: 0 }))
          .then((d) => {
            if (cancelled) return;
            setItems(d.items || []);
            setTotal(d.total || 0);
            setExpandedMonths(null); // 新数据回到「仅最新月展开」
            setLoading(false);
          })
          .catch(() => { if (!cancelled) { setItems([]); setTotal(0); setLoading(false); } });
        return () => { cancelled = true; };
      }, [reloadKey, filterQS]);

      const canLoadMore = !query.trim() && !remoteItems && items.length < total;
      const loadMore = useCallback(() => {
        if (loadingMore || query.trim() || remoteItems) return;
        if (items.length >= total) return;
        setLoadingMore(true);
        apiFetch(listUrl(items.length))
          .then((res) => (res.ok ? res.json() : { items: [] }))
          .then((d) => setItems((cur) => cur.concat(d.items || [])))
          .catch(() => {})
          .finally(() => setLoadingMore(false));
      }, [items.length, total, loadingMore, query, remoteItems, filterQS]);

      // Infinite scroll: a sentinel just past the loaded rows pulls the next
      // page while browsing (search results arrive complete already).
      useEffect(() => {
        const el = moreRef.current;
        if (!el || !canLoadMore) return undefined;
        const io = new IntersectionObserver((entries) => {
          if (entries.some((e) => e.isIntersecting)) loadMore();
        }, { root: el.closest(".mneme-xtree"), rootMargin: "240px" });
        io.observe(el);
        return () => io.disconnect();
      }, [canLoadMore, loadMore]);

      // Search hits the server so matches are global — not limited to the
      // loaded pages: keyword = literal text; vector = semantic ranking
      // (the pipeline falls back to keyword when no embedder is available).
      useEffect(() => {
        const query0 = query.trim();
        if (!query0 || query0.startsWith("entity:")) { setRemoteItems(null); return; }
        let cancelled = false;
        const timer = setTimeout(() => {
          const mode = semantic ? "vector" : "keyword";
          apiFetch(`/api/dsh-mneme/search?q=${encodeURIComponent(query0)}&mode=${mode}&topK=${searchTopK}`)
            .then((res) => (res.ok ? res.json() : { items: [] }))
            .then((d) => { if (!cancelled) setRemoteItems(d.items || []); })
            .catch(() => { if (!cancelled) setRemoteItems([]); });
        }, 250);
        return () => { cancelled = true; clearTimeout(timer); };
      }, [query, semantic, searchTopK]);

      // Live view: while the memory tab is open, quietly re-fetch page 1
      // every 30s (and on every activation) so fresh memories surface
      // without a manual refresh. Later pages stay as loaded.
      const refreshFirstPage = useCallback(() => {
        if (query.trim() || remoteItems) return;
        apiFetch(listUrl(0))
          .then((res) => (res.ok ? res.json() : null))
          .then((d) => {
            if (!d) return;
            setTotal(d.total || 0);
            setItems((cur) => {
              const fresh = d.items || [];
              const seen = new Set(fresh.map((m) => m.id));
              return fresh.concat(cur.filter((m) => !seen.has(m.id)));
            });
          })
          .catch(() => {});
      }, [query, remoteItems, filterQS]);

      useEffect(() => {
        if (view !== "memory") return undefined;
        refreshFirstPage();
        const iv = setInterval(() => {
          if (document.visibilityState === "visible") refreshFirstPage();
        }, 30000);
        return () => clearInterval(iv);
      }, [view, refreshFirstPage]);

      useEffect(() => {
        if (!selectedId) return;
        itemRefs.current.get(selectedId)?.scrollIntoView({ block: "nearest" });
      }, [selectedId]);

      // The two-step delete arms inside the drawer per selection: switching
      // or clearing the target disarms it, so a stale confirm can never
      // delete a new pick.
      useEffect(() => {
        setDeleteError(false);
      }, [selectedId]);

      const q = query.trim().toLowerCase();
      // "entity:" is the graph entry grammar: typing it means the user wants
      // the entity's neighborhood, not a memory list. Offer the jump instead
      // of auto-switching so the list stays predictable.
      const entityQuery = query.trim().startsWith("entity:")
        ? query.trim().slice(7).trim()
        : "";
      // Search results were filtered server-side (global); the type rail
      // still narrows them. Browse mode serves the loaded pages as-is —
      // type filtering happened in the query.
      const visible = remoteItems
        ? remoteItems.filter((m) => type === "all" || m.type === type)
        : items;

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
      // heatSort（阶段二补口，order=heat 的前端实现）：热度是运行时投影、
      // 无存储序，SQL 排不了；页内对已加载条目降序（非全局序），时间树
      // 仍走 chrono 不受影响。开关仅在 heat 字段在场上时出现（自门控）。
      const heatAvailable = visible.some((m) => typeof m.heat === "number");
      const gridItems = heatSort
        ? [...sorted].sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0))
        : sorted;
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
      for (const mo of months) mo.count = mo.days.reduce((s, d) => s + d.items.length, 0);

      const selected = visible.find((m) => m.id === selectedId) || null;

      // Delete / archive / edit commit through POST endpoints; on success the
      // row leaves or updates in every local view (browse pages + search
      // results). Failures — 404 included — surface as a transient red note
      // in the drawer's action bar.
      const deleteById = (id) => {
        if (!id || deleting) return;
        setDeleting(true);
        setDeleteError(false);
        apiFetch("/api/dsh-mneme/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id })
        })
          .then((res) => { if (!res.ok) throw new Error("http"); })
          .then(() => {
            setItems((cur) => cur.filter((m) => m.id !== id));
            setRemoteItems((cur) => (cur ? cur.filter((m) => m.id !== id) : cur));
            setTotal((n) => Math.max(0, n - 1));
            setSelectedId(null);
            setToastMsg(t("memory.explorer.deleted"));
            setTimeout(() => setToastMsg(""), 2500);
          })
          .catch(() => {
            setDeleteError(true);
            setTimeout(() => setDeleteError(false), 4000);
          })
          .finally(() => setDeleting(false));
      };

      // 编辑保存 / 归档的本地落账：替换或移除对应行；镜像由后端重渲染。
      // 归档从所有视图移除（列表默认只看未归档），并清空选中。
      const applyMemoryUpdate = (updated, { archived = false, restored = false } = {}) => {
        if (archived) {
          setItems((cur) => cur.filter((m) => m.id !== updated.id));
          setRemoteItems((cur) => (cur ? cur.filter((m) => m.id !== updated.id) : cur));
          setTotal((n) => Math.max(0, n - 1));
          setSelectedId(null);
          setToastMsg(t("memory.explorer.detail.archived"));
          setTimeout(() => setToastMsg(""), 2500);
          return;
        }
        if (restored) {
          // 恢复：行离开当前视图（抽屉只能从归档浏览列表打开它），回主列表
          // 由下一次筛选切换/刷新自然带出。
          setItems((cur) => cur.filter((m) => m.id !== updated.id));
          setRemoteItems((cur) => (cur ? cur.filter((m) => m.id !== updated.id) : cur));
          setTotal((n) => Math.max(0, n - 1));
          setSelectedId(null);
          setToastMsg(t("memory.explorer.detail.restored"));
          setTimeout(() => setToastMsg(""), 2500);
          return;
        }
        const replace = (m) => (m.id === updated.id ? updated : m);
        setItems((cur) => cur.map(replace));
        setRemoteItems((cur) => (cur ? cur.map(replace) : cur));
      };

      // 导出：JSON 走响应对象重序列化（缩进美化），Markdown 原样落盘；
      // 文件名带日期，浏览器下载不动主列表。
      const exportData = (format) => {
        apiFetch(`/api/dsh-mneme/export?format=${format}`)
          .then(async (res) => {
            if (!res.ok) throw new Error("http");
            const blob = format === "json"
              ? new Blob([JSON.stringify(await res.json(), null, 2)], { type: "application/json" })
              : new Blob([await res.text()], { type: "text/markdown" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `dsh-mneme-export-${new Date().toISOString().slice(0, 10)}.${format === "json" ? "json" : "md"}`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
          })
          .catch(() => {});
      };

      // Graph → memory jump: land on the browser tab with filters reset so
      // the target row is visible, selected and scrolled into view. A target
      // beyond the loaded pages renders as a single-row result set instead
      // of pulling page after page to find it.
      const jumpToMemory = (target) => {
        if (!target?.id) return;
        setView("memory");
        setType("all");
        setQuery("");
        setRemoteItems(items.some((m) => m.id === target.id) ? null : [target]);
        setExpandedMonths(null);
        setSelectedId(target.id);
      };

      const openGraphFor = (name) => {
        setGraphFocus(name || "");
        setView("entity");
      };

      // 状态页「查看全部」入口：跳回记忆库并预置对应筛选（清搜索态，避免
      // remoteItems 盖过浏览列表）。
      const browseWithFilter = (patch) => {
        setDepositedOnly(!!patch.deposited);
        setArchivedOnly(!!patch.archived);
        setQuery("");
        setRemoteItems(null);
        setView("memory");
      };

      const subviews = [
        { key: "memory", label: t("memory.explorer.tabMemory") },
        { key: "entity", label: t("memory.explorer.tabEntities") },
        { key: "status", label: t("memory.explorer.tabStatus") },
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
                h(Icon, { name: s.key === "memory" ? "database" : s.key === "entity" ? "waypoints" : s.key === "status" ? "activity" : "settings", size: 14, className: "mneme-vtabico" }),
                s.label
              ))
          ),
          view === "memory" && h("div", { className: "mneme-xtools" },
            h("div", { className: "mneme-seg", role: "group", "aria-label": t("memory.explorer.viewAria") },
              h("button", {
                type: "button",
                className: viewMode === "cards" ? "mneme-active" : "",
                onClick: () => switchViewMode("cards")
              }, t("memory.explorer.viewCards")),
              h("button", {
                type: "button",
                className: viewMode === "timeline" ? "mneme-active" : "",
                onClick: () => switchViewMode("timeline")
              }, t("memory.explorer.viewTimeline"))
            ),
            h("div", { className: "mneme-menuwrap" },
              h("button", {
                type: "button",
                className: "mneme-footbtn",
                style: { fontSize: 15, padding: "3px 9px" },
                "aria-label": t("memory.explorer.more"),
                "aria-expanded": String(menuOpen),
                title: t("memory.explorer.more"),
                onClick: () => { setMenuOpen(!menuOpen); setImportOpen(false); }
              }, "⋯"),
              menuOpen && h("div", { className: "mneme-menu", role: "menu" },
                h("button", { type: "button", role: "menuitem", onClick: () => { setMenuOpen(false); exportData("json"); } },
                  t("memory.explorer.exportJson")),
                h("button", { type: "button", role: "menuitem", onClick: () => { setMenuOpen(false); exportData("markdown"); } },
                  t("memory.explorer.exportMarkdown")),
                h("button", { type: "button", role: "menuitem", onClick: () => { setImportOpen(true); setMenuOpen(false); } },
                  t("memory.explorer.importMd"))
              ),
              importOpen && h(ImportDialog, {
                t,
                onClose: () => setImportOpen(false),
                onImported: () => setReloadKey((k) => k + 1)
              })
            )
          ),
        ),
        view === "memory" && h("div", { className: "mneme-xmain" },
          h("div", { className: "mneme-xside" },
            h("div", { className: "mneme-xcolhead" }, t("memory.explorer.searchTitle")),
            h("div", { className: "mneme-xsearchwrap" },
              h(Icon, { name: "search", size: 14, className: "mneme-xsearchico" }),
              h("input", {
                className: "mneme-search mneme-xsearch",
                placeholder: t("memory.explorer.search"),
                value: query,
                onChange: (e) => setQuery(e.target.value)
              })
            ),
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
              h("select", {
                className: "mneme-select mneme-xselect",
                value: dateRange,
                onChange: (e) => setDateRange(e.target.value),
                title: t("memory.explorer.dateLabel"),
                "aria-label": t("memory.explorer.dateLabel")
              },
                ["all", "7d", "30d", "90d"].map((k) =>
                  h("option", { key: k, value: k }, t(`memory.explorer.date.${k}`))))
            ),
            h("div", { className: "mneme-xrow" },
              h("span", { className: "mneme-xcount" }, t("memory.explorer.count").replace("{n}", String(visible.length))),
              h("button", { className: "mneme-footbtn", onClick: () => setReloadKey((k) => k + 1) },
                h(Icon, { name: "refresh", size: 12 }), t("memory.explorer.refresh"))
            )
          ),
          h("div", { className: "mneme-xside mneme-xside--filter" },
            h("div", { className: "mneme-xcolhead" }, t("memory.explorer.importance")),
            h("div", { className: "mneme-xrow" },
              [0, 3, 4, 5].map((v) =>
                h("button", {
                  key: v,
                  className: minImp === v ? "mneme-chip mneme-active" : "mneme-chip",
                  onClick: () => setMinImp(v)
                }, v === 0 ? t("memory.tab.all") : `★${v}+`))
            ),
            h("div", { className: "mneme-xcolhead" }, t("memory.explorer.sourceFilter")),
            h("div", { className: "mneme-xrow" },
              h("button", {
                className: depositedOnly ? "mneme-chip mneme-active" : "mneme-chip",
                title: t("memory.explorer.filterDepositedHint"),
                onClick: () => setDepositedOnly(!depositedOnly)
              }, t("memory.explorer.filterDeposited")),
              h("button", {
                className: archivedOnly ? "mneme-chip mneme-active" : "mneme-chip",
                title: t("memory.explorer.filterArchivedHint"),
                onClick: () => setArchivedOnly(!archivedOnly)
              }, t("memory.explorer.filterArchived"))
            ),
            heatAvailable && h(react.Fragment, null,
              h("div", { className: "mneme-xcolhead" }, t("memory.explorer.sort")),
              h("div", { className: "mneme-xrow" },
                h("button", {
                  className: heatSort ? "mneme-chip mneme-active" : "mneme-chip",
                  title: t("memory.explorer.heatSortHint"),
                  onClick: () => {
                    setHeatSort(!heatSort);
                    if (!heatSort) switchViewMode("cards"); // 排序只作用于卡片网格
                  }
                }, t("memory.explorer.heatSort"))
              )
            ),
            h("div", { className: "mneme-xcolhead" }, t("memory.explorer.types")),
            h("button", {
              className: type === "all" ? "mneme-xtype mneme-active" : "mneme-xtype",
              onClick: () => setType("all")
            }, h("span", { className: "mneme-xdot mneme-xdot--all", "aria-hidden": "true" }), h("span", null, t("memory.tab.all")), h("span", { className: "mneme-xcount2" }, String(items.length))),
            knownTypes.concat(extraTypes).map((key) =>
              h("button", {
                key,
                className: type === key ? "mneme-xtype mneme-active" : "mneme-xtype",
                onClick: () => setType(key)
              },
                h("span", { className: "mneme-xdot", style: { color: memoryTypeColor(key) }, title: typeLabel(t, key), "aria-hidden": "true" }),
                h("span", null, typeLabel(t, key)),
                h("span", { className: "mneme-xcount2" }, String(counts[key]))
              ))
          ),
          viewMode === "cards"
            ? h("div", { className: "mneme-cards" },
                loading
                  ? h("div", { className: "mneme-xempty", style: { gridColumn: "1 / -1" } }, "…")
                  : visible.length === 0
                    ? h("div", { className: "mneme-xempty", style: { gridColumn: "1 / -1" } },
                        h(Icon, { name: "inbox", size: 20, className: "mneme-xemptyico" }),
                        t("memory.explorer.empty"))
                    : gridItems.map((m) => h("button", {
                        key: m.id,
                        type: "button",
                        className: m.id === selectedId ? "mneme-card mneme-active" : "mneme-card",
                        onClick: () => setSelectedId(m.id)
                      },
                        h("div", { className: "mneme-cardhead" },
                          h("span", { className: "mneme-xdot", style: { color: memoryTypeColor(m.type) }, title: typeLabel(t, m.type), "aria-hidden": "true" }),
                          h("span", null, typeLabel(t, m.type)),
                          h("span", { style: { marginLeft: "auto", fontVariantNumeric: "tabular-nums" } }, formatRelativeTime(m.updated_at || m.created_at, t))
                        ),
                        pendingIds.has(m.id) && h("span", { className: "mneme-badge mneme-badge--conflict", style: { alignSelf: "flex-start" } }, "⚠ ", t("memory.explorer.conflictBadge")),
                        h("div", { className: "mneme-cardtitle" }, m.title || (m.content || "").slice(0, 60)),
                        h("div", { className: "mneme-cardexcerpt" }, m.content || ""),
                        h("div", { className: "mneme-cardfoot" },
                          h(ImportanceStars, { value: m.importance || 0, size: 12 }),
                          h(HeatBadge, { value: m.heat }),
                          m.source && h("span", { className: "mneme-cardsrc", title: m.source }, m.source)
                        )
                      )),
                h("div", { ref: moreRef, className: "mneme-xmore", style: { gridColumn: "1 / -1" } },
                  canLoadMore
                    ? h("button", { className: "mneme-footbtn", disabled: loadingMore, onClick: loadMore },
                        loadingMore ? "…" : `${t("memory.explorer.loadMore")}（${items.length}/${total}）`)
                    : (!loading && visible.length > 0 && !q && !remoteItems
                        ? h("span", { className: "mneme-xcount" }, `${items.length} / ${total}`)
                        : null))
              )
            : h("div", { className: "mneme-xbrowse" },
            h("div", { className: "mneme-xtree" },
              h("div", { className: "mneme-xcolhead" }, t("memory.explorer.timeline")),
              loading
                ? h("div", { className: "mneme-xempty" }, "…")
                : visible.length === 0
                  ? h("div", { className: "mneme-xempty" },
                      h(Icon, { name: "inbox", size: 20, className: "mneme-xemptyico" }),
                      t("memory.explorer.empty"))
                  : months.map((month, mi) => {
                      // Only the newest month starts expanded; older months
                      // stay a one-line header until clicked — a several-
                      // thousand-row store renders a handful of DOM nodes.
                      const open = expandedMonths ? !!expandedMonths[month.key] : mi === 0;
                      return h("div", { key: month.key },
                        h("button", {
                          className: "mneme-xmonth",
                          "aria-expanded": String(open),
                          onClick: () => setExpandedMonths((c) => {
                            const base = c || (months.length ? { [months[0].key]: true } : {});
                            return { ...base, [month.key]: !open };
                          })
                        },
                          h("span", { className: "mneme-xcaret" }, h(Icon, { name: open ? "chevronDown" : "chevronRight", size: 12 })),
                          h("span", null, month.label),
                          h("span", { className: "mneme-xmonthcount" }, String(month.count))
                        ),
                        open && month.days.map((day) =>
                          h("div", { key: day.key },
                            h("button", {
                              className: "mneme-xday",
                              "aria-expanded": String(!collapsed[day.key]),
                              onClick: () => setCollapsed((c) => ({ ...c, [day.key]: !c[day.key] }))
                            },
                              h("span", { className: "mneme-xcaret" }, h(Icon, { name: collapsed[day.key] ? "chevronRight" : "chevronDown", size: 11 })),
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
                                h("span", { className: "mneme-xdot", style: { color: memoryTypeColor(m.type) }, title: typeLabel(t, m.type), "aria-hidden": "true" }),
                                h("span", { className: "mneme-xtime" }, time),
                                h("span", { className: "mneme-xname" }, m.title || m.content?.slice(0, 40))
                              );
                            })
                          ))
                      );
                    }),
              h("div", { ref: moreRef, className: "mneme-xmore" },
                canLoadMore
                  ? h("button", { className: "mneme-footbtn", disabled: loadingMore, onClick: loadMore },
                      loadingMore ? "…" : `${t("memory.explorer.loadMore")}（${items.length}/${total}）`)
                  : (!loading && visible.length > 0 && !q && !remoteItems
                      ? h("span", { className: "mneme-xcount" }, `${items.length} / ${total}`)
                      : null)
              )
            ),
            ),
      // 详情抽屉：卡片/时间线共用，选中即从右侧滑出（替代旧底部面板）。
      // 两步删除确认在抽屉内完成；编辑/归档经 /update 落库并同步本地视图。
      selected && h(MemoryDrawer, {
        key: selected.id,
        t,
        memory: selected,
        conflict: pendingIds.has(selected.id),
        deleting,
        deleteError,
        onClose: () => setSelectedId(null),
        onDelete: deleteById,
        onSaved: applyMemoryUpdate
      })
        ),
        view === "entity" && h(EntityPanel, { t, focusEntity: graphFocus, onJumpMemory: jumpToMemory }),
        view === "status" && h(StatusPanel, { t, onBrowse: browseWithFilter }),
        view === "settings" && h("div", { className: "mneme-set" },
          h("div", { className: "mneme-set-inner" }, h(SettingsContent, { t }))
        ),
        toastMsg && h("div", { className: "mneme-toast", role: "status" }, toastMsg)
      );
    }

    // --- Sidebar entry: 工作区上方的记忆按钮 ---
    // 注册仍在 sidebar.footer.action（list 插槽）——它既是 React 树的挂载
    // 锚点，也是 portal 失效时的原位回退。真实按钮 portal 插到「新会话」行
    // 之后、插件入口组的最前：任务看板/技能中心等生态插件也把入口插在新会话
    // 行后（它们的后插入者在上），若我们固定在 regionArea 之前就会被打成
    // 入口组末尾的孤立位（issue #130），所以观察器发现错位就搬回锚点位。
    // 几何对齐方案：读取宿主「新会话」按钮的实时 className 原样套用，再用
    // 我们的修饰类覆盖配色（次级观感）。这样展开态与收起态（rail）都直接
    // 继承宿主自己的盒模型与间距——宿主改版/缩进动画零位移，无需硬编码。
    // 宿主结构异常时约 2 秒后放弃 portal，footer 回退按钮保持可用。
    function SidebarFallbackTrigger({ wide, t }) {
      return h("button", {
        type: "button",
        className: wide ? "mneme-trigger" : "mneme-trigger mneme-rail",
        "aria-label": t("memory.sidebar.aria"),
        title: t("memory.panel.open"),
        onClick: openLibrary
      },
        h(IconArchiveOutline20, { size: wide ? 16 : 18 }),
        wide && h("span", { className: "mneme-trigger-label" }, t("memory.panel.open"))
      );
    }

    function SidebarTopEntry({ wide, t, fallback }) {
      const [host, setHost] = useState(null);
      const [nativeCls, setNativeCls] = useState("");
      useEffect(() => {
        if (!reactDom || typeof document === "undefined") return undefined;
        let tries = 0, timer = null, created = null, mo = null;
        const findNative = (region) =>
          region.parentElement.querySelector('[class*="newSession"]')
          || region.previousElementSibling;
        // 占位锚点：新会话行（现役外壳里 newSession 按钮嵌在 logoRow 内，
        // 旧外壳是根的直接子按钮）。判定与生态插件的 sidebar-entry-core
        // 一致；锚点不可靠时回退到 regionArea 之前的旧位置。
        const findAnchor = (region) => {
          const parent = region.parentElement;
          const btn = parent.querySelector('[class*="newSession"]');
          if (!btn) return null;
          const row = btn.closest('[class*="logoRow"]');
          if (row && row.parentElement === parent) return row;
          return btn.parentElement === parent ? btn : null;
        };
        // 占位规则：紧跟新会话行（插件入口组的顶部），幂等——已在锚点位就
        // 不动 DOM。生态插件后插入时会把我们压下去一位，观察器里重排搬回；
        // 它们只在自身节点被移除时才重插，不会与我们来回争抢。
        // 注意 created 已紧跟锚点时 target 即 created 自身，必须直接返回：
        // insertBefore(x, x) 在 Chromium 里不是 no-op，会触发 mutation 造成
        // 观察器自激风暴、冻死整个 SPA。
        const place = (region) => {
          const parent = region.parentElement;
          if (!parent) return;
          const anchor = findAnchor(region);
          const target = anchor ? anchor.nextSibling : region;
          if (target === created) return;
          if (created.parentElement === parent && created.nextSibling === target) return;
          parent.insertBefore(created, target);
        };
        const attempt = () => {
          const region = document.querySelector('[class*="regionArea"]');
          if (region && region.parentElement) {
            // 「新会话」按钮与 regionArea 同级且紧邻其前，借它的类名获得
            // 与原生侧边栏项完全一致的盒模型（含收起态 rail 几何）。
            // 宿主/皮肤会异步改写按钮类名，用 MutationObserver 持续同步，
            // 否则 portal 按钮会停留在捕获时刻的旧类上（宽度/对齐失配）。
            created = document.createElement("div");
            created.dataset.pluginEntry = "@modusensus/dsh-mneme";
            place(region);
            setHost(created);
            setNativeCls(findNative(region)?.className || "");
            mo = new MutationObserver(() => {
              const cur = document.querySelector('[class*="regionArea"]');
              if (!cur || !cur.parentElement) return;
              place(cur);
              const cls = findNative(cur)?.className || "";
              setNativeCls((prev) => (prev === cls ? prev : cls));
            });
            mo.observe(region.parentElement, {
              attributes: true,
              attributeFilter: ["class"],
              childList: true,
              subtree: true
            });
            return;
          }
          if (++tries > 40) return; // 放弃 portal，footer 回退保持可用
          timer = setTimeout(attempt, 50);
        };
        attempt();
        return () => {
          clearTimeout(timer);
          if (mo) mo.disconnect();
          if (created && created.parentElement) created.parentElement.removeChild(created);
        };
      }, []);
      if (!host) return fallback;
      return reactDom.createPortal(
        h("div", { className: "mneme-topentry" },
          h("button", {
            type: "button",
            className: `${nativeCls} mneme-topentry-native`.trim(),
            "aria-label": t("memory.sidebar.aria"),
            title: t("memory.panel.open"),
            onClick: openLibrary
          },
            h(IconArchiveOutline20, { size: wide ? 15 : 18 }),
            wide && h("span", { className: "mneme-topentry-label" }, t("memory.panel.open"))
          )
        ), host);
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, dictionaries), "dsh-mneme: dictionaries");

      // 记忆库唯一入口：sidebar.footer.action 注册作为锚点与回退；真实按钮
      // 由 SidebarTopEntry portal 到侧边栏工作区上方。overlay 从这个常驻
      // 插槽挂载（portal 到 body），会话切换不影响它的开关状态。
      // v0.7.15 起不再注册 conversation.view tab——对话内嵌的面板被悬浮
      // 输入框遮挡、挤压会话布局，sheet 页是更舒服的承载方式。
      ctx.slots.inject("sidebar.footer.action", () => {
        return ctx.slots.register({
          name: "sidebar.footer.action",
          id: "dsh-mneme",
          order: 0,
          label: () => t("memory.panel.open")
        }, (props) => h(react.Fragment, null,
          h(SidebarTopEntry, {
            wide: !!(props && props.wide),
            t,
            fallback: h(SidebarFallbackTrigger, { wide: !!(props && props.wide), t })
          }),
          h(MemoryOverlay, { t })
        ));
      });

      // --- better-sidebar 生态 tab（可选软依赖）---
      // ⚠️ 平台事实（issue #88 实测 + dsh-server-deck 同款方案）：模块级
      // inject 声明 betterSidebar 是硬等待——未安装 bs 的环境整个 entry
      // pending（"1 entry did not activate" → Failed to load plugins），
      // v0.7.18 即因此对无 bs 用户启动失败。正确双模式（server-deck 验证
      // 过）：外层入口零 inject 立即激活（独立模式保底）；tab 注册挂在内层
      // 动态子插件 `ctx.plugin({ inject: ['betterSidebar'] })`，由 cordis
      // 原生等待服务——bs 未装时该内层 fiber 永远 INACTIVE，静默无害。
      // 兄弟上下文取未声明属性会直接抛错（"cannot get property without
      // inject"），轮询探测方案不可用。
      ctx.effect(() => {
        let dead = false;
        try {
          ctx.plugin?.({
            name: "dsh-mneme:bs-tab",
            inject: ["betterSidebar"],
            apply: (bsCtx) => {
              bsCtx.effect(() => {
                if (dead) return;
                const reg = bsCtx.betterSidebar;
                if (!reg || typeof reg.registerTab !== "function") return;
                  const TAB_ID = "dsh-mneme:memory";
                  if (typeof reg.getTab === "function" && reg.getTab(TAB_ID)) {
                    console.warn(`[dsh-mneme] better-sidebar tab "${TAB_ID}" already registered, skipping duplicate`);
                    return;
                  }
                try {
                  reg.registerTab({
                    id: TAB_ID,
                    title: () => t("memory.view.label"),
                    icon: (size) => h(IconArchiveOutline20, { size }),
                    order: 60,
                    component: () => h(MemoryExplorer, { t })
                  });
                } catch (err) {
                  // id 重复等注册失败不应拖垮其余功能，留一条线索即可
                  console.warn("[dsh-mneme] better-sidebar registerTab failed, falling back to native sidebar entry:", err);
                }
              }, "dsh-mneme: better-sidebar tab");
            }
          });
        } catch (err) {
          console.error("[dsh-mneme] better-sidebar mount failed:", err);
        }
        return () => { dead = true; };
      }, "dsh-mneme: better-sidebar mount");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});