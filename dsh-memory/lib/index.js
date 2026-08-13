import { createStore } from "./store.js";
import { createMirror, TYPE_FILE } from "./mirror.js";
import { createService } from "./service.js";
import { createTools } from "./tools.js";
import { createInjector } from "./inject.js";
import { createSummarizer } from "./summarize.js";
import { createApi } from "./api.js";
import { Config } from "./config.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-memory";
export const inject = ["tools", "systemPrompt", "webServer", "llm"];
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

  // Human edits in mirror files win on every sync; merge them back first.
  // TYPE_FILE maps each memory type to its mirror filename.
  for (const type of Object.keys(TYPE_FILE)) {
    const edits = mirror.readHumanEdits(type);
    if (edits.length) service.mergeHumanEdits(type, edits);
  }

  const disposers = [];

  ctx.inject(["systemPrompt"], (promptCtx) => {
    if (cfg.autoInject) disposers.push(createInjector(promptCtx, service, cfg));
  });

  ctx.inject(["tools"], (toolsCtx) => {
    disposers.push(createTools(toolsCtx, service, cfg));
  });

  const summarizer = createSummarizer(ctx, service, cfg);
  disposers.push(summarizer.dispose);

  if (ctx.webServer) {
    const api = createApi(ctx, service);
    disposers.push(api.dispose);
  }

  return () => {
    for (const dispose of disposers) {
      if (typeof dispose === "function") dispose();
    }
    store.close();
  };
};
