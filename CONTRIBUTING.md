# Contributing

> **English** | [中文](#贡献指南)

---

## Prerequisites

- **Node.js 24+** (CI runs on Node 24)
- **npm** (the repo uses npm; CI installs with `npm ci`)
- **git** (on Windows, watch LF/CRLF: the repo is LF-normalized and git converts automatically)

---

## Repository Layout

The repository root is the publishing manifest; the actual plugin code lives in the `dsh-mneme/` subdirectory:

```
dsh-mneme-1/
├── package.json          # npm publishing manifest (main → dsh-mneme/lib/index.js)
├── README.md / CHANGELOG.md / SECURITY.md
└── dsh-mneme/            # the plugin itself
    ├── src/              # source (ESM) — all feature work happens here
    ├── lib/              # build output; DSH actually loads lib/index.js
    ├── scripts/          # sync-lib.js, check-sync.js, e2e-dsh.js, stress-dsh.js, benchmark-*
    ├── test/             # node:test test suite
    ├── docs/             # SEMANTIC / SLEEP / ENTITIES / MIGRATION deep-dives
    ├── package.json      # plugin metadata and scripts
    └── cordis.patch.yml  # DSH injection patch
```

**Key convention: `src/` is the single source of truth; `lib/` is build output.**

- Write code only in `src/`, then run `npm run sync` to mirror changes into `lib/`.
- **Never edit `lib/` by hand** — the next sync overwrites it.
- Publish from the **repo root**: root `prepack` runs `scripts/check-sync.js`, which asserts `src/` ↔ `lib/` match file-for-file and fails the publish on any drift (issue #65). So run `npm run sync` (in `dsh-mneme/`) and commit the `lib/` changes **before** publishing.

---

## Local Development

```bash
# 1. Install dependencies (inside dsh-mneme/)
cd dsh-mneme
npm ci

# 2. After editing files under src/, mirror to lib/
npm run sync

# 3. Run the tests
npm test              # node --test test/*.test.js
npm run test:coverage # c8 coverage
```

Common scripts (all run under `dsh-mneme/`):

| Command | Description |
|---------|-------------|
| `npm test` | Full unit/integration suite |
| `npm run test:coverage` | Tests + c8 coverage (used by CI) |
| `npm run e2e` | End-to-end smoke test (scripts/e2e-dsh.js) |
| `npm run stress` | Three-axis stress test (scripts/stress-dsh.js) |
| `npm run sync` | src/ → lib/ mirror |
| `node bin/cli.mjs --help` | CLI smoke check (zero-dep external API client, v0.7.12+) |

---

## Testing Conventions

- Tests use Node's built-in **`node:test` + `node:assert/strict`**; no third-party test framework.
- New features require corresponding tests; **changing core logic (e.g. model routing, decision validation) must update the affected test assertions** so the suite stays green before committing.
- Test files live in `test/`, named `*.test.js`; shared mocks go in `test/helpers/` (e.g. `dream-mock.js`).
- Known environment dependency: a few cases in `reranker.test.js` need `@huggingface/transformers` (locally this one case fails without the package; it is unrelated to repo logic and CI installs it and passes).
- The published artifact is covered too: `test/lib-smoke.test.js` imports from `lib/` and asserts `src/` ↔ `lib/` are file-for-file identical (issue #65 regression guard).

---

## Code Style & Engineering Conventions

- **ESM**: the repo is `"type": "module"`; everything uses `import`/`export`.
- **Comments in Chinese**, biased toward "why" — core logic, config options, and fail-safe branches must explain their intent.
- **Fail-safe is a hard rule**: local failures in any background LLM path (autoDream / sleep / autoTag / summarization) must skip or degrade, **never** block the main flow (write, recall, injection).
- **Config is defined centrally with schemastery in `src/config.js`** (`z.object` + `.default(...)`); new options must keep docs and default-value semantics in sync.
- **Feature flags are a trio — land all three or none**: a new switch must appear in the `src/config.js` schema, the `src/settings.js` whitelists (`FEATURE_FLAG_BOOLEANS` / int ranges / enums), and — if panel-visible — the `lib/client.js` `FEATURE_GROUPS` with bilingual i18n keys. The panel reads `/features` effective values; a missed whitelist entry silently hides the switch, and `/features` count assertions live in `test/api.test.js`.
- **Client strings are bilingual**: every user-facing i18n key must exist in both the zh and en dictionaries of `lib/client.js` (`test/client.test.js` enforces occurrences ≥ 2).
- **JSDoc on newly added functions**: the review bot warns when docstring coverage on touched functions drops below 80% — a short `/** */` block per new function keeps reviews on substance.
- **Audit honesty**: a run's status (ok / noop / degraded / reconcile / failed) must reflect what actually committed — never a fake ok.

---

## Commits & Branches

- Commit messages follow **Conventional Commits**:

  ```
  fix(dream): reject cross-type merge as a whole batch (Issue #26)
  feat(tag): add tag-weighted recall
  docs: expand the SEMANTIC doc
  release: v0.6.9 ...
  ```

- Run `npm test` before committing and confirm green (note any environment-only known exceptions in the commit message).
- **All changes land through PRs** — feature branches off the latest `main`, then a PR that triggers CI (CodeQL ×2 + Node 22/24 × windows/ubuntu matrix + Codecov) and maintainer review before squash merge.
- **One feature, one branch**, named by scope: `feat/<area>-<topic>`, `fix/<topic>`, `docs/<topic>` (e.g. `feat/scope-storage-a1`, `fix/restart-interval-persist`). Small fixes also go through PRs — they are cheap to review and trivially revertible.
- **Stacked PRs are welcome** when features build on each other (`feat/scope-panel-a4` on top of `feat/scope-strict-a3`, etc.). After the base PR is squash-merged, rebase your branch onto `main` — git auto-skips the already-applied patches, so the conflict resolves itself.
- **Larger features / breaking changes**: open an Issue first to state the motivation and design, then submit the PR.
- Release operations (version bumps, tags, Releases, npm publish) are performed by maintainers — see the next section.

---

## Scope: Platform Adaptation & Wrapper PRs

DSH upstream is still in developer preview — APIs and service interfaces change frequently. Until DSH reaches a stable release (RC or GA), **PRs that adapt dsh-mneme to secondary platforms or wrap it into other hosts are not a priority** and are reviewed with extra caution:

- Desktop shells (e.g. a Tauri/Electron wrapper around `dsh web`)
- Standalone CLI packaging
- Ports/wrappers of dsh-mneme into other plugin ecosystems

These tend to bind against unstable upstream APIs: a single upstream change can break them, and the maintenance burden falls back on this project. The currently supported platform is the **Web Profile** (`dsh web`).

Exceptions: if a contributor is willing to **own long-term maintenance** (track upstream changes and fix breakage), open a Discussion first to scope the work — maintainers will evaluate and review the PR.

Bug-fix PRs for existing desktop compatibility issues are still welcome.

---

## Release Process (Maintainers)

Versioning follows semantic versioning (`MAJOR.MINOR.PATCH`). Full flow:

1. **Update CHANGELOG**: add a version entry (`## [X.Y.Z] - date`, split into 「修复 / 新增 / 测试」) at the top of `dsh-mneme/CHANGELOG.md`; update the root `CHANGELOG.md` if it tracks the same.
2. **Bump version**: change `version` in `dsh-mneme/package.json` and `package-lock.json`; the root `package.json` is synced automatically by the `prepublishOnly` hook — no manual edit.
3. **Full test pass**: `npm test` must be green.
4. **Commit and push**: commit → `git push origin main` → `git tag vX.Y.Z` → `git push origin vX.Y.Z`.
5. **Create a GitHub Release**: title `vX.Y.Z`, body referencing the matching CHANGELOG entry (review before publishing).
6. **Publish to npm**: run `npm publish` from the **repository root** (`prepublishOnly` copies the version from `dsh-mneme/package.json` into the root `package.json`; `prepack` runs `scripts/check-sync.js` and fails if `src/` ↔ `lib/` drifted — ensure `npm run sync` + commit ran first).

---

## External API & CLI (v0.7.12+)

The standalone external API (`src/api-standalone.js`) and the `bin/cli.mjs` client let other plugins and desktop tools read/write memories over loopback HTTP. When touching them:

- Keep the route surface read/write on memories only; new routes need tests in `test/standalone-api.test.js` (they spin the real server on port 0).
- Auth additions/changes must keep `timingSafeEqual` token comparison and the `GET /health` exception.
- The CLI is dependency-free by contract - do not add imports to `bin/cli.mjs`.

## Code of Conduct

This project adopts the spirit of the [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) — the short version for a memory-plugin codebase:

- **Argue about the code, not the person.** Review comments, issue replies, and design debates address behavior of the software, never the author.
- **Respect differing setups.** Reporters run different models, providers, locales, and platforms — a bug that doesn't reproduce on your machine is still a bug.
- **Zero tolerance** for harassment, doxxing, or spam (including AI-generated issue noise — see [Issue Reporting Requirements](#issue-reporting-requirements)): maintainers will close and, if repeated, block.
- Maintainers hold themselves to the same standard; concerns about maintainer conduct go to `work@modusensus.space` privately.

---

## Contact

- **General questions & contributions**: [GitHub Discussions](https://github.com/modusensus/dsh-mneme/discussions) or `work@modusensus.space`
- **Security vulnerabilities**: report privately via [SECURITY.md](SECURITY.md) — never open a public issue for vulnerabilities

---

## Miscellaneous

- Security issues go through [SECURITY.md](SECURITY.md) or a GitHub Security Advisory — never paste sensitive info into a public Issue.
- Be respectful and constructive; PRs touching data integrity, security, or behavior must include reproduction steps and regression evidence.

---

# 贡献指南

> **中文** | [English](#contributing)

---

## 环境要求

- **Node.js 24+**（CI 在 node 24 上运行）
- **npm**（仓库使用 npm，CI 用 `npm ci`）
- **git**（Windows 下注意 LF/CRLF：仓库以 LF 为准，git 会自动转换）

---

## 代码库布局

仓库根目录是发布清单，实际插件代码在 `dsh-mneme/` 子目录：

```
dsh-mneme-1/
├── package.json          # npm 包发布清单（main 指向 dsh-mneme/lib/index.js）
├── README.md / CHANGELOG.md / SECURITY.md
└── dsh-mneme/            # 插件本体
    ├── src/              # 源码（ESM），所有功能都在这里开发
    ├── lib/              # 构建产物，DSH 实际加载的是 lib/index.js
    ├── scripts/          # sync-lib.js、check-sync.js、e2e-dsh.js、stress-dsh.js、benchmark-*
    ├── test/             # node:test 测试
    ├── docs/             # SEMANTIC / SLEEP / ENTITIES / MIGRATION 等专题文档
    ├── package.json      # 插件包元数据与 scripts
    └── cordis.patch.yml  # DSH 注入补丁
```

**关键约定：`src/` 是唯一的事实来源，`lib/` 是构建产物。**

- 所有代码改动只写 `src/`，改完必须运行 `npm run sync` 同步到 `lib/`。
- **不要手工编辑 `lib/`**——下次 sync 会覆盖你的改动。
- 发布在**仓库根**执行：root `prepack` 会跑 `scripts/check-sync.js`，逐文件断言 `src/` ↔ `lib/` 一致，有漂移直接发布失败（issue #65 教训）。所以发布前务必先在 `dsh-mneme/` 里跑 `npm run sync` 并把 `lib/` 改动一起提交。

---

## 本地开发

```bash
# 1. 安装依赖（在 dsh-mneme/ 目录内）
cd dsh-mneme
npm ci

# 2. 修改 src/ 下的文件后，同步到 lib/
npm run sync

# 3. 跑测试
npm test              # node --test test/*.test.js
npm run test:coverage # c8 覆盖率
```

常用脚本（均在 `dsh-mneme/` 下）：

| 命令 | 说明 |
|------|------|
| `npm test` | 全量单元/集成测试 |
| `npm run test:coverage` | 测试 + c8 覆盖率（CI 使用） |
| `npm run e2e` | 端到端冒烟（scripts/e2e-dsh.js） |
| `npm run stress` | 三轴线压测（scripts/stress-dsh.js） |
| `npm run sync` | src/ → lib/ 同步 |

---

## 测试约定

- 测试框架为 Node 内置 **`node:test` + `node:assert/strict`**，不引入第三方测试库。
- 新增功能必须有对应测试；**修改核心逻辑（如模型路由、决策校验）时必须同步更新受影响用例的断言**，保证全量测试通过后提交。
- 测试文件放在 `test/`，命名 `*.test.js`；共享 mock 放 `test/helpers/`（如 `dream-mock.js`）。
- 已知环境依赖：`reranker.test.js` 的个别用例需要 `@huggingface/transformers`（本地未安装该包时这 1 例会失败，与本仓库逻辑无关，CI 会正常安装并通过）。
- 发布产物也被覆盖：`test/lib-smoke.test.js` 从 `lib/` 直接导入复跑关键用例，并断言 src↔lib 逐文件一致（issue #65 防再犯）。

---

## 代码风格与工程约定

- **ESM**：仓库 `"type": "module"`，全部使用 `import`/`export`。
- **注释用中文**，且偏向"解释为什么"——核心逻辑、配置项、fail-safe 分支都要求写清意图。
- **fail-safe 是硬性约定**：所有后台 LLM 链路（autoDream / sleep / autoTag / 摘要）中的局部失败只能跳过或降级，**绝不能**阻断主流程（写入、检索、注入）。
- **配置项统一用 schemastery 定义在 `src/config.js`**（`z.object` + `.default(...)`），新增配置记得同步文档与默认值语义。
- **功能开关是三件套——缺一不可**：新开关必须同时落在 `src/config.js` schema、`src/settings.js` 白名单（`FEATURE_FLAG_BOOLEANS` / 整数区间 / 枚举），面板可见的还要加 `lib/client.js` 的 `FEATURE_GROUPS` + 双语 i18n 键。面板读 `/features` 的 effective 值；漏掉白名单项开关会静默消失，`/features` 数量断言在 `test/api.test.js`。
- **面板文案必须双语**：每个用户可见的 i18n 键都要在 `lib/client.js` 的中英两份字典里同时存在（`test/client.test.js` 强制 occurrences ≥ 2）。
- **新增函数写 JSDoc**：review 机器人对改动函数的 docstring 覆盖率低于 80% 会告警——每个新函数一段简短 `/** */` 可让评审聚焦实质。
- **审计诚实性**：任何 run 的状态（ok / noop / degraded / reconcile / failed）必须反映真实提交结果，绝不虚报。

---

## 提交与分支

- 提交信息遵循 **Conventional Commits**：

  ```
  fix(dream): 修复跨类型 merge 整单拒绝（Issue #26）
  feat(tag): 新增标签加权召回
  docs: 补充 SEMANTIC 文档
  release: v0.6.9 ...
  ```

- 提交前跑一遍 `npm test` 确认全绿（环境相关的已知例外需在提交说明里注明）。
- **所有改动一律走 PR**——从最新 `main` 切功能分支，提交 PR 触发 CI（CodeQL ×2 + Node 22/24 × win/ubuntu 矩阵 + Codecov），经维护者 review 后 squash 合并。
- **一个功能一个分支**，按范围命名：`feat/<领域>-<主题>`、`fix/<主题>`、`docs/<主题>`（如 `feat/scope-storage-a1`、`fix/restart-interval-persist`）。小修也走 PR——review 成本低、回滚干净。
- **允许 stacked PR**：功能相互依赖时叠加（如 `feat/scope-panel-a4` 叠在 `feat/scope-strict-a3` 上）。底 PR 被 squash 合并后把分支 rebase 到 `main` 即可——git 会自动跳过已应用的补丁，冲突自行消解。
- **较大功能 / 破坏性改动**：建议先开 Issue 说明动机与方案，再提交 PR。
- 发布相关操作（改版本号、打 tag、发 Release、npm publish）由维护者执行，详见下节。

---

## 范围：平台适配与封装 PR

DSH 上游仍处于 developer preview 阶段，API 与服务接口变动频繁。在 DSH 稳定（RC 或正式版）之前，以下方向的 PR **不作为优先项**，且会以额外谨慎的态度审查：

- 桌面端适配（例如基于 `dsh web` 的 Tauri/Electron 桌面壳）
- 独立 CLI 封装
- 把 dsh-mneme 移植/封装到其他插件体系

这类 PR 往往绑定不稳定的上游接口——上游一次变动就可能使其失效，而维护责任会落到本项目头上。当前唯一受支持的平台是 **Web Profile**（`dsh web`）。

例外：如果贡献者愿意**承担长期维护**（跟进上游变更并修复 break），请先开 Discussion 沟通范围，维护者会评估并 review 该 PR。

针对现有 desktop 兼容问题的 **bug 修复 PR 依然欢迎**。

---

## 发布流程（维护者）

版本号遵循语义化版本（`MAJOR.MINOR.PATCH`）。完整流程：

1. **更新 CHANGELOG**：在 `dsh-mneme/CHANGELOG.md` 顶部新增版本条目（`## [X.Y.Z] - 日期`，分「修复 / 新增 / 测试」小节），根目录 `CHANGELOG.md` 如涉及同步更新。
2. **更新版本号**：改 `dsh-mneme/package.json` 的 `version` 与 `package-lock.json`；根目录 `package.json` 由 `prepublishOnly` 钩子自动同步，无需手改。
3. **全量测试**：`npm test` 确认通过。
4. **提交并推送**：commit → `git push origin main` → `git tag vX.Y.Z` → `git push origin vX.Y.Z`。
5. **创建 GitHub Release**：标题为 `vX.Y.Z`，正文引用 CHANGELOG 对应条目（发布前需人工过目）。
6. **发布 npm**：在**仓库根目录**执行 `npm publish`（`prepublishOnly` 会自动把 `dsh-mneme/package.json` 的版本号写入根 `package.json`，`prepack` 会跑 `scripts/check-sync.js` 校验 src↔lib 一致性，漂移则发布失败——发布前须先 `npm run sync` 并提交 `lib/` 改动）。

---

## 行为准则

本项目遵循 [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) 的精神——对一个记忆插件仓库来说，简版就是这几条：

- **对代码争论，不对人争论。**Review 意见、issue 回复、方案讨论针对的是软件的行为，不是作者本人。
- **尊重不同的环境。**报告者用的模型、服务商、语言、平台各不相同——在你机器上复现不了的 bug 依然是 bug。
- **对骚扰、人肉与垃圾信息（包括 AI 生成的无效 issue 噪声）零容忍**：维护者会关闭，反复出现则拉黑（细则见 [Issue 报告要求](#issue-报告要求)）。
- 维护者同样受此约束；对维护者行为的反馈请私下发 `work@modusensus.space`。

---

## 联系方式

- **一般问题与贡献咨询**：[GitHub Discussions](https://github.com/modusensus/dsh-mneme/discussions) 或 `work@modusensus.space`
- **安全漏洞**：请通过 [SECURITY.md](SECURITY.md) 私有提交，不要在公开 Issue 中提交漏洞

---

## 其他

- 安全问题请走 [SECURITY.md](SECURITY.md) 或 GitHub Security Advisory，不要在公开 Issue 贴敏感信息。
- 保持礼貌与建设性；涉及数据损坏 / 安全 / 破坏性改动的 PR 需附复现步骤与回归证据。
