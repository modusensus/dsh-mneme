# dsh-mneme 本地模型部署指南

- **日期**：2026-08-15
- **范围**：为 dsh-mneme 配置完全离线的本地语义模型（Embedding + Rerank），覆盖 ONNX（transformers.js）与 Ollama 两种路径

## 1. 前置要求

| 项目 | 要求 | 说明 |
|------|------|------|
| Node.js | ≥ 22.5（建议 24+） | 插件依赖 `node:sqlite`（22.5 起可用，24 稳定） |
| 磁盘空间 | ≥ 300MB（推荐 1GB+） | bge-small-zh-v1.5 量化约 100MB，bge-reranker-base 约 250MB；Ollama 模型另计 |
| 内存 | ≥ 1GB 可用 | 纯 CPU 推理亦可运行 |
| GPU（可选） | 显存 ≥ 2GB | 开启 `localEmbedDevice: "gpu"`（onnxruntime 需要额外安装 cuda 后端） |
| 网络 | 仅首次下载模型需要 | 已下载后可完全离线（默认走 Hugging Face，可换镜像源） |

> 依赖解析分三层：① **插件自管运行时目录**（`~/.dsh/mneme/runtime/`，见 §2.5，优先）；② 宿主 profile 里已装的 `@huggingface/transformers`；③ 都没有则本地推理不可用，检索自动降级为关键词/BM25（读写在任何情况下都不受影响）。
>
> 从本版起 `@huggingface/transformers` 已从 `dependencies` 降为**可选 peer**（`peerDependenciesMeta.optional`），安装插件时不会再带上它和它那套原生闭包；第 ② 层因此只对「自己装过这份依赖」或「从旧版本升级上来、尚未被 prune」的环境有效。**正在使用本地嵌入的用户请在升级前按 §2.5 收编一份**，否则升级后本地嵌入不可用（读写信道不受影响）。
>
> `onnxruntime-node` 作为可选原生后端列在 `allowScripts`（首次安装需确认脚本），无需手动额外安装。

## 2. 模型安装 / 下载

### 2.1 自动下载（默认，推荐）

首次使用本地 Embedder 时会**自动从 Hugging Face Hub 下载**对应模型到本地缓存，无需手动操作：

```bash
node scripts/benchmark-embed.js --provider local --model Xenova/bge-small-zh-v1.5
# 首次运行会显示下载进度 → 加载模型 → 输出基准表格
```

默认缓存目录：`~/.dsh/mneme/models`（用户级，重装/升级依赖不丢；`embedModelCacheDir` 留空时启用）。transformers.js 把模型存成 `<cacheDir>/<org>/<name>/`（实测 4.2.0，例如 `~/.dsh/mneme/models/Xenova/bge-small-zh-v1.5/`）：

