import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { STR } from "./lang.js";

// Custom slash-command manager: keeps the DSH command registry in sync with
// user-defined commands persisted in SQLite. Commands are registered on boot
// and (re)registered on add/remove through the API.
//
// Per the DSH command contract, a handler's CommandResult text is only a UI
// settlement notice and never reaches the model. To actually drive the agent,
// the handler submits the user-authored instruction itself as a user followup
// message on the receiving agent (same pattern as the official /goal command).
// The notice just acknowledges the submission; an optional rawInput suffix
// typed after the command is appended for the model.

export function createCommandManager({ ctx, settings, logger, language = "zh" }) {
  const registered = new Map(); // name -> disposer

  function registerOne(command) {
    if (registered.has(command.name)) return;
    let dispose;
    try {
      dispose = ctx.commands.register({
        name: command.name,
        // 缺省描述随实例语言（命令描述进命令注册表，对 LLM 可见）。
        description: command.description || STR.commandFallbackDesc[language](command.name),
        input: { hint: STR.commandInputHint[language] },
        handler: (invocation) => submit(command, invocation)
      });
    } catch (error) {
      logger?.warn?.(`dsh-mneme: failed to register command /${command.name}: ${String(error)}`);
      return;
    }
    registered.set(command.name, dispose);
  }

  /** Submit the instruction (plus optional rawInput suffix) to the receiving agent. */
  function submit(command, invocation) {
    const suffix = typeof invocation?.rawInput === "string" ? invocation.rawInput.trim() : "";
    const text = suffix ? `${command.instruction}\n\n${suffix}` : command.instruction;
    const agent = invocation?.agent;
    if (typeof agent?.followup !== "function") {
      // 兜底：宿主未提供接收 agent 时退回旧行为，至少把指令展示在 notice 里。
      return { kind: "success", text };
    }
    try {
      agent.followup(createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "user" }
      }));
    } catch (error) {
      logger?.warn?.(`dsh-mneme: failed to submit /${command.name} to agent: ${String(error)}`);
      return { kind: "error", text: STR.commandSubmitFailed[language](command.name) };
    }
    return { kind: "success", text: STR.commandSubmitted[language](command.name) };
  }

  function unregisterOne(name) {
    const dispose = registered.get(name);
    if (dispose) {
      try {
        dispose();
      } catch {
        /* ignore double-dispose */
      }
      registered.delete(name);
    }
  }

  /** Register every stored command (boot-time sync). */
  function sync() {
    for (const command of settings.listCommands()) registerOne(command);
  }

  /** Add (or replace) a command and register it live. */
  function add({ name, description, instruction }) {
    const command = settings.addCommand({ name, description, instruction });
    registerOne(command);
    return command;
  }

  /** Remove a command by id and unregister it live. */
  function remove(id) {
    const existing = settings.listCommands().find((c) => c.id === id);
    if (!existing) return false;
    if (!settings.removeCommand(id)) return false;
    unregisterOne(existing.name);
    return true;
  }

  function dispose() {
    for (const name of [...registered.keys()]) unregisterOne(name);
  }

  return { sync, add, remove, list: () => settings.listCommands(), dispose };
}
