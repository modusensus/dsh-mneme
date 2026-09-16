// 模型文件取件（issue #194）
//
// transformers.js 下载模型文件（如 model.onnx，约 1GB）走它自己的 env.fetch；undici
// socket 中途被重置（TypeError: terminated）时整份下载作废重来。4.2.0 的 env.fetch 是
// 官方文档化的可替换面（env.js: `fetch: DEFAULT_FETCH`），所以韧性做在这一层：对
// transformers.js 而言这仍然是一个普通的 fetch，成功路径的语义一点没变；变化只发生在
// 失败路径 —— 已收的字节落在磁盘 .part 里，重试（包括换一次进程）从断点继续。
//
// 硬规矩（与 runtime/download.js 的取件层同一套直觉）：
//   1. 交给下游的响应永远是规范的 200 + 完整 content-length。hub.js 把非 200 一律当
//      失败处理，206 直接透传反而会破坏下游；断点拼接是我们内部的事，不能漏出去。
//   2. 续传前带 If-Range：断点对应的内容若在服务端被换过，服务器会回 200（全量）。
//      旧断点拼新内容是一份静默损坏的模型 —— 宁可整份重来，不可拼错。
//   3. 同一 URL 的 .part 同一时刻只允许一个写者。两个进程并发追加同一份字节是写损坏；
//      抢不到锁就按现状直接转发（裸 fetch），让持锁的那份去落盘。
//
// @module dsh-mneme/runtime/model-fetch
import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, futimesSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import { defaultModelCacheDir } from "./layout.js";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 15000;
// 看门狗是「连续无字节」上限而不是总时长上限：几百 MB～1GB 的文件在慢网下合法地要下
// 几十分钟，总时长上限会掐死健康但慢的下载；连续这么久一个字节都没有才是 socket 僵死。
const DEFAULT_IDLE_TIMEOUT_MS = 120000;
// 锁的 mtime 超过这么久没刷新 = 持锁方已死（活着的话每个进度节拍都会刷新），可以抢。
const STALE_LOCK_MS = 30 * 60 * 1000;
// 进度事件节流：1GB 按 64KB 一块是一万多个事件，逐个发出去日志没法看。
const PROGRESS_EMIT_INTERVAL_MS = 500;

/** URL → 稳定文件名。断点文件要跨进程、跨重启可复用，所以用内容寻址而不是 pid。 */
function partName(url) {
  return createHash("sha256").update(url).digest("hex");
}

function readMeta(metaPath) {
  try {
    return readFileSync(metaPath, "utf8").trim();
  } catch {
    return "";
  }
}

function writeMeta(metaPath, etag) {
  writeFileSync(metaPath, `${etag}\n`, "utf8");
}

/** 断点不可信（比源文件还大 / 内容对不上）时整体作废，而不是试着修剪。 */
function resetPart(partPath, metaPath) {
  rmSync(partPath, { force: true });
  rmSync(metaPath, { force: true });
}

/**
 * 拿 .part 的写锁。返回 fd（持有着，供流式期间刷新 mtime）或 null（别人在写）。
 * 只尝试偷一次过期锁：再抢不到就放弃，调用方按现状裸转发。
 */
function acquireLock(lockPath, staleLockMs) {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, String(process.pid));
      return fd;
    } catch {
      let age = Infinity;
      try {
        age = Date.now() - statSync(lockPath).mtimeMs;
      } catch {}
      if (age > staleLockMs) {
        rmSync(lockPath, { force: true });
        continue;
      }
      return null;
    }
  }
  return null;
}

function releaseLock(lockPath, lockFd) {
  if (lockFd === null) return;
  try {
    closeSync(lockFd);
  } catch {}
  rmSync(lockPath, { force: true });
}

/** 进度事件的百分数。total 未知时给 null，让日志退化为「已收字节数」。 */
function percentOf(received, total) {
  return Number.isFinite(total) && total > 0 ? Math.floor((received / total) * 100) : null;
}

/**
 * 造一个「带断点续传的 fetch」。
 * @param {object} opts - 选项。
 * @param {Function} [opts.fetchImpl] - 底层 fetch，测试注入。
 * @param {string} opts.partDir - 断点文件目录（应与模型缓存同盘）。
 * @param {number} [opts.attempts] - 含首次在内的总尝试次数。
 * @param {number} [opts.retryDelayMs] - 退避基数：1s → 2s → 4s，封顶 maxRetryDelayMs。
 * @param {number} [opts.idleTimeoutMs] - 连续无字节的看门狗上限。
 * @param {Function} [opts.onEvent] - resume / progress / restart / fail 事件回调。
 * @param {Function} [opts.hash] - URL → 断点文件名，测试注入。
 * @returns {Function} 与全局 fetch 同签名的函数。
 */