- Linux/macOS：`~/.dsh/mneme/models/`
- Windows：`%USERPROFILE%\.dsh\mneme\models\`

> 实测 transformers.js 4.2.0 在离线加载（`allowRemoteModels=false`）时按 `<cacheDir>/<org>/<model>/` 解析模型文件，例如 `<cacheDir>/Xenova/bge-small-zh-v1.5/config.json`。与本段上面描述的 `hub/models--…` 布局不一致时，以实际报错里给出的路径为准；缓存不在默认位置时按 §2.5 用 `--cache-dir` 指过去。

### 2.2 手动指定缓存目录

内存受限/离线机器可把模型缓存放到指定位置（迁移、共享缓存）：

```js
// 配置示例（插件配置里设置 embedModelCacheDir）
const embedder = createEmbedderByProvider("local", {
  cacheDir: "/data/hf-models",   // 模型缓存目录
  model: "Xenova/bge-small-zh-v1.5"
});
```

### 2.3 Ollama 路径

如果本机已有 Ollama：

```bash
ollama pull nomic-embed-text   # 或 bge-m3（多语言）
```

Ollama Embedder 走 `/api/embeddings`，**不下载任何文件到插件缓存**，模型由 Ollama 管理。

### 2.4 断点续传

下载基于 Hugging Face Hub 缓存协议，**中断后重试自动续传**（按分片断点续传，不重新下载已完成部分）。若反复中断导致缓存损坏，删除对应模型的缓存目录后重跑即可：

```bash
rm -rf ~/.dsh/mneme/models/hub/models--Xenova--bge-small-zh-v1.5
```

### 2.5 自管运行时（收编 / 校验 / 排查）

本地推理真正要用的是一整套依赖闭包：`@huggingface/transformers` + `onnxruntime-node` + `sharp`（本机实测从宿主 node_modules 收编时是 **49 个包、3203 个文件、约 393MB**）。插件支持把它收编到自管目录 `~/.dsh/mneme/runtime/`，与宿主 profile 的依赖图解耦；收编**优先使用硬链接**，同盘时几乎不额外占盘。

**为什么要独立出来**：这份闭包此前留在插件 `dependencies` 里，而 profile 是所有插件共用的依赖图，于是「装任何插件」都要替它重走一遍整条链，弱网下极慢。摘掉该声明后，运行时由自管目录承接——所以要**先收编、再升级**，否则升级后本地嵌入不可用。

**三条取件来源，按可用性依次尝试**（面板按钮、`memory_runtime` 工具、CLI 三者共用同一套编排）：

| 顺序 | 来源 | 特点 |
|---|---|---|
| ① | 收编本机 profile 的 `node_modules` | **零网络**；同盘硬链接，几乎不占额外空间 |
| ② | `runtimeTarballDir` 指向的本地 `.tgz` 目录 | 某个包网络下不到时用（文件名按 npm 约定 `<basename>-<version>.tgz`） |
| ③ | npm registry（`runtimeMirror` 可换镜像） | 按随包发布的 `runtime-manifest.json` 逐个取，**每个 tarball 先校验 sha512 再落盘** |

走 ③ 时体积是 **win32-x64 实测约 33 个包、2142 个文件、数百 MB**（各平台不同，故不写死数值）——比①少，因为清单剔除了 `onnxruntime-web`（127.7MB，占全量三分之一）：transformers 的 Node 构建从不 import 它（把一个空的 `onnxruntime-web` 打桩进去，嵌入结果逐字节相同），风险由 `verify` 的真实推理兜底。清单本身**平台无关**（数据源是 `package-lock.json` 里所有平台的条目），下载时按各包的 `os`/`cpu` 过滤，所以 win32 / darwin / linux × x64 / arm64 都被覆盖 —— 不需要谁在某个系统上先跑一次生成脚本。

```bash
# 在插件目录下运行（例如 node_modules/@modusensus/dsh-mneme）

# 1) 看状态：在哪、来源、结构完不完整（不加载模型，秒回）
node scripts/mneme-runtime.mjs status

# 2) 收编宿主里已有的那份（只读源、只写自管目录，不安装任何东西）
node scripts/mneme-runtime.mjs adopt --from ~/.dsh/profiles/<profile>/node_modules

