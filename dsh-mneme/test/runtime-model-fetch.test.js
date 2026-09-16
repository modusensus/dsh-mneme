import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResilientFetch, installResilientFetch } from "../src/runtime/model-fetch.js";

// 模型文件取件层（issue #194）。transformers.js 下载几百 MB～1GB 的模型文件时，
// undici socket 中途被重置（TypeError: terminated）会让整份下载作废重来；报告者实测
// `curl -C -` 能稳定完成，说明服务端支持 Range。整条链都在本地 http 服务器上测：
// 断流、续传、退避重试、进度百分比 —— 不依赖外网。

/** 内容有变化的字节（0..250 循环）：任何丢块 / 重复块都会在逐字节比对里现形。 */
function makeBody(size) {
  const body = Buffer.alloc(size);
  for (let i = 0; i < size; i++) body[i] = i % 251;
  return body;
}

/**
 * 只服务内存里那份字节的服务器。
 * - `cutFirst`：该 URL 的首次请求只发一半就掐断（等 30ms 再 destroy，保证客户端真的收到过字节）；
 * - `ignoreRange`：无视 Range 头，永远从 0 回全量 200 —— 逼出「续传被拒就从头再来」；
 * - `seen` 记录收到的 Range 头与请求数。
 */
async function serve(files, { cutFirst = null, ignoreRange = false } = {}) {
  const seen = { rangeHeader: null, requests: 0 };
  let cutDone = false;
  const server = createServer((req, res) => {
    seen.requests++;
    const body = files[req.url];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    const range = req.headers.range;
    if (typeof range === "string") seen.rangeHeader = range;
    const start = ignoreRange ? 0 : Number(/bytes=(\d+)-/.exec(range ?? "")?.[1] ?? 0);

    if (cutFirst === req.url && !cutDone && start === 0) {
      cutDone = true;
      res.writeHead(200, {
        "Content-Length": String(body.length),
        ETag: '"immutable-etag"'
      });
      res.write(body.subarray(0, Math.floor(body.length / 2)));
      // 立刻 destroy 会在客户端读到任何字节之前就断掉，那样就测不到「带着已收字节续传」。
      setTimeout(() => res.destroy(), 30);
      return;
    }
    if (start > 0) {
      const rest = body.subarray(start);
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}`,
        ETag: '"immutable-etag"'
      });
      res.end(rest);
      return;
    }
    res.writeHead(200, { "Content-Length": String(body.length), ETag: '"immutable-etag"' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

function partDirFor() {
  return mkdtempSync(join(tmpdir(), "mneme-mfetch-"));
}

function testFetcher(partDir, opts = {}) {
  return createResilientFetch({ partDir, retryDelayMs: 1, idleTimeoutMs: 5000, ...opts });
}

test("model-fetch：中途 terminated 后用 Range 续传，最终字节与源逐字节一致", async () => {
  const body = makeBody(65536);
  const srv = await serve({ "/model.onnx": body }, { cutFirst: "/model.onnx" });
  const dir = partDirFor();
  try {
    const fetchImpl = testFetcher(dir);
    const res = await fetchImpl(`${srv.base}/model.onnx`);
    assert.equal(res.status, 200, "对 transformers.js 必须以 200 形态出现（hub 会把非 200 当失败）");
    const received = Buffer.from(await res.arrayBuffer());
    assert.ok(received.equals(body), "续传拼出的字节必须与源完全一致");
    // 关键证据：第二次请求带了 Range —— 是续传，不是从头再来。
    assert.match(String(srv.seen.rangeHeader), /^bytes=\d+-$/, `续传请求应当带 Range，实际=${srv.seen.rangeHeader}`);
  } finally {
    await srv.close();
  }
});

test("model-fetch：每次失败都带中断百分比；重试耗尽时错误信息说清断在哪", async () => {
  const body = makeBody(100000);
  // 服务器掐在固定位置：每次请求都只发 30% 就断。
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Length": String(body.length), ETag: '"x"' });
    res.write(body.subarray(0, 30000));
    setTimeout(() => res.destroy(), 20);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = partDirFor();
  try {
    const events = [];
    const fetchImpl = testFetcher(dir, { attempts: 2, onEvent: (e) => events.push(e) });
    await assert.rejects(
      () => fetchImpl(`${base}/big.bin`),
      /中断于|30%/,
      "最终错误必须带中断位置，让用户能区分网络问题与磁盘问题"
    );
    const fail = events.filter((e) => e.type === "fail");
    assert.ok(fail.length >= 1, "每次失败都应发 fail 事件");
    assert.equal(fail.at(-1).percent, 30, `断在 30%%（30000/100000），实际=${fail.at(-1).percent}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("model-fetch：If-Range 失配（服务端内容已换）时回 200，断点作废整份重来，不产出拼接损坏", async () => {
  const v1 = makeBody(65536);
  const v2 = Buffer.from(v1.map((b) => (b + 7) % 251));
  let broken = false;
  const server = createServer((req, res) => {
    const range = Number(/bytes=(\d+)-/.exec(req.headers.range ?? "")?.[1] ?? 0);
    // If-Range 与当前内容不符（或没带）：真实服务器会回 200 全量 —— 内容换过了。
    if (req.headers["if-range"] !== undefined && req.headers["if-range"] !== '"v2"') {
      broken = true;
      res.writeHead(200, { "Content-Length": String(v2.length), ETag: '"v2"' });
      res.end(v2);
      return;
    }
    if (range > 0 && !broken) {
      res.writeHead(206, {
        "Content-Range": `bytes ${range}-${v1.length - 1}/${v1.length}`,
        ETag: '"v1"'
      });
      res.end(v1.subarray(range));
      return;
    }
    if (!broken) {
      res.writeHead(200, { "Content-Length": String(v1.length), ETag: '"v1"' });
      res.write(v1.subarray(0, Math.floor(v1.length / 2)));
      setTimeout(() => res.destroy(), 30);
      return;
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = partDirFor();
  try {
    const events = [];
    const fetchImpl = testFetcher(dir, { attempts: 2, onEvent: (e) => events.push(e) });
    const res = await fetchImpl(`${base}/model.onnx`);
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(events.some((e) => e.type === "restart" && e.reason === "range-rejected"), "应发 range-rejected 重来事件");
    assert.ok(body.equals(v2), "最终字节必须是新内容整份，而不是 v1 断点拼 v2 的损坏物");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("model-fetch：服务器续传位置与断点对不上时清掉断点重来（拼错比失败更糟）", async () => {
  const body = makeBody(65536);
  let cutDone = false;
  const server = createServer((req, res) => {
    const range = req.headers.range;
    if (typeof range === "string") {
      // 故意回一个与断点无关的 206（从 0 开始）：客户端必须识别出偏移不一致。
      res.writeHead(206, { "Content-Range": `bytes 0-${body.length - 1}/${body.length}`, ETag: '"x"' });
      res.end(body);
      return;
    }
    if (!cutDone) {
      cutDone = true;
      res.writeHead(200, { "Content-Length": String(body.length), ETag: '"x"' });
      res.write(body.subarray(0, 30000));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.writeHead(200, { "Content-Length": String(body.length), ETag: '"x"' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = partDirFor();
  try {
    const events = [];
    const fetchImpl = testFetcher(dir, { attempts: 3, onEvent: (e) => events.push(e) });
    const res = await fetchImpl(`${base}/model.onnx`);
    const received = Buffer.from(await res.arrayBuffer());
    assert.ok(events.some((e) => e.type === "restart" && e.reason === "offset-mismatch"));
    assert.ok(received.equals(body), "重置后重新下载的整份字节必须正确");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("model-fetch：416（断点越过文件末尾）时重置断点重试，而不是把重试次数烧完", async () => {
  const body = makeBody(65536);
  const server = createServer((req, res) => {
    const start = Number(/bytes=(\d+)-/.exec(req.headers.range ?? "")?.[1] ?? -1);
    if (start >= body.length) {
      // 诚实的 416：Range 起点越过源文件末尾（断点来自被替换前的旧文件）。
      res.writeHead(416, { "Content-Range": `bytes */${body.length}` });
      res.end();
      return;
    }
    if (start > 0) {
      res.writeHead(206, { "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}`, ETag: '"x"' });
      res.end(body.subarray(start));
      return;
    }
    res.writeHead(200, { "Content-Length": String(body.length), ETag: '"x"' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = `${base}/model.onnx`;
  const dir = partDirFor();
  try {
    // 预置一份比源文件还大的断点（70000 > 65536）+ 它的 etag。
    const partPath = join(dir, createHash("sha256").update(url).digest("hex"));
    writeFileSync(partPath, Buffer.alloc(70000, 1));
    writeFileSync(`${partPath}.meta`, '"old"\n');
    const events = [];
    const fetchImpl = testFetcher(dir, { attempts: 2, onEvent: (e) => events.push(e) });
    const res = await fetchImpl(url);
    const received = Buffer.from(await res.arrayBuffer());
    assert.ok(events.some((e) => e.type === "restart" && e.reason === "range-not-satisfiable"));
    assert.ok(received.equals(body), "重置后重新下载的整份字节必须正确");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("model-fetch：连接僵死时被空闲看门狗掐断并重试，而不是永远挂着", async () => {
  const body = makeBody(65536);
  let stalled = false;
  const server = createServer((_req, res) => {
    if (!stalled) {
      stalled = true;
      res.writeHead(200, { "Content-Length": String(body.length) });
      res.write(body.subarray(0, 10));
      return; // 永远不 end：僵死的 socket。
    }
    res.writeHead(200, { "Content-Length": String(body.length) });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = partDirFor();
  try {
    const events = [];
    const started = Date.now();
    const fetchImpl = testFetcher(dir, { attempts: 2, idleTimeoutMs: 150, retryDelayMs: 1, onEvent: (e) => events.push(e) });
    const res = await fetchImpl(`${base}/model.onnx`);
    const received = Buffer.from(await res.arrayBuffer());
    assert.ok(Date.now() - started < 5000, "应当被看门狗及时掐断，而不是挂住");
    assert.ok(events.some((e) => e.type === "fail" && /空闲/.test(e.error)), `失败事件应写明空闲超时，实际=${events.map((e) => e.error)}`);
    assert.ok(received.equals(body));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("model-fetch：服务端干净地提前关流（字节没给够）被查出并续传补齐", async () => {
  const body = makeBody(100000);
  const server = createServer((req, res) => {
    const range = Number(/bytes=(\d+)-/.exec(req.headers.range ?? "")?.[1] ?? 0);
    if (range > 0) {
      res.writeHead(206, { "Content-Range": `bytes ${range}-${body.length - 1}/${body.length}`, ETag: '"x"' });
      res.end(body.subarray(range));
      return;
    }
    res.writeHead(200, { "Content-Length": String(body.length), ETag: '"x"' });
    res.end(body.subarray(0, 30000)); // 声明 100000 只给 30000，然后"正常"结束。
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = partDirFor();
  try {
    const fetchImpl = testFetcher(dir, { attempts: 2 });
    const res = await fetchImpl(`${base}/model.onnx`);
    const received = Buffer.from(await res.arrayBuffer());
    assert.ok(received.equals(body), "缺的字节要从断点补齐");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("model-fetch：非 GET 与抢不到锁的请求原样直通，不落盘、不带 Range", async () => {
  const dir = partDirFor();
  const calls = [];
  const stub = (input, init) => {
    calls.push({ input: String(input), init: init ?? null });
    return new Response("raw", { status: 200, headers: { "content-length": "3" } });
  };
  const fetchImpl = testFetcher(dir, { fetchImpl: stub });
  await fetchImpl("https://example.com/meta", { method: "HEAD" });
  // 锁名与被测实现一致：<sha256(url)>.lock；新鲜的锁 = 别的进程正在写。
  const url = "https://example.com/model.onnx";
  const locked = join(dir, `${createHash("sha256").update(url).digest("hex")}.lock`);
  writeFileSync(locked, "9999");
  await fetchImpl(url);
  assert.equal(calls.length, 2, "两个请求都应直通底层 fetch");
  assert.equal(calls[0].init.method, "HEAD");
  assert.equal(calls[1].init, null, "直通不应改写调用参数");
  assert.deepEqual(readdirSync(dir), [`${createHash("sha256").update(url).digest("hex")}.lock`], "直通不该产生断点文件");
  rmSync(locked, { force: true });
});

test("model-fetch：响应体消费完后断点文件、meta 与锁都清理干净", async () => {
  const body = makeBody(65536);
  const srv = await serve({ "/model.onnx": body }, { cutFirst: "/model.onnx" });
  const dir = partDirFor();
  try {
    const fetchImpl = testFetcher(dir);
    const res = await fetchImpl(`${srv.base}/model.onnx`);
    await res.arrayBuffer(); // 消费完 = 下游（FileCache.put）拿完字节了。
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(readdirSync(dir).length, 0, `断点目录应已清空，实际=${readdirSync(dir)}`);
  } finally {
    await srv.close();
  }
});

test("installResilientFetch：开关关 = env 一字不动；开 = env.fetch 换成弹性实现", async () => {
  const envOff = {};
  assert.equal(installResilientFetch(envOff, { enabled: false }), false);
  assert.equal(envOff.fetch, undefined, "关闭时不许碰 env（默认保持现状的出口）");
  assert.equal(installResilientFetch(null, { enabled: true }), false, "env 缺席时不安装");

  const cacheRoot = mkdtempSync(join(tmpdir(), "mneme-install-"));
  const envOn = {};
  assert.equal(installResilientFetch(envOn, { enabled: true, cacheDir: cacheRoot, fetchImpl: () => new Response("x") }), true);
  assert.equal(typeof envOn.fetch, "function");
  assert.ok(existsSync(join(cacheRoot, ".mneme-partial")), "断点目录建在模型缓存旁");

  // 装上的 fetch 是能干活的：小文件直通下载 + 返回规范 200。
  const res = await envOn.fetch("https://example.com/tiny.bin");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "x");
});