export function createResilientFetch({
  fetchImpl = fetch,
  partDir,
  attempts = DEFAULT_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  maxRetryDelayMs = DEFAULT_MAX_RETRY_DELAY_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  onEvent = null,
  hash = partName
} = {}) {
  if (typeof partDir !== "string" || partDir === "") {
    throw new TypeError("createResilientFetch：partDir 是必填的（.part 断点文件落在这里）");
  }
  mkdirSync(partDir, { recursive: true });
  const emit = (event) => {
    try {
      onEvent?.(event);
    } catch {
      // 进度回调的异常不该打断下载本身。
    }
  };

  return async function resilientFetch(input, init = undefined) {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const method = String(init?.method ?? "GET").toUpperCase();
    // 非 GET（HEAD 元数据预检等）与带 body 的请求不落盘：原样转发，语义与裸 fetch 一致。
    if (method !== "GET" || init?.body != null) return fetchImpl(input, init);

    const partPath = join(partDir, hash(url));
    const metaPath = `${partPath}.meta`;
    const lockPath = `${partPath}.lock`;
    const lockFd = acquireLock(lockPath, STALE_LOCK_MS);
    if (lockFd === null) {
      // 另一个进程正在下同一个文件。并发追加同一份 .part 是写损坏，所以这边不参与落盘，
      // 按改动前的行为裸转发一次 —— 持锁方会正常下完，之后的加载会命中缓存。
      return fetchImpl(input, init);
    }

    try {
      return await downloadWithResume(url, init, {
        fetchImpl,
        partPath,
        metaPath,
        lockPath,
        lockFd,
        attempts,
        retryDelayMs,
        maxRetryDelayMs,
        idleTimeoutMs,
        emit
      });
    } catch (error) {
      // 失败路径锁在这里释放；成功路径的锁随断点文件一起在响应体流关闭后清理 ——
      // 若在返回响应时就放锁，另一个进程会在「.part 仍被下游流读着」的窗口里动它。
      releaseLock(lockPath, lockFd);
      throw error;
    }
  };
}

async function downloadWithResume(url, init, ctx) {
  const { fetchImpl, partPath, metaPath, lockPath, lockFd, attempts, retryDelayMs, maxRetryDelayMs, idleTimeoutMs, emit } = ctx;
  let lastError = null;
  let lastPercent = null;
  let lastReceived = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let offset = 0;
    if (existsSync(partPath)) {
      offset = statSync(partPath).size;
      if (offset > 0) {
        emit({ type: "resume", url, offset, attempt });
      }
    }

    const headers = new Headers(init?.headers);
    if (offset > 0) {
      headers.set("Range", `bytes=${offset}-`);
      // If-Range：断点对应的内容在服务端被换过时，服务器回 200（全量）而不是 206 ——
      // 那就整份重来。没有它，旧断点 + 新内容会拼出一份静默损坏的模型。
      const storedEtag = readMeta(metaPath);
      if (storedEtag) headers.set("If-Range", storedEtag);
    }

    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(init?.signal?.reason);
    init?.signal?.addEventListener("abort", onCallerAbort, { once: true });
    let idleTimer = null;
    const armIdle = () => {
      if (!(idleTimeoutMs > 0)) return;
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => controller.abort(new Error(`连接空闲超过 ${Math.round(idleTimeoutMs / 1000)}s 无数据`)),
        idleTimeoutMs
      );
    };
    armIdle();

    let fd = -1;
    let received = 0;
    let total = null;
    let lastEmitAt = 0;
    const reportProgress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastEmitAt < PROGRESS_EMIT_INTERVAL_MS) return;
      lastEmitAt = now;
      lastReceived = offset + received;
      lastPercent = percentOf(lastReceived, total);
      futimesSync(lockFd, new Date(), new Date()); // 锁的活着证明与进度同节拍刷新。
      emit({ type: "progress", url, received: lastReceived, total, percent: lastPercent, attempt });
    };

    try {
      const res = await fetchImpl(url, { ...init, headers, signal: controller.signal });

      // Range 起点越过源文件末尾（断点比源还大，通常断点来自被替换前的旧文件）：
      // 断点不可信 —— 清掉，这次尝试作废，下一次从 0 开始。不处理的话会在 416 上
      // 把重试次数全部烧完，报一条用户看不懂的错。
      if (res.status === 416) {
        emit({ type: "restart", url, offset, attempt, reason: "range-not-satisfiable" });
        resetPart(partPath, metaPath);
        lastError = new Error("HTTP 416（断点已重置）");
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      if (offset > 0 && res.status === 200) {
        // 服务器无视了 Range，或 If-Range 判定内容已变：整份重来。
        emit({ type: "restart", url, offset, attempt, reason: "range-rejected" });
        resetPart(partPath, metaPath);
        offset = 0;
      }
      if (res.status === 206) {
        const cr = /bytes (\d+)-(\d+)\/(\d+)/.exec(res.headers.get("content-range") ?? "");
        if (cr === null) throw new Error("206 响应缺少 Content-Range");
        total = Number(cr[3]);
        if (Number(cr[1]) !== offset) {
          // 服务器续的位置和断点对不上：不猜（拼错的字节比下载失败更糟），清掉重来。
          emit({ type: "restart", url, offset, attempt, reason: "offset-mismatch" });
          resetPart(partPath, metaPath);
          throw new Error(`断点偏移不一致（本地 ${offset}，服务器 ${cr[1]}），断点已重置`);
        }
      } else {
        total = Number(res.headers.get("content-length")) || null;
      }
      const etag = res.headers.get("etag");
      if (etag) writeMeta(metaPath, etag);

      fd = openSync(partPath, "a");
      if (res.body !== null) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          writeSync(fd, value);
          received += value.length;
          armIdle();
          reportProgress();
        }
      }
      // 服务端"干净地"提前关流（不抛错、但字节没给够）也是断流的一种，必须查出来。
      if (total !== null && offset + received !== total) {
        throw new Error(`下载不完整：收到 ${offset + received}/${total} 字节`);
      }
      clearTimeout(idleTimer);
      idleTimer = null;
      reportProgress(true);
      return partResponse(partPath, metaPath, lockPath, lockFd, offset + received, etag);
    } catch (error) {
      lastError = error;
      lastReceived = offset + received;
      lastPercent = percentOf(lastReceived, total);
      emit({ type: "fail", url, received: lastReceived, total, percent: lastPercent, attempt, error: String(error?.message ?? error) });
    } finally {
      if (fd >= 0) closeSync(fd);
      if (idleTimer !== null) clearTimeout(idleTimer);
      init?.signal?.removeEventListener("abort", onCallerAbort);
    }

    if (attempt < attempts) {
      // 退避：1s → 2s → 4s，封顶 maxRetryDelayMs。
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelayMs * 2 ** (attempt - 1), maxRetryDelayMs)));
    }
  }

  // 最终失败的错误必须带中断位置（issue #194 的第 3 项）：用户要能区分是网络断了
  // 还是磁盘满了，而不是看到一句干巴巴的 TypeError: terminated。
  const where = lastPercent !== null ? `中断于 ${lastPercent}%（${lastReceived} 字节）` : `已收 ${lastReceived} 字节`;
  throw new Error(`模型文件下载失败（试了 ${attempts} 次，${where}）：${lastError?.message ?? lastError}`);
}

