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
export const inject = ["tools", "systemPrompt"];
export { Config };

export function apply(ctx, config) {
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
    disposers.push(createApi(ctx, service));
  }

  return () => {
    for (const dispose of disposers) dispose();
    store.close();
  };
}
