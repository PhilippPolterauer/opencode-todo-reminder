import { type Plugin } from "@opencode-ai/plugin";
import {
    type Todo,
    type EventTodoUpdated,
    type EventSessionIdle,
    type EventSessionDeleted,
    type EventMessageUpdated,
    type EventMessagePartUpdated,
} from "@opencode-ai/sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type TodoReminderConfig } from "./config.js";

const DEBUG_PREFIX = "[TodoReminder]";

let debugEnabled = false;
let debugLogPath: string | null = null;

/**
 * Initialize the debug logger with the project directory.
 */
function initDebugLogger(directory: string | undefined, enabled: boolean): void {
    debugEnabled = enabled;
    if (enabled && directory) {
        const opencodeDir = join(directory, ".opencode");
        try {
            mkdirSync(opencodeDir, { recursive: true });
        } catch {
            // Directory may already exist
        }
        debugLogPath = join(opencodeDir, "todo-reminder.log");
    }
}

/**
 * Write debug messages to the log file.
 */
function debug(...args: unknown[]): void {
    if (!debugEnabled || !debugLogPath) {
        return;
    }

    const timestamp = new Date().toISOString();
    const message = args
        .map((arg) =>
            typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)
        )
        .join(" ");
    const logLine = `${timestamp} ${DEBUG_PREFIX} ${message}\n`;

    try {
        appendFileSync(debugLogPath, logLine);
    } catch {
        // Silently fail if we can't write to the log file
    }
}

/**
 * Runtime state for a single session.
 */
export interface SessionState {
    hasPending: boolean;
    lastInjectAtMs: number;
    pendingInjectTimer: ReturnType<typeof setTimeout> | null;
    /** Map from todo.id (or content fallback) to injection count */
    perTodoInjectCount: Map<string, number>;
    /** Flag to stop injecting for this session after hitting max limit */
    loopProtectionTriggered: boolean;
    /** Last agent used by the user (e.g. "plan" or "build") */
    lastUserAgent?: string;
    /** Last model used by the user */
    lastUserModel?: { providerID: string; modelID: string };
}

/**
 * Create a fresh session state.
 */
export function createSessionState(): SessionState {
    return {
        hasPending: false,
        lastInjectAtMs: 0,
        pendingInjectTimer: null,
        perTodoInjectCount: new Map(),
        loopProtectionTriggered: false,
    };
}




/**
 * Get a stable key for a todo item.
 */
export function getTodoKey(todo: Todo): string {
    return todo.id || todo.content;
}

/**
 * Build the continuation prompt text.
 */
export function buildPromptText(
    config: Required<TodoReminderConfig>,
    pendingTodos: Todo[],
    allTodos: Todo[],
): string {
    const lines: string[] = [];

    lines.push("Incomplete tasks remain in your todo list.");
    lines.push(
        "Continue working on the next pending task now; do not ask for permission; mark tasks complete when done.",
    );

    if (config.includeProgressInPrompt && allTodos.length > 0) {
        const completedCount = allTodos.filter(
            (t) => t.status === "completed" || t.status === "cancelled",
        ).length;
        const remaining = pendingTodos.length;
        lines.push("");
        lines.push(
            `Status: ${completedCount}/${allTodos.length} completed, ${remaining} remaining.`,
        );
    }

    return lines.join("\n");
}

/**
 * Filter todos by trigger statuses.
 */
export function filterPendingTodos(
    todos: Todo[],
    triggerStatuses: string[],
): Todo[] {
    const statusSet = new Set(triggerStatuses);
    return todos.filter((t) => statusSet.has(t.status));
}

