// Custom slash-command manager: keeps the DSH command registry in sync with
// user-defined commands persisted in SQLite. Commands are registered on boot
// and (re)registered on add/remove through the API.
//
// Each custom command's handler returns the user-authored instruction as a
// success result; the DSH UI surfaces it as a model-directed instruction.
export function createCommandManager({ ctx, settings, logger }) {
  const registered = new Map(); // name -> disposer

  function registerOne(command) {
    if (registered.has(command.name)) return;
    let dispose;
    try {
      dispose = ctx.commands.register({
        name: command.name,
        description: command.description || `自定义指令 ${command.name}`,
        handler: () => ({ kind: "success", text: command.instruction })
      });
    } catch (error) {
      logger?.warn?.(`dsh-mneme: failed to register command /${command.name}: ${String(error)}`);
      return;
    }
    registered.set(command.name, dispose);
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
