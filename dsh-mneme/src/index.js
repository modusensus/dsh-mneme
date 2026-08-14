import { createStore } from "./store.js";
import { createMirror, TYPE_FILE } from "./mirror.js";
import { createService } from "./service.js";
import { createTools } from "./tools.js";
import { createInjector } from "./inject.js";
import { createSummarizer } from "./summarize.js";
import { createDreamScheduler } from "./dream.js";
import { createApi } from "./api.js";
import { createSettings } from "./settings.js";
import { createCommandManager } from "./commands.js";
import { Config } from "./config.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-mneme";
export const inject = ["tools", "systemPrompt", "webServer", "llm", "agentDefaultModel", "commands"];
export { Config };

// Arrow (not function declaration): cordis 4 treats any apply with a
// prototype as a class constructor (`new apply(...)`) and discards its return
// value, so a `function apply` disposer would never run on unload. An arrow
// has no prototype, is called normally, and its returned disposer is collected
// and run by the fiber on unload.
export const apply = (ctx, config) => {
  const cfg = Config(config);

  // Resolve memoryDir: expand leading "~"
  const memoryDir = cfg.memoryDir.startsWith("~")
    ? join(homedir(), cfg.memoryDir.slice(1))
    : cfg.memoryDir;
  mkdirSync(memoryDir, { recursive: true });

  const store = createStore(join(memoryDir, "memory.db"));
  const mirror = createMirror(memoryDir);
  const service = createService({ store, mirror, config: cfg });

  // User-configurable settings (profile, rules) and custom commands share the
  // same SQLite file but live in dedicated tables, isolated from memories.
  const settings = createSettings(store.db);

  // Custom commands: register persisted commands into the DSH command registry
  // on boot; add/remove re-register live through the API.
  let commands = null;
  if (ctx.commands) {
    commands = createCommandManager({ ctx, settings, logger: ctx.logger });
    commands.sync();
  }

  // Human edits in mirror files win on every sync; merge them back first.
  // TYPE_FILE maps each memory type to its mirror filename. Read every type's
  // edits up front: mergeHumanEdits re-renders ALL mirror files on success, so
  // a per-type read-then-merge loop would overwrite edits in files not yet read
  // (e.g. preferences.md merging would clobber unsynced projects.md edits).
  const humanEdits = new Map();
  for (const type of Object.keys(TYPE_FILE)) {
    humanEdits.set(type, mirror.readHumanEdits(type));
  }
  for (const [type, edits] of humanEdits) {
    if (edits.length) service.mergeHumanEdits(type, edits);
  }

  // Dream scheduler: automatic consolidation + summary runs, triggered by
  // store growth. Writes through the service fire the dream hook, which asks
  // the scheduler to (re)schedule a run once absolute and since-last-run
  // thresholds are both exceeded. onRun is deferred through `dream` so the
  // closure sees the assigned scheduler; the null guard keeps a run safe even
  // if the hook fires before assignment or after dispose.
  let dream = null;
  if (cfg.autoDream) {
    dream = createDreamScheduler({
      thresholdCount: cfg.dreamThresholdCount,
      thresholdChars: cfg.dreamThresholdChars,
      delayMs: cfg.dreamDelayMs,
      logger: ctx.logger,
      onRun: () => (dream ? dream.runDream(ctx, service, cfg) : Promise.resolve({ ok: true, skipped: true }))
    });
    service.setDreamHook(() => dream.maybeSchedule(service));
  }

  const disposers = [];

  ctx.inject(["systemPrompt"], (promptCtx) => {
    if (cfg.autoInject) disposers.push(createInjector(promptCtx, service, settings, cfg));
  });

  ctx.inject(["tools"], (toolsCtx) => {
    disposers.push(createTools(toolsCtx, service, cfg));
  });

  const summarizer = createSummarizer(ctx, service, cfg);
  disposers.push(summarizer.dispose);

  if (ctx.webServer) {
    const api = createApi(ctx, service, settings, commands ?? {
      add: () => { throw new Error("commands unavailable"); },
      remove: () => false,
      list: () => []
    });
    disposers.push(api.dispose);
  }

  // Async disposer: cordis awaits the returned promise on unload (runDisposable),
  // so an in-flight dream run is allowed to finish before the SQLite store is
  // closed — dream.dispose() resolves only after its current run settles.
  return async () => {
    for (const dispose of disposers) {
      if (typeof dispose === "function") dispose();
    }
    commands?.dispose();
    if (dream) await dream.dispose();
    store.close();
  };
};