/**
 * 把完成的断点文件包装成给下游的响应：规范的 200 + 完整 content-length，body 从磁盘
 * 流式读出（1GB 不进内存）。流关闭即清理断点文件 —— 它给下游（FileCache.put /
 * arrayBuffer）供字节的使命结束了，不清的话一个 1GB 的副本会一直躺在缓存旁边。
 */
function partResponse(partPath, metaPath, lockPath, lockFd, size, etag) {
  const nodeStream = createReadStream(partPath);
  const cleanup = () => {
    try {
      rmSync(partPath, { force: true });
      rmSync(metaPath, { force: true });
      releaseLock(lockPath, lockFd);
    } catch {}
  };
  nodeStream.on("close", cleanup);
  nodeStream.on("error", cleanup);
  return new Response(Readable.toWeb(nodeStream), {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(size),
      ...(etag ? { etag } : {})
    }
  });
}

/** 把事件映射成日志。只发人该看的行：续传、重来、每次失败的位置 —— 不刷进度条。 */
export function logModelFetchEvent(logger, event) {
  const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);
  const where = (e) => (e.percent !== null && e.percent !== undefined ? `${e.percent}%（${kb(e.received)}${e.total ? `/${kb(e.total)}` : ""}）` : kb(e.received ?? 0));
  switch (event.type) {
    case "resume":
      logger?.info?.(`[dsh-mneme] 模型下载带断点续传：已有 ${kb(event.offset)}，第 ${event.attempt} 次尝试`);
      break;
    case "restart":
      logger?.warn?.(`[dsh-mneme] 断点不可用（${event.reason}），模型下载从头再来`);
      break;
    case "fail":
      logger?.warn?.(`[dsh-mneme] 模型下载中断于 ${where(event)}，第 ${event.attempt} 次尝试失败：${event.error}`);
      break;
    default:
      break;
  }
}

/**
 * 把弹性 fetch 装到 transformers.js 的 env 上（embedder / reranker 共用这一个入口）。
 * @param {object} env - transformers.js 的 env（至少支持赋值 fetch）。
 * @param {object} opts - 选项。
 * @param {boolean} [opts.enabled] - 开关；关 = 完全不动 env（默认保持现状的出口）。
 * @param {string} [opts.cacheDir] - 模型缓存目录，断点文件落在它的 .mneme-partial 下。
 * @param {object} [opts.logger] - 接收下载进度日志的 logger。
 * @param {object} [opts.rest] - 透传给 createResilientFetch 的其余选项（测试注入）。
 * @returns {boolean} 是否实际安装。
 */
export function installResilientFetch(env, { enabled = true, cacheDir = "", logger = null, ...rest } = {}) {
  if (!enabled || !env) return false;
  const root = String(cacheDir ?? "").trim() || defaultModelCacheDir();
  const partDir = join(root, ".mneme-partial");
  mkdirSync(partDir, { recursive: true });
  env.fetch = createResilientFetch({ partDir, onEvent: (event) => logModelFetchEvent(logger, event), ...rest });
  return true;
}
