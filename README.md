# opencode-todo-reminder

An OpenCode plugin that reminds the Agent to continue when todos are still open.

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
  "plugins": [
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
  "messageFormat": "Incomplete tasks remain in your todo list.\nContinue working on the next pending task now; do not ask for permission; mark tasks complete when done.\n\nStatus: {completed}/{total} completed, {remaining} remaining.",
  "useToasts": true,
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
| `messageFormat` | string | See below | Reminder message format string |
| `useToasts` | boolean | `true` | Show toast notifications |
| `syntheticPrompt` | boolean | `false` | Set the injected prompt part `synthetic` flag |
| `debug` | boolean | `false` | Write debug logs to `.opencode/todo-reminder.log` |

### `messageFormat` placeholders

| Placeholder | Meaning |
|-------------|---------|
| `{total}` | Total number of todos |
| `{completed}` | Number of completed/cancelled todos |
| `{pending}` | Number of todos matching `triggerStatuses` |
| `{remaining}` | Alias for `{pending}` |

## Development

- Install: `npm install`
- Build: `npm run build`
- Typecheck: `npm run typecheck`
- Tests: `npm test`

## License

MIT
