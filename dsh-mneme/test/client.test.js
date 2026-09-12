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

// The entry lives at the top of the plugin-entry group: the real button is
// portalled right after the host's New-Session row (above the entries other
// plugins inject there), while the sidebar.footer.action registration remains
// as the React anchor and the in-place fallback when the host markup changes.
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
    clientSource.includes("insertBefore(created, target)"),
    "the entry must be placed through the idempotent place() helper"
  );
  assert.ok(
    clientSource.includes("if (!host) return fallback;"),
    "the portal entry persists across collapse (no footer jump); footer fallback only covers portal failure"
  );
  assert.ok(
    clientSource.includes('className: `${nativeCls} mneme-topentry-native`'),
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

// Issue #130: ecosystem plugins (task board, skill explorer, …) inject their
// own entries right after the New-Session row, and late inserters land above
// earlier ones — a fixed "before regionArea" slot degrades into the tail of
// that group, detaching the memory button from its familiar top spot. The
// entry therefore (a) resolves the same anchor as the ecosystem's shared
// sidebar-entry-core (logoRow row, legacy direct-child button), (b) re-asserts
// its slot from the existing observer, and (c) stays idempotent — the anchor
// check short-circuits before any DOM write, so observers never ping-pong.
test("entry re-asserts the New-Session-adjacent slot against ecosystem entries", () => {
  assert.ok(
    clientSource.includes(`btn.closest('[class*="logoRow"]')`),
    "the anchor must resolve the New-Session logo row like the ecosystem core"
  );
  assert.ok(
    clientSource.includes("const target = anchor ? anchor.nextSibling : region;"),
    "the entry must sit right after the New-Session row, falling back before regionArea"
  );
  assert.ok(
    clientSource.includes("if (created.parentElement === parent && created.nextSibling === target) return;"),
    "placement must be idempotent so the observer never writes on steady state"
  );
  assert.ok(
    /place\(cur\);\s*\n\s*const cls = findNative\(cur\)/.test(clientSource),
    "the observer must re-place the entry on childList churn, not just re-sync the class"
  );
});

// Three alignment/softness guarantees born from field feedback: (a) the
// portalled entry keeps tracking the live New-Session class (host and skin
// rewrite it asynchronously, so a mount-time snapshot goes stale), (b) it
// inherits that button's width and margins along with its native centering,
// (c) the toolbar dropdown escapes the transform stacking trap — the
// container needs the z-index because transform creates the context.
test("entry tracks native class, inherits native sizing, and lifts the toolbar dropdown", () => {
  assert.ok(
    clientSource.includes("new MutationObserver"),
    "the entry must re-sync the copied class via MutationObserver"
  );
  assert.ok(
    clientSource.includes('attributeFilter: ["class"]'),
    "the observer must watch class attribute changes"
  );
  assert.doesNotMatch(
    clientSource,
    /\.mneme-topentry-native\{(?:[^}]*;)?width:/,
    "the entry must use the native button width, which reserves its horizontal margins"
  );
  assert.ok(
    clientSource.includes(".mneme-topentry{display:flex;flex-direction:column}"),
    "the entry wrapper must stretch the native button within a column flex layout"
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
    /(?:const TAB_ID = |id: )"dsh-mneme:memory"/.test(clientSource),
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
    /reg\.registerTab\(\{ \.\.\.descriptor, kind: TAB_ID \}\)/.test(clientSource),
    "the first register attempt must include kind for better-sidebar/native bridge compatibility"
  );
  assert.ok(
    /catch \(errWithKind\) \{[\s\S]{0,140}reg\.registerTab\(descriptor\)/.test(clientSource),
    "if kind is rejected, registration must fall back to the legacy descriptor"
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

// 巩固/睡眠模型路由 UI：下拉数据来自宿主侧已注册适配器（/llm-providers，
// 云端插件侧端点），「测试连通性」走 POST /test-model 真实最小调用。旧后端
// 端点 404 时必须回退纯文本输入——前端自门控，不挡旧版本。
test("consolidation/sleep model routing: provider dropdowns from /llm-providers, connectivity test via /test-model, graceful fallback", () => {
  // 1. 端点探测与降级
  assert.ok(
    clientSource.includes('apiFetch("/api/dsh-mneme/llm-providers")'),
    "the features card must probe GET /llm-providers for the route dropdowns"
  );
  assert.ok(
    /setRoutes\(Array\.isArray\(j && j\.providers\) \? j\.providers : \[\]\)/.test(clientSource),
    "the probe must only accept a {providers: []} shape"
  );
  assert.ok(
    /Array\.isArray\(routes\)\s*\?\s*routeSelects\("dreamProvider", "dreamModel", dreamTest, setDreamTest\)/.test(clientSource),
    "dream routing must upgrade to dropdowns only when the probe succeeded"
  );
  assert.ok(
    /:\s*h\(react\.Fragment, null, strRow\("dreamProvider"\), strRow\("dreamModel"\)\)/.test(clientSource),
    "when /llm-providers is unavailable the plain text inputs must remain (old-backend fallback)"
  );
  // 2. 睡眠侧行：跟随 sleepModeEnabled 门控，与巩固共用数据源
  assert.ok(
    /const sleepSub = eff\.sleepModeEnabled && Array\.isArray\(routes\) && h\("div", \{ className: "mneme-featsub" \},\s*\n\s*routeSelects\("sleepProvider", "sleepModel", sleepTest, setSleepTest\)/.test(clientSource),
    "the sleep route row must gate on sleepModeEnabled and share the providers source"
  );
  // 2b. 睡眠路由的值必须进初始化草稿：FEATURE_STRINGS 漏键会导致重挂载后
  // 下拉永远显示「跟随默认路由」（后端存了但前端读不回来）。
  assert.ok(
    /const FEATURE_STRINGS = \["dreamProvider", "dreamModel", "sleepProvider", "sleepModel",/.test(clientSource),
    "sleepProvider/sleepModel must be restored into the draft on mount, not only written"
  );
  // 2c. 连通性测试状态按路由各持一份：共享单份会让点一个按钮两个组同时
    // 显示「测试中/结果」且互相禁用。
  assert.ok(
    /const \[dreamTest, setDreamTest\] = useState\(null\);/.test(clientSource)
      && /const \[sleepTest, setSleepTest\] = useState\(null\);/.test(clientSource),
    "the connectivity test state must be per-route, not shared between dream and sleep"
  );
  assert.ok(
    /runModelTest\(curP, curM, setTestState\)/.test(clientSource),
    "each route's test button must target its own test state"
  );
  // 3. 连通性测试：真实最小调用 + 结果展示（成功/失败 + 耗时 + 报错原因）
  assert.ok(
    clientSource.includes('apiFetch("/api/dsh-mneme/test-model", {'),
    "the connectivity test must POST /test-model"
  );
  assert.ok(
    /body: JSON\.stringify\(\{ provider, model \}\)/.test(clientSource),
    "the test payload must carry the selected provider/model (empty = follow default route)"
  );
  assert.ok(
    /typeof j\.durationMs === "number" \? j\.durationMs : Date\.now\(\) - started/.test(clientSource),
    "the result duration must prefer the backend's durationMs and fall back to client timing"
  );
  assert.ok(
    /detail: \[j\.modelId, j\.reply \? "「" \+ j\.reply \+ "」" : ""\]\.filter\(Boolean\)\.join\(" · "\)/.test(clientSource),
    "the success line must surface the model's actual reply (backend caps it at 100 chars)"
  );
  assert.ok(
    /detail: \[j\.modelId, j\.error \|\| "HTTP " \+ res\.status\]\.filter\(Boolean\)\.join\(" · "\)/.test(clientSource),
    "the failure line must carry the tested modelId plus the backend error (502/400 bodies)"
  );
  assert.ok(
    clientSource.includes("memory.features.modelTestOk") && clientSource.includes("memory.features.modelTestFail"),
    "the result line must render success/failure with the localized labels"
  );
  // 4. 下拉改动即提交（与 embedProvider 一致），当前值不在枚举时保留为额外选项
  assert.ok(
    /setStrs\(\(c\) => \(\{ \.\.\.c, \[key\]: v \}\)\);\s*\n\s*put\(\{ \[key\]: v \}\)/.test(clientSource),
    "select changes must commit through the features PUT like the embed provider select"
  );
  assert.ok(
    /curM && !mVals\.includes\(curM\) \? h\("option", \{ key: "current", value: curM \}, curM\) : null/.test(clientSource),
    "a configured value missing from the provider's model list must survive as an extra option"
  );
  // 5. 双语 i18n 与样式
  for (const key of ["routeFollowDefault", "modelTest", "modelTesting", "modelTestOk", "modelTestFail", "sleepModelHint"]) {
    const occurrences = clientSource.split(`"memory.features.${key}"`).length - 1;
    assert.ok(occurrences >= 2, `i18n key memory.features.${key} must exist in both zh and en (got ${occurrences})`);
  }
  assert.ok(
    clientSource.includes(".mneme-routeselect{width:240px;max-width:60%}"),
    "the route selects must share the string-input width budget"
  );
});

// 帮助与反馈入口（v0.8）：设置页底部三个反馈链接——GitHub 新建 issue 预填
// （环境信息）、邮件反馈、浏览已知问题。纯前端链接零后端成本；插件版本从
// /info 拉取（version 只读，不铺任何 token/凭据）。公开链接不得带个人邮箱。
test("settings feedback card: prefilled issue + mailto + browse, version from /info", () => {
  // 1. 版本预填端点
  assert.ok(
    clientSource.includes('apiFetch("/api/dsh-mneme/info")'),
    "the feedback card must fetch the plugin version from /info"
  );
  assert.ok(
    clientSource.includes("setPkgVersion"),
    "the fetched version must land in component state"
  );
  // 2. GitHub 新建 issue：issues/new?title=&body= 预填环境信息（当前仓库无模板）
  assert.ok(
    clientSource.includes("https://github.com/modusensus/dsh-mneme/issues/new?title="),
    "the issue link must prefill title+body on issues/new"
  );
  assert.ok(
    clientSource.includes("**插件版本**") && clientSource.includes("**平台**"),
    "the prefill body must carry plugin version and platform"
  );
  // 3. 邮件反馈：官方邮箱（对外不写个人邮箱），mailto 预填 subject+body
  assert.ok(
    clientSource.includes("mailto:work@modusensus.space?subject="),
    "the mailto link must point at the public support address"
  );
  // 4. 浏览已知问题：跳仓库 issues 列表页（去重前置步骤）
  assert.ok(
    clientSource.includes('href: "https://github.com/modusensus/dsh-mneme/issues"'),
    "the browse link must open the repo issues list"
  );
  // 5. 双语 i18n
  for (const key of ["feedback.title", "feedback.newIssue", "feedback.email", "feedback.browse", "feedback.hint"]) {
    const occurrences = clientSource.split(`"memory.settings.${key}"`).length - 1;
    assert.ok(occurrences >= 2, `i18n key memory.settings.${key} must exist in both zh and en (got ${occurrences})`);
  }
});

// UI 文案必须双语齐全（中英各一条）。用户明确要求所有 UI 文字都做 i18n，
// 这条守卫用「每个键恰好出现两次」兜住：出现奇数次就是漏译，>2 次说明重复。
test("i18n keys are bilingual: every key appears exactly twice (zh + en)", () => {
  const counts = new Map();
  for (const match of clientSource.matchAll(/^\s*"([a-zA-Z0-9_.]+)"\s*:\s*"/gm)) {
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  const odd = [...counts.entries()].filter(([, n]) => n !== 2).map(([key, n]) => `${key}×${n}`);
  assert.deepEqual(odd, [], `这些 i18n 键没有做到中英各一条：${odd.join(", ")}`);
  assert.ok(counts.size > 100, `解析到的键太少（${counts.size}），正则可能没匹配到 i18n 表`);
});

// issue #135：向量状态卡必须区分「没配」与「配了却一条都没嵌上」。此前卡片只看
// ready，而未配置的 legacy embedder（ready 恒 true）一路显示成正常 provider。
test("vector status card surfaces the configured/degraded split", () => {
  // 1. 读后端新字段，缺失（旧服务端）时退化成旧行为而不是误报未配置
  assert.ok(
    clientSource.includes('typeof j?.configured === "boolean" ? j.configured : null'),
    "the card must read `configured` and tolerate older servers that omit it"
  );
  assert.ok(
    clientSource.includes("j?.degraded === true"),
    "the card must read `degraded`"
  );
  // 2. 三态互斥：未配置优先于初始化中，降级只在既非未配置也非初始化时成立
  assert.ok(
    clientSource.includes("const unconfigured = !off && state.configured === false;"),
    "unconfigured must be its own state, not folded into ready"
  );
  assert.ok(
    clientSource.includes("const pending = !off && !unconfigured && state.ready !== true;"),
    "an unconfigured embedder must not be reported as initializing"
  );
  assert.ok(
    clientSource.includes("const degraded = !off && !unconfigured && !pending && state.degraded === true;"),
    "degraded must only apply to a configured, settled embedder"
  );
  // 3. 三个状态各自的标签/说明走 i18n，双语齐备
  for (const key of ["vectorUnconfigured", "vectorUnconfiguredHint", "vectorDegradedHint"]) {
    const occurrences = clientSource.split(`"memory.status.${key}"`).length - 1;
    assert.ok(occurrences >= 2, `i18n key memory.status.${key} must exist in both zh and en (got ${occurrences})`);
  }
  assert.ok(
    clientSource.includes('t("memory.status.vectorUnconfigured")'),
    "the unconfigured state must render its own label"
  );
  assert.ok(
    clientSource.includes('t("memory.status.vectorDegradedHint")'),
    "the degraded state must render its own caption (0 of {m} indexed)"
  );
});