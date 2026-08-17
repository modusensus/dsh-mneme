import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createStore } from "../src/store.js";
import { createMirror } from "../src/mirror.js";
import { createService } from "../src/service.js";

const execFileP = promisify(execFile);
const STORE_PATH = fileURLToPath(new URL("../src/store.js", import.meta.url));

/**
 * v0.3.8 回归测试（audit peer 6 项运行时阻断 → INSTALLATION_NOT_APPROVED）。
 *
 * 测试点：
 *  A. 崩溃窗口（真实语义）：store.save 在业务事务内原子递增 desired generation，
 *     崩溃在 COMMIT 后、syncMirror 前 → 重启 recoverMirror 仅凭
 *     generation > applied_generation 捕获并收敛（peer blocker 1）
 *  B. 业务写同事务原子性：INSERT 失败回滚时 generation 不得递增（peer blocker 1/3）
 *  C. 多进程并发原子递增：8 进程 × 10 次不丢增量（peer blocker 3）
 *  D. generation 上界/负数拒绝（peer blocker 6）
 */

function setup(dbPath) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-peer-"));
  const mirrorDir = join(dir, "mirror");
  const store = createStore(dbPath ?? ":memory:");
  const mirror = createMirror(mirrorDir);
  const warns = [];
  const logger = { warn: (...a) => warns.push(a.join(" ")) };
  const service = createService({ store, mirror, config: {}, logger });
  return { dir, mirrorDir, store, mirror, service, warns };
}

test("peer-A: 崩溃窗口——save 后（generation 已递增）不 sync 直接关闭重开，recoverMirror 捕获并收敛", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-peer-"));
  const dbPath = join(dir, "mneme.db");
  const mirrorDir = join(dir, "mirror");
  try {
    const store = createStore(dbPath);
    const mirror = createMirror(mirrorDir);
    const service = createService({ store, mirror, config: {}, logger: { warn() {} } });
    try {
      // 业务写：store.save 在事务内递增 desired generation，但不触发 mirror 渲染
      store.save({ type: "project", title: "P", content: "x", importance: 3 });
      const afterSave = store.getMirrorState();
      assert.ok(afterSave.generation > afterSave.applied_generation,
        "save 后 generation > applied（COMMIT 完成，mirror 未同步=崩溃窗口）");
    } finally {
      // 模拟崩溃：不调 syncMirror，直接关库
      store.close();
    }

    // 重启：重新打开同一 DB，recoverMirror 必须捕获债务并收敛
    const store2 = createStore(dbPath);
    const mirror2 = createMirror(mirrorDir);
    const service2 = createService({ store: store2, mirror: mirror2, config: {}, logger: { warn() {} } });
    try {
      const result = service2.recoverMirror();
      assert.equal(result.recovered, true, "崩溃窗口必须被 recover 捕获");
      assert.equal(result.error, null);
      const state = store2.getMirrorState();
      assert.equal(state.dirty, false, "收敛后 dirty 清");
      assert.ok(state.generation <= state.applied_generation, "收敛后无未应用债务");
    } finally {
      store2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("peer-B: 业务写同事务原子性——INSERT 失败回滚时 generation 不得递增", () => {
  const { dir, store } = setup();
  try {
    store.save({ id: "dup", type: "project", title: "A", content: "x", importance: 3 });
    const before = store.getMirrorState().generation;
    assert.throws(
      () => store.save({ id: "dup", type: "project", title: "B", content: "y", importance: 3 }),
      /UNIQUE|constraint/i,
      "重复主键 INSERT 必须抛错"
    );
    assert.equal(store.getMirrorState().generation, before,
      "回滚后 generation 不递增（写与 desired generation 同事务，失败一起回滚）");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("peer-C: 多进程并发原子递增——8 进程×10 次 incrementGeneration 不丢增量", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-peer-"));
  const dbPath = join(dir, "concurrent.db");
  const N = 8;
  const M = 10;
  try {
    // 子进程脚本：打开同一 DB 文件，原子递增 M 次
    const worker = `
      const { createStore } = require(process.argv[1]);
      const store = createStore(process.argv[2]);
      for (let i = 0; i < ${M}; i++) { store.incrementGeneration(); }
      store.close();
    `;
    await Promise.all(
      Array.from({ length: N }, () =>
        execFileP(process.execPath, ["-e", worker, STORE_PATH, dbPath], { timeout: 30000 })
      )
    );
    const store = createStore(dbPath);
    try {
      const state = store.getMirrorState();
      assert.equal(state.generation, N * M,
        `并发 ${N} 进程 × ${M} 次必须无丢失增量，得到 ${state.generation}`);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("peer-D: generation 上界与负数拒绝", () => {
  const { dir, store } = setup();
  try {
    // 负数拒绝
    assert.throws(() => store.setMirrorState({ generation: -1 }), RangeError, "负数必须拒绝");
    assert.throws(() => store.setMirrorState({ applied_generation: -5 }), RangeError, "负数 applied 必须拒绝");
    // 超 MAX_SAFE_INTEGER 拒绝
    assert.throws(
      () => store.setMirrorState({ generation: Number.MAX_SAFE_INTEGER + 1 }),
      RangeError,
      "超出 MAX_SAFE_INTEGER 必须拒绝"
    );
    // 到上界后再 increment 必须抛错（读回不会 ERR_OUT_OF_RANGE）
    store.setMirrorState({ generation: Number.MAX_SAFE_INTEGER });
    assert.throws(() => store.incrementGeneration(), /exceeded MAX_SAFE_INTEGER/, "上界后再递增必须抛错");
    // 正常递增仍工作
    store.setMirrorState({ generation: 5 });
    assert.equal(store.incrementGeneration().generation, 6, "正常递增不受影响");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
