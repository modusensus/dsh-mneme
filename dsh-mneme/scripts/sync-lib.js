// Sync the src/ tree into lib/ — the distributable consumed by DSH (package
// main is lib/index.js). lib/client.js (the Web panel bundle) is authored
// independently under lib/ and is left untouched: the sync only copies
// src -> lib, it never prunes lib-only files.
//
// Usage: npm run sync   (also run automatically by `npm pack`/`npm publish`
// via the prepack hook, so a published tarball always ships a fresh lib/).
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const srcDir = join(root, "src");
const libDir = join(root, "lib");

/** Recursively collect all files under a directory (sorted for stable output). */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

let copied = 0;
mkdirSync(libDir, { recursive: true });

for (const file of walk(srcDir)) {
  const rel = relative(srcDir, file);
  const dest = join(libDir, rel);
  mkdirSync(join(dest, ".."), { recursive: true });
  cpSync(file, dest);
  copied++;
  console.log(`synced  ${rel}`);
}

// Report lib-only files (authored separately, e.g. client.js) so drift is
// visible but never clobbered.
for (const file of walk(libDir)) {
  const rel = relative(libDir, file);
  if (!existsSync(join(srcDir, rel))) console.log(`kept    ${rel} (lib-only, not pruned)`);
}

console.log(`\nSynced ${copied} file(s) from src/ to lib/.`);
if (!copied) process.exitCode = 1;
