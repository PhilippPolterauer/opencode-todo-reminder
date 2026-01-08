# opencode-todo-reminder

An OpenCode plugin that automatically reminds the AI to continue working on incomplete todos.

> **Disclaimer:** This project is not affiliated with, endorsed by, or sponsored by the OpenCode project or its maintainers. It is an independent community plugin.

## What it does

When the AI creates a todo list but stops before completing all tasks, this plugin automatically sends a continuation prompt to remind it to keep working. This prevents the AI from "forgetting" about pending tasks and ensures it follows through on multi-step work.

### How it works

1. The plugin monitors todo list updates and session idle events
2. When the session becomes idle and there are still pending/in-progress todos, it waits briefly (to avoid racing with the AI)
3. It then injects a continuation prompt like: *"Incomplete tasks remain in your todo list. Continue working on the next pending task now."*
4. The AI receives this as a new message and resumes work on the remaining todos

### Safety features

- **Loop protection**: Limits auto-reminders per todo (default: 3) to prevent infinite loops if a task is stuck
- **Cooldown**: Minimum time between reminders (default: 15 seconds) to avoid rapid-fire prompts
- **Interrupt detection**: Skips reminders if the user interrupted the AI or has a queued message
- **Agent/model preservation**: Sends reminders using the same agent (Plan/Code) and model the user was using

## Installation

```bash
npm install opencode-todo-reminder
```

Add the plugin to your `opencode.json`:

```json
{
  "plugins": [
    "opencode-todo-reminder"
  ]
}
```

## Configuration

Create a config file at `.opencode/todo-reminder.json` (project-level) or `~/.config/opencode/todo-reminder.json` (global):

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
| `maxAutoSubmitsPerTodo` | number | `3` | Max reminders per todo before stopping (loop protection) |
| `idleDelayMs` | number | `1500` | Delay (ms) after idle before sending reminder |
| `cooldownMs` | number | `15000` | Minimum time (ms) between reminders |
| `triggerStatuses` | string[] | `["pending", "in_progress", "open"]` | Todo statuses that trigger reminders |
| `includeProgressInPrompt` | boolean | `true` | Include "X/Y completed" in the reminder |
| `useToasts` | boolean | `true` | Show toast notifications when reminders are sent |
| `syntheticPrompt` | boolean | `false` | Hide the reminder prompt from the chat UI |

## Example

Without this plugin:
```
User: "Refactor the auth module and update tests"
AI: Creates todo list with 5 tasks, completes 2, then stops
User: Has to manually prompt "continue" or "keep going"
```

With this plugin:
```
User: "Refactor the auth module and update tests"  
AI: Creates todo list with 5 tasks, completes 2, pauses
Plugin: Automatically sends "Incomplete tasks remain..." 
AI: Continues with task 3, 4, 5 until all complete
```

## License

MIT