export const TodoReminderPlugin: Plugin = async ({ client, directory }) => {
    const config = loadConfig(directory);

    // Initialize debug logging
    initDebugLogger(directory, config.debug);

    debug("Plugin initializing", { directory, config });

    // Runtime state per session (in-memory only; no persistence)
    const sessionStates = new Map<string, SessionState>();

    /**
     * Get or create session state.
     */
    function getState(sessionID: string): SessionState {
        let state = sessionStates.get(sessionID);
        if (!state) {
            state = createSessionState();
            sessionStates.set(sessionID, state);
        }
        return state;
    }

    /**
     * Cancel any pending injection timer for a session.
     */
    function cancelPendingTimer(sessionID: string): void {
        const state = sessionStates.get(sessionID);
        if (!state) return;

        if (state.pendingInjectTimer) {
            clearTimeout(state.pendingInjectTimer);
            state.pendingInjectTimer = null;
            debug("Cancelled pending timer", { sessionID });
        }
    }

    /**
     * Clean up session state when no longer needed.
     */
    function cleanupSession(sessionID: string): void {
        cancelPendingTimer(sessionID);
        sessionStates.delete(sessionID);
        debug("Cleaned up session state", { sessionID });
    }

    /**
     * Core injection logic - called after idle delay or as fallback.
     */
    async function maybeInject(sessionID: string): Promise<void> {
        debug("maybeInject called", { sessionID });

        // Guard: plugin enabled
        if (!config.enabled) {
            debug("Plugin disabled, skipping");
            return;
        }

        const state = getState(sessionID);

        // Guard: loop protection already triggered
        if (state.loopProtectionTriggered) {
            debug("Loop protection triggered, skipping", { sessionID });
            return;
        }

        // Fetch session messages to check if the last message was interrupted
        // or if there's a queued/in-flight message we should skip
        try {
            const msgResp = await client.session.messages({
                path: { id: sessionID },
                query: { limit: 1 },
            });
            const lastMessage = msgResp.data?.[0];
            if (lastMessage) {
                // The API returns { info: Message, parts: Part[] }
                const info = (lastMessage as any).info || lastMessage;

                // If the last message is from user, skip (queued message waiting)
                if (info.role === "user") {
                    debug("Last message is from user (queued), skipping reminder", {
                        sessionID,
                    });
                    return;
                }
                
                // If the last message was from assistant and it was interrupted, skip
                if (info.role === "assistant") {
                    const isInterrupted =
                        info.error?.name === "MessageAbortedError" ||
                        info.finish === "abort";
                    if (isInterrupted) {
                        debug("Last message was interrupted, skipping reminder", {
                            sessionID,
                        });
                        return;
                    }

                    // If assistant message is still in progress (no time.completed), skip
                    if (!info.time?.completed) {
                        debug("Last assistant message still generating, skipping reminder", {
                            sessionID,
                        });
                        return;
                    }
                }
            }
        } catch (error) {
            debug("Error fetching messages", error);
            // Non-fatal, continue to todos
        }

        // Fetch todos
        let todos: Todo[];
        try {
            const todoResp = await client.session.todo({
                path: { id: sessionID },
            });
            debug("API response", {
                hasData: !!todoResp.data,
                isArray: Array.isArray(todoResp.data),
                todoCount: Array.isArray(todoResp.data)
                    ? todoResp.data.length
                    : 0,
            });
            if (!todoResp.data || !Array.isArray(todoResp.data)) {
                debug("No valid todo data returned");
                return;
            }
            todos = todoResp.data;
        } catch (error) {
            debug("Error fetching todos", error);
            return;
        }

        // Compute pending todos
        const triggerStatuses = new Set(config.triggerStatuses);
        const pendingTodos = todos.filter((t) => triggerStatuses.has(t.status));

        debug("Filtered pending todos", {
            total: todos.length,
            pendingCount: pendingTodos.length,
        });

        // Update tracking state
        state.hasPending = pendingTodos.length > 0;

        if (pendingTodos.length === 0) {
            debug("No pending todos, cleaning up");
            cleanupSession(sessionID);
            return;
        }

        // Guard: cooldown
        const now = Date.now();
        const timeSinceLastInject = now - state.lastInjectAtMs;
        if (timeSinceLastInject < config.cooldownMs) {
            debug("Cooldown active, skipping", {
                timeSinceLastInject,
                cooldownMs: config.cooldownMs,
            });
            return;
        }

        // Guard: per-todo loop prevention
        // Pick the "next todo" to attribute injection to (first pending by list order)
        const nextTodo = pendingTodos[0];
        if (!nextTodo) {
            // Should not happen given the length check above, but satisfy TypeScript
            debug("No next todo found (unexpected)");
            return;
        }
        const todoKey = getTodoKey(nextTodo);
        const currentCount = state.perTodoInjectCount.get(todoKey) || 0;

        if (currentCount >= config.maxAutoSubmitsPerTodo) {
            debug("Max auto-submits reached for todo, triggering loop protection", {
                sessionID,
                todoKey,
                currentCount,
                maxAutoSubmitsPerTodo: config.maxAutoSubmitsPerTodo,
            });
            state.loopProtectionTriggered = true;

            // Send a "blocked" prompt once to inform the model
            try {
                const blockedText =
                    `Auto-continuation has been paused: the task "${nextTodo.content}" has not progressed after ${currentCount} attempts. ` +
                    "Please review what's blocking progress and either complete the task manually, break it into smaller steps, or cancel it if it's no longer needed.";

                await client.session.prompt({
                    path: { id: sessionID },
                    query: { directory },
                    body: {
                        parts: [
                            {
                                type: "text",
                                text: blockedText,
                                synthetic: config.syntheticPrompt,
                            },
                        ],
                        // Use the same agent/model as the user's last message
                        // This respects Plan vs Build mode
                        agent: state.lastUserAgent,
                        model: state.lastUserModel,
                    },
                });
                debug("Sent blocked notification");
            } catch (error) {
                debug("Error sending blocked notification", error);
            }
            return;
        }

        // Increment injection count for this todo
        state.perTodoInjectCount.set(todoKey, currentCount + 1);

        // Show toast if enabled (before prompt to avoid delay)
        if (config.useToasts) {
            try {
                await client.tui.showToast({
                    query: { directory },
                    body: {
                        title: "TODO Reminder",
                        message: "A TODO reminder was issued",
                        variant: "info",
                    },
                });
            } catch (error) {
                debug("Error showing toast", error);
            }
        }

        // Build and send the prompt
        const promptText = buildPromptText(config, pendingTodos, todos);
        debug("Sending continuation prompt", { sessionID, promptText });

        try {
            const result = await client.session.prompt({
                path: { id: sessionID },
                query: { directory },
                body: {
                    parts: [
                        {
                            type: "text",
                            text: promptText,
                            synthetic: config.syntheticPrompt,
                        },
                    ],
                    // Use the same agent/model as the user's last message
                    // This respects Plan vs Build mode
                    agent: state.lastUserAgent,
                    model: state.lastUserModel,
                },
            });

            // If the user cancels/dismisses the prompt UI, treat it as a no-op and
            // do not schedule further periodic reminders.
            if (result && typeof result === "object") {
                const resultAny = result as any;
                if (resultAny.cancelled === true || resultAny.canceled === true) {
                    debug("Prompt cancelled by user; skipping periodic reminders", {
                        sessionID,
                    });
                    state.lastInjectAtMs = now;
                    return;
                }
            }

            state.lastInjectAtMs = now;
            debug("Continuation prompt sent successfully");
        } catch (error) {
            debug("Error sending continuation prompt", error);
        }
    }

    /**
     * Schedule an injection after delay.
     */
    function scheduleInjection(sessionID: string, delayMs?: number): void {
        const state = getState(sessionID);
        const actualDelay = delayMs ?? config.idleDelayMs;

        // Cancel any existing timer
        cancelPendingTimer(sessionID);

        debug("Scheduling injection", {
            sessionID,
            delayMs: actualDelay,
        });

        state.pendingInjectTimer = setTimeout(() => {
            state.pendingInjectTimer = null;
            maybeInject(sessionID).catch((error) => {
                debug("Error in scheduled maybeInject", error);
            });
        }, actualDelay);
    }

    /**
     * Reset injection counters for todos that are no longer pending.
     */
    function resetCompletedTodoCounters(
        sessionID: string,
        todos: Todo[],
    ): void {
        const state = sessionStates.get(sessionID);
        if (!state) return;

        const triggerStatuses = new Set(config.triggerStatuses);
        const pendingKeys = new Set(
            todos
                .filter((t) => triggerStatuses.has(t.status))
                .map((t) => getTodoKey(t)),
        );

        // Remove counters for todos that are no longer pending
        let changed = false;
        for (const key of state.perTodoInjectCount.keys()) {
            if (!pendingKeys.has(key)) {
                state.perTodoInjectCount.delete(key);
                debug("Reset counter for completed todo", { sessionID, key });
                changed = true;
            }
        }

        // If loop protection was triggered but the blocking todo is now complete,
        // we can reset it
        if (state.loopProtectionTriggered) {
            // Check if there are any pending todos that haven't hit the limit
            let hasUnblockedTodo = false;
            for (const todo of todos) {
                if (!triggerStatuses.has(todo.status)) continue;
                const key = getTodoKey(todo);
                const count = state.perTodoInjectCount.get(key) || 0;
                if (count < config.maxAutoSubmitsPerTodo) {
                    hasUnblockedTodo = true;
                    break;
                }
            }
            if (hasUnblockedTodo) {
                state.loopProtectionTriggered = false;
                debug("Reset loop protection, unblocked todos available", {
                    sessionID,
                });
                changed = true;
            }
        }
    }

    return {
        event: async ({ event }) => {
            // Handle todo.updated events
            if (event.type === "todo.updated") {
                const todoEvent = event as EventTodoUpdated;
                const { sessionID, todos } = todoEvent.properties;

                const state = getState(sessionID);
                const triggerStatuses = new Set(config.triggerStatuses);
                const hasPending = todos.some((todo) =>
                    triggerStatuses.has(todo.status),
                );
                state.hasPending = hasPending;

                // Reset counters for completed todos
                resetCompletedTodoCounters(sessionID, todos);

                // If no pending todos, cleanup
                if (!hasPending) {
                    cleanupSession(sessionID);
                }

                return;
            }

            // Primary trigger: session.idle
            if (event.type === "session.idle") {
                const idleEvent = event as EventSessionIdle;
                const { sessionID } = idleEvent.properties;

                const state = getState(sessionID);

                debug("session.idle received", {
                    sessionID,
                    hasPending: state.hasPending,
                });

                // Only schedule if we have pending todos
                if (state.hasPending) {
                    scheduleInjection(sessionID);
                }
                return;
            }

            // Cancel pending injection on user message activity only
            if (event.type === "message.updated") {
                const msgEvent = event as EventMessageUpdated;
                const { info } = msgEvent.properties;

                const state = getState(info.sessionID);

                // Only cancel on USER messages (new user activity)
                if (info.role === "user") {
                    debug("User message; cancelling pending injection", {
                        sessionID: info.sessionID,
                        messageID: info.id,
                    });
                    cancelPendingTimer(info.sessionID);

                    // Track agent and model from user messages
                    const userInfo = info as any;
                    if (userInfo.agent) {
                        state.lastUserAgent = userInfo.agent;
                    }
                    if (userInfo.model) {
                        state.lastUserModel = userInfo.model;
                    }
                }
                // Assistant messages are ignored for cancellation purposes
                return;
            }

            // Ignore message.part.updated entirely for cancellation
            if (event.type === "message.part.updated") {
                return;
            }

            // Handle session deletion for cleanup
            if (event.type === "session.deleted") {
                const deletedEvent = event as EventSessionDeleted;
                const sessionID = deletedEvent.properties.info.id;
                cleanupSession(sessionID);
                return;
            }
        },

    };
};
