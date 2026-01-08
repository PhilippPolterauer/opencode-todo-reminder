# Changelog

All notable changes to this project will be documented in this file.

## [0.0.1] - 2026-01-08

### Added

- Initial release of opencode-todo-reminder plugin
- Automatic reminder injection when session becomes idle with pending todos
- Zod schema validation for configuration with sensible defaults
- Loop protection: limits reminders per todo (default: 3) to prevent infinite loops
- Cooldown between injections (default: 1000ms)
- Idle delay before injecting (default: 500ms)
- Interrupt detection: skips reminders if user interrupted or has queued message
- Agent/model preservation: sends reminders using the same agent and model as the user
- Toast notifications when reminders are sent (configurable)
- Synthetic prompt option to hide reminders from chat UI
- Progress information in prompts ("X/Y completed, Z remaining")
- Comprehensive test suite (44 tests)

### Configuration Options

- `enabled` - Enable/disable the plugin (default: true)
- `triggerStatuses` - Todo statuses that trigger reminders (default: ["pending", "in_progress", "open"])
- `maxAutoSubmitsPerTodo` - Max reminders per todo before pausing (default: 3)
- `idleDelayMs` - Delay after idle before injecting (default: 500)
- `cooldownMs` - Minimum time between injections (default: 1000)
- `includeProgressInPrompt` - Include progress in reminder (default: true)
- `useToasts` - Show toast notifications (default: true)
- `syntheticPrompt` - Hide prompt from chat UI (default: false)
