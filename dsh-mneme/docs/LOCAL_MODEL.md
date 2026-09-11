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
> 目前插件仍把 `@huggingface/transformers` 声明在 `dependencies`，所以第 ② 层恒可用；后续版本会摘掉该声明、改由自管运行时承接。**建议提前按 §2.5 收编一份**，否则升级后本地嵌入会不可用。
>
> `onnxruntime-node` 作为可选原生后端列在 `allowScripts`（首次安装需确认脚本），无需手动额外安装。

## 2. 模型安装 / 下载

### 2.1 自动下载（默认，推荐）

首次使用本地 Embedder 时会**自动从 Hugging Face Hub 下载**对应模型到本地缓存，无需手动操作：

```bash
node scripts/benchmark-embed.js --provider local --model Xenova/bge-small-zh-v1.5
# 首次运行会显示下载进度 → 加载模型 → 输出基准表格
```

默认缓存目录：`~/.dsh/mneme/models`（用户级，重装/升级依赖不丢；`embedModelCacheDir` 留空时启用）。transformers.js 的 hub 模型存于其下 `hub/models--<org>--<name>`：

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

本地推理真正要用的是一整套依赖闭包：`@huggingface/transformers` + `onnxruntime-node` + `sharp`（本机实测 49 个包、3203 个文件、约 393MB）。插件支持把它收编到自管目录 `~/.dsh/mneme/runtime/`，与宿主 profile 的依赖图解耦；收编**优先使用硬链接**，同盘时几乎不额外占盘。

**为什么值得提前做**：这份闭包此前留在插件 `dependencies` 里，而 profile 是所有插件共用的依赖图，于是「装任何插件」都要替它重走一遍整条链，弱网下极慢。摘掉该声明后，运行时由自管目录承接——所以要**先收编、再升级**，否则升级后本地嵌入不可用。

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
    embedModelCacheDir: ""      # 模型缓存目录（空=用户级 ~/.dsh/mneme/models）
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