# 3) 真加载运行时并跑一次推理，确认可用
node scripts/mneme-runtime.mjs verify --cache-dir ~/.dsh/mneme/models
```

- 退出码：`0` 健康 / `1` 不健康或失败 / `2` 用法错误（便于脚本直接 gate，区分「没装」和「装坏了」看输出里的 `status`）。加 `--json` 得到机器可读结果。
- `verify` 的功能验证**不触网**（`allowRemoteModels=false`）：模型必须已在缓存目录里，否则会明确失败——这是有意的，验证不该偷偷触网。缓存不在默认位置时用 `--cache-dir` 指到与 `embedModelCacheDir` 一致的位置。
- 收编来的目录没有可比对的原始产物，完整性如实标 `unverified`，不假装验过；结构检查通过 ≠ 功能可用，两者分开报。
- `status` 只做结构检查，所以 `functional` 恒为 `unknown`——要看真实推理结果就跑 `verify`。
- 运行时不可用时插件不会崩：检索降级为关键词/BM25，读写在任何情况下都不受影响；错误信息会带上 `adopt` 的具体命令。
- 同一份状态也能从 `GET /api/dsh-mneme/semantic` 的 `localRuntime` 字段读到（面板与 CLI 同源）。

#### 不用命令行也可以

- **面板**：记忆面板的「向量索引」卡片在本地 provider 且运行时不就绪时，会显示**代价说明**（要额外一份运行时、解包后数百 MB）、先试收编、没有再下载，并按实际走的那一档分开报结果。卡片下面还有一个「取回本地运行时」按钮，点一下即完成。
- **让 agent 代做**：`memory_runtime` 工具提供三个动作——`status`（只读，**返回里带代价说明**，便于 agent 先告知你再动手）、`provision`（走上面三档来源）、`verify`（真跑一次推理）。所以即便你不看面板，也可以直接让 agent 处理。
- **这条路由与其它写路由走同一道门**：`POST /api/dsh-mneme/runtime/provision` 是唯一会联网拉数百 MB 并写盘的写面，鉴权规则与其他写路由完全一致——配了 `apiToken` 就必须带 token，**没配就等于不校验**（这是插件既有的鉴权模型，不是这条路由特有的）。本机默认部署下它开箱可用；但若这个端口能被别的页面/机器够到，请照第 3.1 节配上 `apiToken`。面板按钮与 `memory_runtime` 都走这道门，不需要额外配置。
- **平台过滤的取向是「宽松优先」**：清单是平台无关的一份（含所有平台的包），下载时按本机 `os`/`cpu` 过滤；Linux 上如果**确认**了本机是 glibc，还会剔掉另一套 libc 的变体（`sharp` 与 `libvips` 的 musl 包，十几 MB）。拿不到 libc 证据时一律不过滤——多下十几兆，好过赌错方向装出一份跑不起来的运行时。
- **宿主那份 transformers 会被版本门禁**：第 ② 层（宿主裸 specifier）只接受 `>=4.2.0` 且 `<5` 的版本；宿主装到 v5 时不会被静默使用，而是明确报出「版本越界」并退到第 ③ 层的可操作提示。版本读不到（某些打包形态）时不拦，以免这层对老用户整体失效。

```yaml
# 两个可选配置键（默认留空 = 不改变任何行为）
runtimeTarballDir: ""   # 本地 .tgz 目录：有它就优先于联网
runtimeMirror: ""       # registry 镜像前缀，例如 https://npmmirror.com/mirrors/npm/
```

#### 升级前必做（否则本地嵌入会断）

如果你正在使用本地嵌入（`embedProvider: local`），**在升级到已摘掉 `dependencies` 声明的版本之前**先执行一次 `adopt` + `verify`。顺序不能反：升级时 pnpm 会 prune 掉宿主里那份依赖，那之后就没有可收编的源了，只剩联网下载一条路。

#### 自己取一份来收编（相对上面的手动路径）

上面的面板按钮 / `provision` 已经能在没有可收编副本时自行下载。但如果你希望**完全掌控取件过程**（例如用自己的镜像、或先在一处统一缓存），仍然可以手工取一份再收编——不必逐个下载包：

```bash
# Windows（PowerShell / cmd）
mkdir %TEMP%\mneme-fetch && cd /d %TEMP%\mneme-fetch
npm i @huggingface/transformers@^4.2.0
node "<插件目录>\scripts\mneme-runtime.mjs" adopt --from "%TEMP%\mneme-fetch\node_modules"

# Linux / macOS
mkdir -p /tmp/mneme-fetch && cd /tmp/mneme-fetch
npm i @huggingface/transformers@^4.2.0
node "<插件目录>/scripts/mneme-runtime.mjs" adopt --from /tmp/mneme-fetch/node_modules
```

- **安装脚本必须能执行**：npm 默认会执行生命周期脚本，而 `onnxruntime-node` / `sharp` 正是靠 postinstall 取原生二进制；加 `--ignore-scripts` 会得到一个装不起来的闭包。pnpm 10+ 默认拦截构建脚本，所以这里用 npm 更省事。
- 收编完那个临时目录可以直接删掉：闭包已经在 `~/.dsh/mneme/runtime/` 里了（硬链接时几乎不额外占盘）。
- 收编后**仍然建议跑一次 `verify`**——结构完整不等于能推理。

## 3. 配置

### 3.1 插件配置（`~/.dsh/profiles/web/cordis.patch.yml`）

```yaml
- id: dsh-mneme
  name: '@modusensus/dsh-mneme'
  config:
    # ── Embedding ──────────────────────────────
    embedProvider: local        # local | ollama | openai（默认 openai，保持 v0.1 行为）
    localEmbedModel: Xenova/bge-small-zh-v1.5
    localEmbedDimension: 512    # 与模型匹配的向量维度
    localEmbedDevice: cpu       # cpu | gpu（仅 local 生效）
    localEmbedBatchSize: 8      # 分批嵌入条数，内存紧张调小
    embedModelCacheDir: ""      # 模型缓存目录（空=用户级 ~/.dsh/mneme/models；注意：不做 ~ 展开，要指别处必须写绝对路径）
    ollamaBaseUrl: "http://localhost:11434"   # 仅 ollama 生效
    ollamaModel: "nomic-embed-text"           # 仅 ollama 生效（openai 端点走面板 vector-config）
    # ── Rerank（Phase 2，可选）─────────────────
    rerankEnabled: false        # 开启向量召回后的精排
    rerankModel: Xenova/bge-reranker-base
