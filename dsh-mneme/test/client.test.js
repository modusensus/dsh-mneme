import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientSource = readFileSync(join(root, "lib/client.js"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// The Web client bundle registers itself via __ModuleLoader__.load. DSH
// resolves the bundle by plugin package name, so the registered id must match
// package.json `name` exactly (a mismatch surfaces as "loaded without
// registering '@modusensus/dsh-mneme'" in the DSH client).
test("client bundle registers under the package name", () => {
  const match = clientSource.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/);
  assert.ok(match, "client bundle must call __ModuleLoader__.load with an id");
  assert.equal(match[1], pkg.name, "registered id must equal package.json name");
});

// client.js is hand-authored under lib/ only (no src/ counterpart), so the
// src->lib sync must never prune it.
test("client bundle is lib-only with no src counterpart", () => {
  assert.equal(existsSync(join(root, "src/client.js")), false, "src/ must not contain client.js");
  assert.equal(existsSync(join(root, "lib/client.js")), true, "lib/client.js must exist");
});

// The memory entry lives at the sidebar foot, not in the settings modal: the
// migration must register into `sidebar.footer.action` (the list slot the
// sidebar shell renders beside Settings) and must not keep a `settings.section`
// registration, or the entry would appear twice under different hosts.
test("memory entry registers into the sidebar foot slot", () => {
  assert.ok(
    clientSource.includes('ctx.slots.inject("sidebar.footer.action"'),
    "client must inject into sidebar.footer.action"
  );
  assert.equal(
    clientSource.includes('"settings.section"'),
    false,
    "the old settings.section registration must be gone"
  );
});

// The tab era is over: the in-conversation memory tab fought the floating
// composer and squeezed the session layout, so the library no longer
// registers as a conversation view. The sidebar entry opens the centered
// sheet directly — from any state, including the new-chat hero screen. A
// dialog role stays banned either way.
test("sidebar entry opens the sheet; conversation-view tab stays retired", () => {
  assert.equal(
    clientSource.includes("role: \"dialog\""),
    false,
    "no dialog surface should remain"
  );
  assert.ok(
    /function openLibrary\(\) \{\s*setOverlayOpen\(true\);\s*\}/.test(clientSource),
    "the entry must open the overlay directly (no tab activation)"
  );
  assert.equal(
    clientSource.includes('ctx.slots.inject("conversation.view"'),
    false,
    "the conversation.view tab must stay retired"
  );
  assert.equal(
    clientSource.includes("activateExplorerTab"),
    false,
    "the tab-click activation machinery must be gone"
  );
});

// The sheet is deliberately NOT fullscreen: a dimmed backdrop plus a rounded
// panel capped at 1180×880 keeps the conversation visible behind it. It
// reuses the full MemoryExplorer and closes on Esc, the close button, or a
// backdrop click.
test("memory library opens as a centered sheet with backdrop", () => {
  assert.ok(
    clientSource.includes(".mneme-backdrop{position:fixed;inset:0"),
    "a dimmed backdrop must sit behind the sheet"
  );
  assert.ok(
    /\.mneme-overlay\{position:fixed;z-index:1000;left:50%;top:50%;transform:translate\(-50%,-50%\)/.test(clientSource),
    "the sheet must be centered, not viewport-filling"
  );
  assert.ok(
    clientSource.includes("width:min(1240px,calc(100vw - 88px))"),
    "the sheet must not occupy the full width and keeps friendly margins"
  );
  assert.ok(
    clientSource.includes('h(MemoryExplorer, { t })'),
    "the sheet renders the same MemoryExplorer component"
  );
  assert.ok(
    clientSource.includes('e.key === "Escape"'),
    "Esc must close the sheet"
  );
  assert.ok(
    clientSource.includes('className: "mneme-backdrop"'),
    "the backdrop is a clickable close surface"
  );
  assert.ok(
    clientSource.includes('"memory.overlay.close"'),
    "the close affordance keeps its localized label"
  );
});

// The sidebar hands each entry only its column state: a wide row (icon +
// label) when expanded, a bare rail icon when collapsed — for both the
// portalled top button and the footer fallback.
test("trigger renders a wide row or a rail icon from the wide flag", () => {
  assert.ok(
    /wide \? "mneme-trigger" : "mneme-trigger mneme-rail"/.test(clientSource),
    "trigger must branch on the wide flag"
  );
  assert.ok(
    /wide && h\("span", \{ className: "mneme-trigger-label" \}/.test(clientSource),
    "the label span must render only when wide"
  );
  assert.ok(
    /size: wide \? 15 : 18/.test(clientSource),
    "the portalled icon must follow the native rail sizing convention"
  );
});

// The entry lives ABOVE the workspaces region: the real button is portalled
// just before the host's regionArea container (below New Session, above the
// workspace list), while the sidebar.footer.action registration remains as
// the React anchor and the in-place fallback when the host markup changes.
test("sidebar entry portals above the workspaces region with footer fallback", () => {
  assert.ok(
    clientSource.includes('ctx.slots.inject("sidebar.footer.action"'),
    "the footer slot registration must stay as anchor + fallback"
  );
  assert.ok(
    clientSource.includes("SidebarTopEntry"),
    "the portalled top entry must exist"
  );
  assert.ok(
    clientSource.includes(`'[class*="regionArea"]'`),
    "the portal must anchor at the host's regionArea container"
  );
  assert.ok(
    clientSource.includes("insertBefore(created, region)"),
    "the entry must sit immediately above the workspaces region"
  );
  assert.ok(
    clientSource.includes("if (!host) return fallback;"),
    "the portal entry persists across collapse (no footer jump); footer fallback only covers portal failure"
  );
  assert.ok(
    clientSource.includes('className: `${nativeCls} mneme-topentry-native`'.replace("${nativeCls} mneme-topentry-native", "${nativeCls} mneme-topentry-native")),
    "the entry must reuse the host New-Session button class for native geometry alignment"
  );
  assert.ok(
    /querySelector\('\[class\*="newSession"\]'\)/.test(clientSource),
    "the native class must be read from the live New-Session button, not hardcoded"
  );
  assert.ok(
    clientSource.includes('"memory.view.label"'),
    "the sheet aria-label must come from the memory.view.label dictionary key"
  );
});

// Three alignment/softness guarantees born from field feedback: (a) the
// portalled entry keeps tracking the live New-Session class (host and skin
// rewrite it asynchronously, so a mount-time snapshot goes stale), (b) it
// fills the same width as that button and inherits its native centering,
// (c) the toolbar dropdown escapes the transform stacking trap — the
// container needs the z-index because transform creates the context.
test("entry tracks native class, fills native width, and lifts the toolbar dropdown", () => {
  assert.ok(
    clientSource.includes("new MutationObserver"),
    "the entry must re-sync the copied class via MutationObserver"
  );
  assert.ok(
    clientSource.includes('attributeFilter: ["class"]'),
    "the observer must watch class attribute changes"
  );
  assert.ok(
    /\.mneme-topentry-native\{width:100%;/.test(clientSource),
    "the entry button must fill the same width as the New-Session row"
  );
  assert.equal(
    clientSource.includes(".mneme-topentry-native .mneme-topentry-label{flex:1;min-width:0;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"),
    false,
    "the old left-aligned label override must go; native centering applies"
  );
  assert.ok(
    /\.mneme-xtools\{[^}]*z-index:3\}/.test(clientSource),
    "the toolbar container must carry z-index:3 (sticky month header is 2, drawer 6)"
  );
});

// Importance renders as Lucide star glyphs (the morphicons-paired data set;
// the runtime cannot require the ESM-only morphicons engine, so the path
// ships inline like the other stroke icons), not raw ★ text. Only the
// drawer's edit-mode <option> labels keep the text form — SVG cannot render
// inside <option>.
test("importance renders as star glyphs, not raw text stars", () => {
  assert.ok(
    clientSource.includes("STAR_PATH_D"),
    "the Lucide star path data must be inlined"
  );
  assert.ok(
    clientSource.includes("const ImportanceStars"),
    "the star-row component must exist"
  );
  assert.equal(
    (clientSource.match(/"★"\.repeat/g) || []).length,
    1,
    "only the drawer edit <option> labels may keep the ★ text form"
  );
  assert.ok(
    /h\(ImportanceStars, \{ className: "mneme-dmetaval"/.test(clientSource),
    "the drawer detail must render the star row"
  );
  assert.ok(
    /h\(ImportanceStars, \{ value: m\.importance/.test(clientSource),
    "the card foot must render the star row"
  );
});

// better-sidebar ecosystem integration is an optional capability (official
// external-plugin-guide §2.2): 'betterSidebar' IS declared in inject (DSH's
// runtime gates ctx property access on the inject declaration — probing
// without declaring fails the whole loader entry, verified in the field) and
// better-sidebar 软集成（issue #88 修正）：模块级 inject 声明 betterSidebar
// 是硬等待——未安装 bs 的环境整个 entry pending（"1 entry did not activate"，
// Failed to load plugins）。正确模式（dsh-server-deck 同款）：外层入口零
// inject 立即激活（独立模式保底），tab 注册挂在内层动态子插件
// ctx.plugin({ inject: ['betterSidebar'] }) 由 cordis 原生等待服务——bs 未装
// 时该内层 fiber 永远 INACTIVE，静默无害。
test("better-sidebar tab mounts via an inner sub-plugin, standalone mode intact", () => {
  assert.ok(
    /const reg = bsCtx\.betterSidebar;[\s\S]{0,60}typeof reg\.registerTab !== "function"/.test(clientSource),
    "the inner apply must still guard the service shape before registering"
  );
  assert.ok(
    /id: "dsh-mneme:memory"/.test(clientSource),
    "the registered tab id must be package-prefixed"
  );
  assert.ok(
    /title: \(\) => t\("memory\.view\.label"\)/.test(clientSource),
    "the tab title must reuse the localized 记忆库 label"
  );
  assert.ok(
    /component: \(\) => h\(MemoryExplorer, \{ t \}\)/.test(clientSource),
    "the tab must reuse the MemoryExplorer views"
  );
  assert.ok(
    clientSource.includes('"dsh-mneme: better-sidebar tab"'),
    "the registration effect must carry a named label for scope cleanup"
  );
  // issue #88：模块级 inject 声明 betterSidebar 是硬等待——未安装 bs 的环境
  // 整个 entry pending（"1 entry did not activate"）。tab 注册必须挂在内层
  // 动态子插件（dsh-server-deck 同款模式），外层入口零 inject 立即激活。
  assert.ok(
    /const inject = \["slots", "locale"\]/.test(clientSource),
    "the module inject must not declare betterSidebar (hard-wait regression)"
  );
  assert.ok(
    /ctx\.plugin\?\.\(\{[\s\S]*?inject: \["betterSidebar"\][\s\S]*?apply: \(bsCtx\) =>/.test(clientSource),
    "the tab registration must live in an inner dynamic sub-plugin waiting on cordis"
  );
  assert.ok(
    /if \(\+\+tries <= 10\) timer = setTimeout\(attempt, 1000\);/.test(clientSource) === false,
    "the old 10×1s probe must go — cordis waits for the inner inject natively"
  );
});

// The graph toggle must not read as "share": the primitives share icon is
// banned and a custom node-graph glyph takes its place.
test("graph toggle uses a node-graph glyph, not the share icon", () => {
  assert.equal(
    clientSource.includes("IconShareOutline16"),
    false,
    "IconShareOutline16 reads as share and must not appear"
  );
  assert.ok(
    clientSource.includes("GraphNodesIcon"),
    "the custom node-graph icon must back the graph toggle"
  );
});

// 方案 A：查询收敛。状态页只做仪表盘（小页预览 + 服务端 total + 查看全部），
// 沉淀/归档的完整浏览走记忆库的 deposited/archived 筛选视图（chip 预置 +
// 状态页入口跳转），详情抽屉给归档记忆一个反向的「恢复」。
test("status dashboard links into deposited/archived library views", () => {
  assert.ok(
    clientSource.includes('"/api/dsh-mneme/list?deposited=only&limit=8&order=chrono"'),
    "the workbench deposited preview must read the server-side deposited view"
  );
  assert.ok(
    clientSource.includes('"/api/dsh-mneme/list?archived=only&limit=3&order=chrono"'),
    "the workbench archived preview must cap at 3 rows backed by a server total"
  );
  assert.ok(
    clientSource.includes("browseWithFilter"),
    "the status page must jump into the library with preset filters"
  );
  assert.ok(
    /view === "status" && h\(StatusPanel, \{ t, onBrowse: browseWithFilter \}\)/.test(clientSource),
    "the status panel must receive the browse-jump callback"
  );
  assert.ok(
    clientSource.includes('(depositedOnly ? "&deposited=only" : "")'),
    "the library filterQS must carry the deposited chip"
  );
  assert.ok(
    clientSource.includes('(archivedOnly ? "&archived=only" : "")'),
    "the library filterQS must carry the archived chip"
  );
  assert.ok(
    clientSource.includes('postUpdate({ archived: false }, { restored: true })'),
    "the drawer must offer restore for archived memories"
  );
  assert.ok(
    clientSource.includes('"memory.status.viewAll"'),
    "the view-all entries must come from the dictionary"
  );
});

// Every memory feature lives in the main-area library now: the explorer
// hosts three sub-views (browse / entities / settings) switched by tabs whose
// labels come from dedicated dictionary keys.
test("explorer hosts browse, entities and settings sub-views", () => {
  for (const key of ["tabMemory", "tabEntities", "tabSettings"]) {
    assert.ok(
      clientSource.includes(`"memory.explorer.${key}"`),
      `sub-view labels must come from memory.explorer.${key}`
    );
  }
  assert.ok(
    clientSource.includes("h(EntityPanel, { t, focusEntity: graphFocus, onJumpMemory: jumpToMemory })"),
    "the entity panel must be embedded as a sub-view"
  );
  assert.ok(
    clientSource.includes('h(SettingsContent, { t })'),
    "the settings forms must be embedded as a sub-view"
  );
});

// The graph panel jumps back into the browser: related-memory rows and the
// edge source button must land on the browse tab with the target selected.
test("graph jump lands on the selected memory in the browser", () => {
  assert.ok(
    /onClick: \(\) => onJumpMemory && onJumpMemory\(m\)/.test(clientSource),
    "related-memory rows must jump via onJumpMemory(m)"
  );
  assert.ok(
    clientSource.includes("onJumpMemory({ id: selected.edge.memory_id })"),
    "the edge source button must jump to the origin memory by id"
  );
  assert.ok(
    /const jumpToMemory = \(target\) => \{/.test(clientSource),
    "jumpToMemory must reset filters and select the target"
  );
});

// "entity:" in the browser search is the graph entry grammar: it must offer
// a jump chip instead of filtering the list.
test("entity: search grammar offers a graph jump", () => {
  assert.ok(
    clientSource.includes('query.trim().startsWith("entity:")'),
    "the entity: prefix must be recognized"
  );
  assert.ok(
    /onClick: \(\) => openGraphFor\(entityQuery\)/.test(clientSource),
    "the jump chip must switch to the graph sub-view"
  );
});

// The explorer is a card-grid / timeline browse with a right-hand detail
// drawer: types with counts, a month→day time tree (timeline mode), and the
// drawer rendering the untruncated content.
test("explorer lays out types, timeline, and full-text detail", () => {
  assert.ok(
    clientSource.includes('className: "mneme-xmain"'),
    "the three-column grid must be present"
  );
  assert.ok(
    clientSource.includes('className: "mneme-dcontent"'),
    "the detail drawer must render the full content"
  );
  assert.ok(
    clientSource.includes('className: "mneme-cards"'),
    "the card-grid view must exist alongside the timeline"
  );
  assert.ok(
    /toLocaleDateString\(undefined, \{ year: "numeric", month: "long" \}\)/.test(clientSource),
    "month groups must format via the host locale, not hardcoded strings"
  );
});

// The library page must read as a first-party view: the chrome resolves to
// the host's design tokens (layer-1 canvas, brand-blue active states) and
// the boxed-panel / pill-chip patterns of the drawer era must stay gone.
test("explorer chrome aligns with the host design system", () => {
  assert.ok(
    clientSource.includes("background:var(--dsw-alias-bg-layer-1)"),
    "the page canvas must sit on the host bg-layer-1 token"
  );
  assert.ok(
    /\.mneme-vtab\.mneme-active::after/.test(clientSource),
    "active sub-tabs use the host underline treatment"
  );
  assert.ok(
    clientSource.includes(".mneme-vtab.mneme-active{color:var(--dsw-alias-state-business-primary)}"),
    "active sub-tab text must turn the host brand blue"
  );
  assert.equal(
    /\.mneme-xmain\{[^}]*border:1px/.test(clientSource),
    false,
    "the three-column layout must not wrap itself in a boxed panel"
  );
  assert.equal(
    clientSource.includes("border-radius:999px"),
    false,
    "pill chips belong to the drawer era and must stay gone"
  );
});

// heat 阶段二：/list 仅在 heatEnabled=true 时下发逐条 heat，前端徽章三档
// 配色且自门控（字段缺省自动隐藏）——卡片页脚、抽屉 meta、状态分布卡共用
// 同一数据源，前端不感知开关状态。
test("heat badges render from the /list projection and self-hide when off", () => {
  assert.ok(
    /const HeatBadge = \(\{ value, size = 12 \}\) =>/.test(clientSource),
    "the heat badge component must exist"
  );
  assert.ok(
    clientSource.includes("flame:"),
    "the Lucide flame glyph must back the badge"
  );
  assert.ok(
    /h\(HeatBadge, \{ value: m\.heat \}\)/.test(clientSource),
    "the card foot must render the heat badge"
  );
  assert.ok(
    clientSource.includes('t("memory.explorer.heat")'),
    "the drawer must show a localized heat meta row"
  );
  assert.ok(
    clientSource.includes("function HeatStatusCard"),
    "the status grid must include the heat distribution card"
  );
  assert.ok(
    clientSource.includes('typeof items[0].heat !== "number"'),
    "the distribution card must self-hide when /list omits heat"
  );
  assert.ok(
    /\.mneme-heat--hot\{/.test(clientSource),
    "the three-tier heat colors must be styled"
  );
  // order=heat 的前端补口：热度是运行时投影无存储序，SQL 排不了——页内
  // 对已加载条目降序，时间树保持 chrono；chip 自门控（heat 缺省不出现）。
  assert.ok(
    /const heatAvailable = visible\.some\(\(m\) => typeof m\.heat === "number"\);/.test(clientSource),
    "the heat-sort chip must self-gate on the /list heat field"
  );
  assert.ok(
    /const gridItems = heatSort[\s\S]{0,80}\(b\.heat \?\? 0\) - \(a\.heat \?\? 0\)/.test(clientSource),
    "the cards grid must sort loaded items by heat in-page"
  );
  assert.ok(
    clientSource.includes("if (!heatSort) switchViewMode(\"cards\")"),
    "toggling heat sort must land on the cards view (sort does not apply to the month tree)"
  );
});
