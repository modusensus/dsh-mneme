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

> 依赖：`@huggingface/transformers`（transformers.js）+ `onnxruntime-node` 已声明在插件 `package.json` 的 `dependencies`，无需额外安装。

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

## 3. 配置

### 3.1 插件配置（`~/.dsh/profiles/web/cordis.patch.yml`）

```yaml
- id: dsh-mneme
  name: '@modusensus/dsh-mneme'
  config:
    # ── Embedding ──────────────────────────────
    embedProvider: local        # local | ollama | openai（默认 openai，保持 v0.1 行为）
    localEmbedModel: Xenova/bge-small-zh-v1.5
    embedDimension: 512         # 与模型匹配的向量维度
    localEmbedDevice: cpu            # cpu | wasm | gpu（仅 local 生效）
    embedBatchSize: 8           # 分批嵌入条数，内存紧张调小
    embedModelCacheDir: ""           # 模型缓存目录（local 生效，空=用户级 ~/.dsh/mneme/models）
    embedBaseUrl: ""            # openai/ollama 生效（ollama 默认 http://localhost:11434）
    embedApiKey: ""             # openai 生效
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
| `localEmbedModel` | HF 模型 id（如 `Xenova/bge-small-zh-v1.5`） | Ollama 模型名（如 `nomic-embed-text`） | API 模型名（如 `text-embedding-3-small`） |
| `embedBaseUrl` | — | `http://localhost:11434`（默认） | OpenAI 兼容端点 |
| `embedApiKey` | — | — | 必填 |
| `localEmbedDevice` | ✅ | — | — |
| `embedBatchSize` | ✅ | — | ✅ |
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
