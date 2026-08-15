import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientSource = readFileSync(join(root, "lib/client.js"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// The Web client bundle registers itself via __ModuleLoader__.load. DSH
// resolves the bundle by plugin package name, so the registered id must match
// package.json `name` exactly (a mismatch surfaces as "loaded without
// registering '@modusensus/dsh-mneme'" in the DSH client).
test("client bundle registers under the package name", () => {
  const match = clientSource.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/);
  assert.ok(match, "client bundle must call __ModuleLoader__.load with an id");
  assert.equal(match[1], pkg.name, "registered id must equal package.json name");
});

// client.js is hand-authored under lib/ only (no src/ counterpart), so the
// src->lib sync must never prune it.
test("client bundle is lib-only with no src counterpart", () => {
  assert.equal(existsSync(join(root, "src/client.js")), false, "src/ must not contain client.js");
  assert.equal(existsSync(join(root, "lib/client.js")), true, "lib/client.js must exist");
});

// Both panels render in two modes: a portal modal (styles.panel, full chrome)
// and an embedded settings-section variant. The embedded variant must drop the
// modal-only chrome (background, radius, padding, shadow) — the settings host
// already provides its own surface, so reusing the modal panel style makes the
// section render as a floating card with an inset box and shadow inside the
// settings page.
test("embedded variant drops the modal panel chrome", () => {
  const branches = clientSource.match(/embedded \? \{[^}]+\}/g);
  assert.ok(branches, "panels must branch on the embedded flag");
  assert.equal(branches.length, 2, "both MemoryPanel and SettingsPanel must branch");
  for (const branch of branches) {
    assert.equal(branch.includes("styles.panel"), false, "embedded branch must not reuse the modal panel style");
    for (const chrome of ["boxShadow", "background", "borderRadius", "padding"]) {
      assert.equal(branch.includes(chrome), false, `embedded branch must not carry ${chrome}`);
    }
  }
});
