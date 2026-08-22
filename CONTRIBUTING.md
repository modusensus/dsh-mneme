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
    ├── scripts/          # sync-lib.js, e2e-dsh.js, stress-dsh.js, benchmark-*
    ├── test/             # node:test test suite
    ├── docs/             # SEMANTIC / SLEEP / ENTITIES / MIGRATION deep-dives
    ├── package.json      # plugin metadata and scripts
    └── cordis.patch.yml  # DSH injection patch
```

**Key convention: `src/` is the single source of truth; `lib/` is build output.**

- Write code only in `src/`, then run `npm run sync` to mirror changes into `lib/`.
- **Never edit `lib/` by hand** — the next sync overwrites it. The only exception is `lib/client.js` (the Web-panel bundle, authored independently; sync never touches it).
- `npm pack` / `npm publish` run sync automatically via the `prepack` hook, so a published tarball always ships a fresh `lib/`.

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

---

## Testing Conventions

- Tests use Node's built-in **`node:test` + `node:assert/strict`**; no third-party test framework.
- New features require corresponding tests; **changing core logic (e.g. model routing, decision validation) must update the affected test assertions** so the suite stays green before committing.
- Test files live in `test/`, named `*.test.js`; shared mocks go in `test/helpers/` (e.g. `dream-mock.js`).
- Known environment dependency: a few cases in `reranker.test.js` need `@huggingface/transformers` (locally this one case fails without the package; it is unrelated to repo logic and CI installs it and passes).

---

## Code Style & Engineering Conventions

- **ESM**: the repo is `"type": "module"`; everything uses `import`/`export`.
- **Comments in Chinese**, biased toward "why" — core logic, config options, and fail-safe branches must explain their intent.
- **Fail-safe is a hard rule**: local failures in any background LLM path (autoDream / sleep / autoTag / summarization) must skip or degrade, **never** block the main flow (write, recall, injection).
- **Config is defined centrally with schemastery in `src/config.js`** (`z.object` + `.default(...)`); new options must keep docs and default-value semantics in sync.
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
- **Small fixes**: can push straight to `main` (this is the project's workflow).
- **Larger features / breaking changes**: open an Issue first to state the motivation and design, then submit a PR — the PR triggers CI (Node 24 + full suite + Codecov).
- Release operations (version bumps, tags, Releases, npm publish) are performed by maintainers — see the next section.

---

## Release Process (Maintainers)

Versioning follows semantic versioning (`MAJOR.MINOR.PATCH`). Full flow:

1. **Update CHANGELOG**: add a version entry (`## [X.Y.Z] - date`, split into 「修复 / 新增 / 测试」) at the top of `dsh-mneme/CHANGELOG.md`; update the root `CHANGELOG.md` if it tracks the same.
2. **Bump version**: change `version` in `dsh-mneme/package.json` and `package-lock.json`; the root `package.json` is synced automatically by the `prepublishOnly` hook — no manual edit.
3. **Full test pass**: `npm test` must be green.
4. **Commit and push**: commit → `git push origin main` → `git tag vX.Y.Z` → `git push origin vX.Y.Z`.
5. **Create a GitHub Release**: title `vX.Y.Z`, body referencing the matching CHANGELOG entry (review before publishing).
6. **Publish to npm**: run `npm publish` from the **repository root** (`prepublishOnly` copies the version from `dsh-mneme/package.json` into the root `package.json`; `prepack` syncs `lib/`).

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
    ├── scripts/          # sync-lib.js、e2e-dsh.js、stress-dsh.js、benchmark-*
    ├── test/             # node:test 测试
    ├── docs/             # SEMANTIC / SLEEP / ENTITIES / MIGRATION 等专题文档
    ├── package.json      # 插件包元数据与 scripts
    └── cordis.patch.yml  # DSH 注入补丁
```

**关键约定：`src/` 是唯一的事实来源，`lib/` 是构建产物。**

- 所有代码改动只写 `src/`，改完必须运行 `npm run sync` 同步到 `lib/`。
- **不要手工编辑 `lib/`**——下次 sync 会覆盖你的改动。唯一的例外是 `lib/client.js`（Web 面板打包产物，独立创作，sync 不会触碰它）。
- `npm pack` / `npm publish` 会通过 `prepack` 钩子自动执行 sync，所以发布产物永远是新鲜的 `lib/`。

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

---

## 代码风格与工程约定

- **ESM**：仓库 `"type": "module"`，全部使用 `import`/`export`。
- **注释用中文**，且偏向"解释为什么"——核心逻辑、配置项、fail-safe 分支都要求写清意图。
- **fail-safe 是硬性约定**：所有后台 LLM 链路（autoDream / sleep / autoTag / 摘要）中的局部失败只能跳过或降级，**绝不能**阻断主流程（写入、检索、注入）。
- **配置项统一用 schemastery 定义在 `src/config.js`**（`z.object` + `.default(...)`），新增配置记得同步文档与默认值语义。
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
- **小改动 / 修复**：可直推 `main`（本项目采用此工作流）。
- **较大功能 / 破坏性改动**：建议先开 Issue 说明动机与方案，再通过 PR 提交，PR 会触发 CI 校验（node 24 + 全量测试 + Codecov）。
- 发布相关操作（改版本号、打 tag、发 Release、npm publish）由维护者执行，详见下节。

---

## 发布流程（维护者）

版本号遵循语义化版本（`MAJOR.MINOR.PATCH`）。完整流程：

1. **更新 CHANGELOG**：在 `dsh-mneme/CHANGELOG.md` 顶部新增版本条目（`## [X.Y.Z] - 日期`，分「修复 / 新增 / 测试」小节），根目录 `CHANGELOG.md` 如涉及同步更新。
2. **更新版本号**：改 `dsh-mneme/package.json` 的 `version` 与 `package-lock.json`；根目录 `package.json` 由 `prepublishOnly` 钩子自动同步，无需手改。
3. **全量测试**：`npm test` 确认通过。
4. **提交并推送**：commit → `git push origin main` → `git tag vX.Y.Z` → `git push origin vX.Y.Z`。
5. **创建 GitHub Release**：标题为 `vX.Y.Z`，正文引用 CHANGELOG 对应条目（发布前需人工过目）。
6. **发布 npm**：在**仓库根目录**执行 `npm publish`（`prepublishOnly` 会自动把 `dsh-mneme/package.json` 的版本号写入根 `package.json`，`prepack` 自动 sync `lib/`）。

---

## 其他

- 安全问题请走 [SECURITY.md](SECURITY.md) 或 GitHub Security Advisory，不要在公开 Issue 贴敏感信息。
- 保持礼貌与建设性；涉及数据损坏 / 安全 / 破坏性改动的 PR 需附复现步骤与回归证据。
