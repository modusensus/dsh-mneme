// Multi-process concurrency worker for test/peer-blockers.test.js:
// opens the SQLite store passed via argv and increments the mirror
// generation N times, so several real OS processes contend on one DB file.
// Usage: node test/helpers/peer-worker.mjs <dbPath> <iterations>
import { createStore } from "../../src/store.js";

const [, , dbPath, iterations] = process.argv;

// Windows CI 上 8 进程并发写同一 generation 行时，busy_timeout(5s) 到期仍偶发
// SQLITE_BUSY（"database is locked"）。锁是瞬时资源竞争，线性重试即可收敛；
// incrementGeneration 是单条原子 UPDATE（失败即未执行），重试不会重复计数。
async function withBusyRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!/database is locked|SQLITE_BUSY/i.test(String(err?.message ?? err)) || attempt >= 40) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

const store = await withBusyRetry(() => createStore(dbPath));
for (let i = 0; i < Number(iterations); i++) await withBusyRetry(() => store.incrementGeneration());
store.close();
