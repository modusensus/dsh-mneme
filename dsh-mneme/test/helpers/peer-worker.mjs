// Multi-process concurrency worker for test/peer-blockers.test.js:
// opens the SQLite store passed via argv and increments the mirror
// generation N times, so several real OS processes contend on one DB file.
// Usage: node test/helpers/peer-worker.mjs <dbPath> <iterations>
import { createStore } from "../../src/store.js";

const [, , dbPath, iterations] = process.argv;
const store = createStore(dbPath);
for (let i = 0; i < Number(iterations); i++) store.incrementGeneration();
store.close();
