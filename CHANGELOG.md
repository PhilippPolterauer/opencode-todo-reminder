# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

- (Add changes here)

## [0.0.3] - 2026-01-09

### Fixed

- Fix packaging issue where `dist/` was excluded from the release.

## [0.0.2] - 2026-01-09

### Added

- Configurable reminder template via `messageFormat` with placeholders: `{total}`, `{completed}`, `{pending}`, `{remaining}`.
- `REQUIREMENTS.md` documenting core plugin requirements.

### Changed

- User messages reset loop protection (the reminder counter).

### Removed

- **Breaking**: Removed `includeProgressInPrompt` (use `messageFormat` instead).
- **Breaking**: Removed `cooldownMs` (was unused).

### Fixed

- Fix build script and ESM imports for release.
- Reduce logging noise for timer cancellations.

### Chore

- Ignore local development file `.opencode/package.json`.

## [0.0.1] - 2026-01-08

### Added

- Initial release of opencode-todo-reminder.
- Automatic reminder injection when a session becomes idle with open todos.
- Config loading and validation with Zod.
- Loop protection to prevent reminder loops.
- Optional toast notifications.
- Synthetic prompt option.
