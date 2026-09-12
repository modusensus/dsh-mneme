import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createSettings } from "../src/settings.js";
import { createCommandManager } from "../src/commands.js";

function setup() {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  const registered = new Map(); // name -> definition
  const ctx = {
    commands: {
      register(def) {
        registered.set(def.name, def);
        return () => registered.delete(def.name);
      }
    }
  };
  const manager = createCommandManager({ ctx, settings, logger: null });
  return { store, settings, manager, registered };
}

test("sync registers all stored commands", () => {
  const { store, settings, manager, registered } = setup();
  settings.addCommand({ name: "agenda", description: "d", instruction: "列议程" });
  settings.addCommand({ name: "banner", instruction: "打印横幅" });
  manager.sync();
  assert.equal(registered.size, 2);
  assert.ok(registered.has("agenda") && registered.has("banner"));
  store.close();
});

test("add registers live; remove unregisters live", () => {
  const { store, manager, registered } = setup();
  const cmd = manager.add({ name: "review", description: "r", instruction: "审查代码" });
  assert.ok(registered.has("review"), "registered after add");
  assert.equal(registered.get("review").description, "r");
  assert.equal(manager.remove(cmd.id), true);
  assert.ok(!registered.has("review"), "unregistered after remove");
  store.close();
});

test("handler submits the instruction to the agent and returns a receipt", async () => {
  const { store, manager, registered } = setup();
  manager.add({ name: "fmt", description: "格式化", instruction: "请按项目的 lint 规则格式化当前文件" });
  const def = registered.get("fmt");
  assert.ok(def, "definition registered");
  assert.equal(def.input.hint, "可选：追加给模型的补充说明");
  const submitted = [];
  const agent = { followup: (message) => submitted.push(message) };
  const result = await def.handler({ agent, rawInput: "", signal: null });
  assert.equal(result.kind, "success");
  assert.equal(result.text, "已提交指令：fmt");
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].role, "user");
  assert.deepEqual(submitted[0].content, [{ type: "text", text: "请按项目的 lint 规则格式化当前文件" }]);
  assert.deepEqual(submitted[0].source, { kind: "user" });
  store.close();
});

test("rawInput suffix is appended for the model", async () => {
  const { store, manager, registered } = setup();
  manager.add({ name: "mneme", instruction: "以「小墨」的口吻自我介绍" });
  const def = registered.get("mneme");
  const submitted = [];
  await def.handler({ agent: { followup: (m) => submitted.push(m) }, rawInput: "  顺便列出归档数量  " });
  assert.equal(submitted[0].content[0].text, "以「小墨」的口吻自我介绍\n\n顺便列出归档数量");
  store.close();
});

test("handler without a receiving agent falls back to surfacing the instruction", () => {
  const { store, manager, registered } = setup();
  manager.add({ name: "fmt", instruction: "legacy text" });
  const def = registered.get("fmt");
  const result = def.handler({ rawInput: "" });
  assert.equal(result.kind, "success");
  assert.equal(result.text, "legacy text");
  store.close();
});

test("handler returns an error result when the agent rejects the submission", () => {
  const { store, manager, registered } = setup();
  manager.add({ name: "boom", instruction: "x" });
  const def = registered.get("boom");
  const result = def.handler({ agent: { followup: () => { throw new Error("nope"); } } });
  assert.equal(result.kind, "error");
  assert.match(result.text, /boom/);
  store.close();
});

test("remove of missing id returns false", () => {
  const { store, manager } = setup();
  assert.equal(manager.remove("nope"), false);
  store.close();
});

test("dispose unregisters everything", () => {
  const { store, settings, manager, registered } = setup();
  settings.addCommand({ name: "a", instruction: "x" });
  settings.addCommand({ name: "b", instruction: "y" });
  manager.sync();
  assert.equal(registered.size, 2);
  manager.dispose();
  assert.equal(registered.size, 0);
  store.close();
});
