import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createSettings } from "../src/settings.js";

function setup() {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  return { store, settings };
}

test("profile defaults to empty and round-trips", () => {
  const { store, settings } = setup();
  assert.equal(settings.getProfile(), "");
  settings.setProfile("我是后端工程师，偏好简洁代码");
  assert.equal(settings.getProfile(), "我是后端工程师，偏好简洁代码");
  settings.setProfile("");
  assert.equal(settings.getProfile(), "");
  store.close();
});

test("rules default to empty list and round-trip", () => {
  const { store, settings } = setup();
  assert.deepEqual(settings.getRules(), []);
  settings.setRules(["规则一", "规则二"]);
  assert.deepEqual(settings.getRules(), ["规则一", "规则二"]);
  settings.setRules([]);
  assert.deepEqual(settings.getRules(), []);
  store.close();
});

test("rules filters non-string entries", () => {
  const { store, settings } = setup();
  settings.setRules(["ok", 42, null, "also-ok"]);
  assert.deepEqual(settings.getRules(), ["ok", "also-ok"]);
  store.close();
});

test("addCommand stores and lists sorted by name", () => {
  const { store, settings } = setup();
  settings.addCommand({ name: "banner", description: "b", instruction: "打印横幅" });
  settings.addCommand({ name: "agenda", instruction: "列出今日议程" });
  const list = settings.listCommands();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((c) => c.name), ["agenda", "banner"]);
  assert.ok(list[1].id, "has id");
  store.close();
});

test("addCommand replaces existing name", () => {
  const { store, settings } = setup();
  settings.addCommand({ name: "fmt", instruction: "旧指令" });
  const updated = settings.addCommand({ name: "fmt", instruction: "新指令" });
  assert.equal(updated.instruction, "新指令");
  assert.equal(settings.listCommands().length, 1);
  store.close();
});

test("addCommand rejects invalid names and empty instructions", () => {
  const { store, settings } = setup();
  assert.throws(() => settings.addCommand({ name: "Bad Name", instruction: "x" }), /command name/);
  assert.throws(() => settings.addCommand({ name: "123abc", instruction: "x" }), /command name/);
  assert.throws(() => settings.addCommand({ name: "ok", instruction: "   " }), /instruction/);
  assert.equal(settings.listCommands().length, 0);
  store.close();
});

test("removeCommand removes by id and returns false for missing", () => {
  const { store, settings } = setup();
  const { id } = settings.addCommand({ name: "tmp", instruction: "x" });
  assert.equal(settings.removeCommand(id), true);
  assert.equal(settings.removeCommand(id), false);
  assert.equal(settings.listCommands().length, 0);
  store.close();
});

test("vector config defaults to undefined and round-trips", () => {
  const { store, settings } = setup();
  assert.equal(settings.getVectorConfig(), undefined);
  const saved = settings.setVectorConfig({
    enabled: true,
    baseUrl: " https://api.openai.com/v1/ ",
    apiKey: " sk-123 ",
    model: "text-embedding-3-small"
  });
  assert.equal(saved.enabled, true);
  assert.equal(saved.baseUrl, "https://api.openai.com/v1", "trims baseUrl");
  assert.equal(saved.apiKey, "sk-123", "trims apiKey");
  assert.equal(saved.model, "text-embedding-3-small");
  const read = settings.getVectorConfig();
  assert.equal(read.enabled, true);
  assert.equal(read.model, "text-embedding-3-small");
  store.close();
});

test("vector config disabled value is stored as false", () => {
  const { store, settings } = setup();
  settings.setVectorConfig({ enabled: false, baseUrl: "x", apiKey: "k", model: "m" });
  assert.equal(settings.getVectorConfig().enabled, false);
  store.close();
});

test("autoTag config defaults to disabled and round-trips", () => {
  const { store, settings } = setup();
  assert.deepEqual(settings.getAutoTagConfig(), { autoTagEnabled: false, manualTagEnabled: false });
  settings.setAutoTagConfig({ autoTagEnabled: true, manualTagEnabled: true });
  assert.deepEqual(settings.getAutoTagConfig(), { autoTagEnabled: true, manualTagEnabled: true });
  settings.setAutoTagConfig({ autoTagEnabled: false });
  assert.deepEqual(settings.getAutoTagConfig(), { autoTagEnabled: false, manualTagEnabled: true });
  store.close();
});

test("autoTag config coerces non-boolean to false", () => {
  const { store, settings } = setup();
  settings.setAutoTagConfig({ autoTagEnabled: "yes", manualTagEnabled: 1 });
  assert.deepEqual(settings.getAutoTagConfig(), { autoTagEnabled: false, manualTagEnabled: false });
  store.close();
});
