# Requirements

This document defines the core requirements for the todo-reminder plugin.

## R1: Remind agent to continue on idle with open todos

The plugin must remind the agent to continue working when the session becomes idle and there are still open todos (pending or in_progress status).

**Acceptance criteria:**
- When session goes idle and todos remain incomplete, inject a continuation prompt
- The reminder message format should be configurable via `messageFormat`
- Reminders should only trigger after a configurable delay (`idleDelayMs`)

## R2: Stop reminding when agent fails to make progress

The plugin should stop reminding if the agent fails to make progress on the todos, to prevent infinite reminder loops.

**Acceptance criteria:**
- Track the number of reminders sent without todo state changes
- After `maxAutoSubmitsPerTodo` reminders without progress, pause reminders
- Show a warning toast when loop protection activates
- Resume reminders once a todo status changes

## R3: Reset reminder counter on user interaction

If a user interacts with the chat, the reminder cycle breaker (loop protection counter) should be reset.

**Acceptance criteria:**
- When a new user message is received, reset the inject counter to zero
- This allows reminders to resume even if loop protection was previously triggered

## R4: User abort should pause reminders

If the user aborts the current generation (e.g., by pressing escape), reminders should be paused for that idle cycle.

**Acceptance criteria:**
- Detect `session.error` with `MessageAbortedError`
- Skip the next scheduled reminder for that session
- Clear abort state when user sends a new message

## R5: Plugin must fail soft

The plugin must not disrupt the user experience if something goes wrong.

**Acceptance criteria:**
- All external API calls (todo fetch, prompt injection, toasts) must be wrapped in try/catch
- Errors should be logged but not thrown
- Plugin should continue operating even if individual operations fail
