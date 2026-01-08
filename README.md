# opencode-todo-reminder

An OpenCode plugin that automatically reminds the Agent to continue working when todos are still open.

> **Disclaimer:** This project is not affiliated with, endorsed by, or sponsored by the OpenCode project or its maintainers. It is an independent community plugin.

## What it does

When an Agent creates a todo list but stops before completing all tasks, this plugin injects a continuation prompt so the Agent keeps going. This helps prevent unfinished multi-step work from stalling.

## How it works

- Watches `todo.updated` and `session.idle` events.
- When the session becomes idle and there are todos in a trigger status, it waits for `idleDelayMs` and then calls `client.session.prompt(...)` with a short reminder.
- The reminder can include progress ("X/Y completed") when `includeProgressInPrompt` is enabled.

## Safety features

- **Loop protection**: Stops after `maxAutoSubmitsPerTodo` attempts for the same todo and sends a "paused" prompt.
- **Cooldown**: Enforces `cooldownMs` between injections per session.
- **Interrupt/queue detection**: Skips injection when the last message indicates the session is busy (e.g. last message is from the user, the last assistant message is still generating, or it was aborted).
- **Agent/model preservation**: Uses the last seen user `agent` and `model` when sending reminder prompts.
- **Optional toast**: When `useToasts` is enabled, it calls `client.tui.showToast(...)` before injecting.

## Installation

Add the plugin to your `opencode.json`:

```json
{
  "plugins": [
    "opencode-todo-reminder"
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
  "idleDelayMs": 1500,
  "cooldownMs": 15000,
  "triggerStatuses": ["pending", "in_progress", "open"],
  "includeProgressInPrompt": true,
  "useToasts": true,
  "syntheticPrompt": false
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable or disable the plugin |
| `maxAutoSubmitsPerTodo` | number | `3` | Max reminders per todo before pausing (loop protection) |
| `idleDelayMs` | number | `1500` | Delay (ms) after idle before injecting |
| `cooldownMs` | number | `15000` | Minimum time (ms) between injections |
| `triggerStatuses` | string[] | `["pending", "in_progress", "open"]` | Todo statuses that trigger reminders |
| `includeProgressInPrompt` | boolean | `true` | Include "X/Y completed" in the reminder |
| `useToasts` | boolean | `true` | Show a toast when a reminder is injected |
| `syntheticPrompt` | boolean | `false` | Set the injected prompt part `synthetic` flag |

## Example

Without this plugin:

```
User: "Refactor the auth module and update tests"
Agent: Creates todo list with 5 tasks, completes 2, then stops
User: Prompts "continue" manually
```

With this plugin:

```
User: "Refactor the auth module and update tests"
Agent: Creates todo list with 5 tasks, completes 2, pauses
Plugin: Injects a reminder prompt
Agent: Continues with task 3, 4, 5
```

## License

MIT

