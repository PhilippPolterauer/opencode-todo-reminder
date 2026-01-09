# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed

- **Breaking**: Replaced `includeProgressInPrompt` with `messageFormat` for custom reminder messages
- **Breaking**: Removed `cooldownMs` config option (unused)
- User messages now reset the reminder counter (loop protection resets on user interaction)

### Added

- Custom message format with interpolation support: `{total}`, `{completed}`, `{pending}`, `{remaining}`
- REQUIREMENTS.md documenting core plugin requirements

### Removed

- `cooldownMs` config option
- `includeProgressInPrompt` config option

## [0.0.1] - 2026-01-08

### Added

- Initial release of opencode-todo-reminder plugin
- Automatic reminder injection when session becomes idle with pending todos
- Zod schema validation for configuration with sensible defaults
- Loop protection: limits reminders per todo (default: 3) to prevent infinite loops
- Idle delay before injecting (default: 500ms)
- User abort detection: skips reminders if user pressed escape
- Toast notifications when reminders are sent (configurable)
- Synthetic prompt option to hide reminders from chat UI
- Progress information in prompts ("X/Y completed, Z remaining")

### Configuration Options

- `enabled` - Enable/disable the plugin (default: true)
- `triggerStatuses` - Todo statuses that trigger reminders (default: ["pending", "in_progress", "open"])
- `maxAutoSubmitsPerTodo` - Max reminders per todo before pausing (default: 3)
- `idleDelayMs` - Delay after idle before injecting (default: 500)
- `messageFormat` - Custom message format with interpolation
- `useToasts` - Show toast notifications (default: true)
- `syntheticPrompt` - Hide prompt from chat UI (default: false)
