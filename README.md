# opencode-todo-reminder

An OpenCode plugin that reminds the Agent to continue when todos are still open.

![OpenCode todo-reminder screenshot](https://github.com/PhilippPolterauer/opencode-todo-reminder/raw/main/docs/output.gif)

> **Disclaimer:** This project is not affiliated with, endorsed by, or sponsored by the OpenCode project or its maintainers. It is an independent community plugin.

## What it does

If an Agent creates a todo list but stops before finishing, this plugin injects a continuation prompt so the Agent keeps going.

## How it works

- Listens for `session.idle` events.
- After `idleDelayMs`, fetches the current session todos.
- If any todos match `triggerStatuses`, injects a reminder via `client.session.prompt(...)`.
- The reminder text is rendered from `messageFormat` using placeholders.

## Safety features

- **Loop protection**: After `maxAutoSubmitsPerTodo` reminders without todo-state changes, reminders pause and (optionally) a warning toast is shown.
- **User interaction resets**: A new user message cancels any scheduled reminder and resets the loop-protection counter.
- **User abort detection**: If the user aborts generation (escape), the next idle-cycle reminder is skipped.
- **Optional toasts**: When `useToasts` is enabled, the plugin shows an info toast on reminders and a warning toast when paused.
- **Fail-soft behavior**: All API/UI calls are wrapped in `try/catch` to avoid interrupting the session.

## Installation

Add the plugin to your `opencode.json[c]`:

```json
{
  "plugin": [
    "opencode-todo-reminder", ...//otherPlugins
  ]
}
```

## Configuration

Config file locations:

- Project: `.opencode/todo-reminder.json`
- Global: `~/.config/opencode/todo-reminder.json`

Example:

```json
{
  "enabled": true,
  "maxAutoSubmitsPerTodo": 3,
  "idleDelayMs": 500,
  "triggerStatuses": ["pending", "in_progress", "open"],
  "messageFormat": "Incomplete tasks remain in your todo list.\nIf any are already done, call todowrite to mark them complete/cancelled first.\nKeep todo statuses current going forward - update each one via todowrite as soon as it is finished, not only when reminded.\nContinue working on the next pending task now; do not ask for permission; mark tasks complete when done.\n\nStatus: {completed}/{total} completed, {remaining} remaining.{orphan_table}",
  "inProgressMessageFormat": "You have an in-progress task: \"{current_task}\".\nIf it's already done, call todowrite to mark it complete first - otherwise continue working on THIS task until it's done; do not skip ahead to a different one or restart it. Keep todo statuses current going forward, not only when reminded. Mark it complete when finished.\n\nStatus: {completed}/{total} completed, {remaining} remaining.{orphan_table}",
  "useToasts": true,
  "preserveUnfinishedTodos": true,
  "warnOrphanedTodos": false,
  "orphanScanLimit": 20,
  "syntheticPrompt": false,
  "debug": false
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable or disable the plugin |
| `maxAutoSubmitsPerTodo` | number | `3` | Max reminders before pausing (loop protection) |
| `idleDelayMs` | number | `500` | Delay (ms) after idle before injecting |
| `triggerStatuses` | string[] | `["pending", "in_progress", "open"]` | Todo statuses that trigger reminders |
| `messageFormat` | string | See below | Reminder message format used when no todo is in_progress |
| `inProgressMessageFormat` | string | See below | Reminder message format used instead of `messageFormat` when a todo is already `in_progress`, so the model is told to finish that task rather than move to "the next pending" one |
| `useToasts` | boolean | `true` | Show toast notifications |
| `preserveUnfinishedTodos` | boolean | `true` | Before a `todowrite` call reaches opencode, backfill any todo the model's new call omitted whose prior status was still unfinished (matched by `triggerStatuses`) - opencode's `todowrite` fully replaces the todo list on every call with no merge, so an omitted todo would otherwise just be lost |
| `warnOrphanedTodos` | boolean | `false` | Scan other sessions in the same project (once per session lifetime, only when this session's own reminder is already about to fire) for incomplete todos left behind under a different session id, and append a short summary via `{orphan_table}` |
| `orphanScanLimit` | number | `20` | Upper bound (non-negative integer) on how many other sessions, most-recently-updated first, to check when `warnOrphanedTodos` is enabled |
| `syntheticPrompt` | boolean | `false` | Set the injected prompt part `synthetic` flag |
| `debug` | boolean | `false` | Write debug logs to `.opencode/todo-reminder.log` |

### `messageFormat` / `inProgressMessageFormat` placeholders

| Placeholder | Meaning |
|-------------|---------|
| `{total}` | Total number of todos |
| `{completed}` | Number of completed/cancelled todos |
| `{pending}` | Number of todos matching `triggerStatuses` |
| `{remaining}` | Alias for `{pending}` |
| `{current_task}` | `inProgressMessageFormat` only - the content of the todo currently `in_progress` |
| `{orphan_table}` | Populated when `warnOrphanedTodos` finds incomplete todos in other sessions (empty string otherwise) - a short `sessionID - N open` list |

## Development

- Install: `npm install`
- Build: `npm run build`
- Typecheck: `npm run typecheck`
- Tests: `npm test`

## License

MIT