```

### 3.2 环境变量（可选）

| 变量 | 作用 |
|------|------|
| `HF_ENDPOINT` | Hugging Face 镜像源，例如 `https://hf-mirror.com`（国内加速） |
| `HF_HUB_CACHE` | 覆盖默认缓存目录 |

### 3.3 各后端配置对照

| 配置 | local (ONNX) | ollama | openai |
|------|--------------|--------|--------|
| `localEmbedModel` | HF 模型 id（如 `Xenova/bge-small-zh-v1.5`） | —（用 `ollamaModel`） | —（用面板 vector-config） |
| `ollamaBaseUrl` | — | `http://localhost:11434`（默认） | — |
| `ollamaModel` | — | Ollama 模型名（如 `nomic-embed-text`） | — |
| `localEmbedDevice` | ✅ | — | — |
| `localEmbedBatchSize` | ✅ | — | — |
| `embedModelCacheDir` | ✅ | — | — |

## 4. 首次使用

1. 配置 `embedProvider`（或保持 `openai` 不动）
2. 保存配置并重启 DSH，或直接跑 `scripts/benchmark-embed.js` 验证
3. 首次触发本地模型时，transformers.js 自动下载 → `init()` 打印 `local embedder ready: <model> (dim=512, device=cpu)`
4. 之后所有 `memory_save` 写入自动补向量；已有记忆可用「重建索引」批量补建

> 注意：切换 `localEmbedModel` 或 `embedDimension` 后，旧向量与新向量维度不同、无法混算，需**重建索引**（复用 v0.1 的 `reindexMissing` 机制）。

## 5. 常见问题

### Q1：模型下载失败 / 下载超慢

- 国内网络：设置镜像源 `HF_ENDPOINT=https://hf-mirror.com`（或 `export HF_ENDPOINT=https://hf-mirror.com`）
- 公司代理拦截：检查 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量
- 磁盘不足：清理缓存或用 `embedModelCacheDir` 换目录

### Q2：`Xenova/bge-small-zh-v1.5` 加载报错 / 显存不足（OOM）

- 默认 `device: cpu`、`dtype: q8`，内存占用已最小化
- 尝试 `embedBatchSize` 调小（如 4/2）降低峰值内存
- 显存不足：`device: gpu` 时改回 `cpu`；或检查 onnxruntime-node 是否安装了 GPU 后端

### Q3：中英文混排 / CJK 文本处理

- `bge-small-zh-v1.5` 对中文与中英混排均优化良好；纯英文场景可换 Ollama 的 `nomic-embed-text`
- 单条文本上限 8000 字符（与 v0.1 一致），超长自动截断
- 检索时 query 与记忆正文走同一 Embedder、同一归一化（mean pooling + L2），余弦分数才可比

### Q4：换模型后结果变差 / 向量混乱

- 换模型（尤其维度不同）后旧向量不可复用，必须重建索引
- 若在 Web 面板/API 配置过 v0.1 的 `vector-config`，v0.2 会优先采用插件配置，旧配置仅作降级路径

### Q5：本地模型加载很慢（首次/每次启动）

- 首次含下载，属正常；已缓存后每次启动仅加载进内存（数百 ms 级）
- 大模型（如 bge-m3）可考虑换用更小的 `Xenova/bge-small-zh-v1.5`（量化 q8 约 100MB）
