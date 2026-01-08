import { type Plugin } from "@opencode-ai/plugin";
import {
    type Todo,
    type EventTodoUpdated,
    type EventSessionIdle,
    type EventSessionDeleted,
    type EventMessageUpdated,
    type EventMessagePartUpdated,
} from "@opencode-ai/sdk";
import { loadConfig, type TodoReminderConfig } from "./config.js";

const DEBUG_PREFIX = "[TodoReminder]";

function debug(...args: unknown[]) {
    // Uncomment for debugging:
    // console.error(DEBUG_PREFIX, ...args);
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

    debug("Plugin initializing", { directory, config });

    // Runtime state per session
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
        if (state?.pendingInjectTimer) {
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
                                synthetic: true,
                            },
                        ],
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

        // Build and send the prompt
        const promptText = buildPromptText(config, pendingTodos, todos);
        debug("Sending continuation prompt", { sessionID, promptText });

        try {
            await client.session.prompt({
                path: { id: sessionID },
                query: { directory },
                body: {
                    parts: [
                        {
                            type: "text",
                            text: promptText,
                            synthetic: true,
                        },
                    ],
                },
            });
            state.lastInjectAtMs = now;
            debug("Continuation prompt sent successfully");
        } catch (error) {
            debug("Error sending continuation prompt", error);
        }
    }

    /**
     * Schedule an injection after idle delay.
     */
    function scheduleInjection(sessionID: string): void {
        const state = getState(sessionID);

        // Cancel any existing timer
        cancelPendingTimer(sessionID);

        debug("Scheduling injection", {
            sessionID,
            idleDelayMs: config.idleDelayMs,
        });

        state.pendingInjectTimer = setTimeout(() => {
            state.pendingInjectTimer = null;
            maybeInject(sessionID).catch((error) => {
                debug("Error in scheduled maybeInject", error);
            });
        }, config.idleDelayMs);
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
        for (const key of state.perTodoInjectCount.keys()) {
            if (!pendingKeys.has(key)) {
                state.perTodoInjectCount.delete(key);
                debug("Reset counter for completed todo", { sessionID, key });
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
            }
        }
    }

    return {
        event: async ({ event }) => {
            debug("Event received", { type: event.type });

            // Handle todo.updated events
            if (event.type === "todo.updated") {
                const todoEvent = event as EventTodoUpdated;
                const { sessionID, todos } = todoEvent.properties;

                debug("todo.updated event", {
                    sessionID,
                    todoCount: todos.length,
                });

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

                debug("Updated hasPending", { sessionID, hasPending });
                return;
            }

            // Primary trigger: session.idle
            if (event.type === "session.idle") {
                const idleEvent = event as EventSessionIdle;
                const { sessionID } = idleEvent.properties;

                debug("session.idle event", { sessionID });

                const state = getState(sessionID);

                // Only schedule if we know there are pending todos
                if (state.hasPending) {
                    scheduleInjection(sessionID);
                } else {
                    debug("No pending todos known, skipping schedule", {
                        sessionID,
                    });
                }
                return;
            }

            // Cancel pending injection on user activity (message from user)
            if (event.type === "message.updated") {
                const msgEvent = event as EventMessageUpdated;
                const { info } = msgEvent.properties;

                if (info.role === "user") {
                    debug("User message detected, cancelling pending injection", {
                        sessionID: info.sessionID,
                    });
                    cancelPendingTimer(info.sessionID);
                }
                return;
            }

            // Cancel pending injection on assistant generating (part update from assistant message)
            if (event.type === "message.part.updated") {
                const partEvent = event as EventMessagePartUpdated;
                const { part } = partEvent.properties;

                // Cancel timer if assistant is still generating
                // (any part update means activity)
                debug("message.part.updated, cancelling pending injection", {
                    sessionID: part.sessionID,
                });
                cancelPendingTimer(part.sessionID);
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

        // Fallback: experimental.text.complete
        // This runs when the LLM finishes generating, as a backup trigger
        // if session.idle is not available or fires inconsistently.
        "experimental.text.complete": async (input, _output) => {
            debug("text.complete hook called", {
                sessionID: input.sessionID,
                messageID: input.messageID,
            });

            if (!config.enabled) {
                debug("Plugin disabled, skipping");
                return;
            }

            const { sessionID } = input;
            const state = getState(sessionID);

            // If we don't know hasPending state yet, check it
            // This is a fallback path, so we may not have received todo.updated yet
            if (state.hasPending === false) {
                debug("hasPending is false, skipping text.complete fallback", {
                    sessionID,
                });
                return;
            }

            // Schedule injection (will be cancelled if session.idle fires first)
            // Use a slightly longer delay to let session.idle take precedence
            const originalDelay = config.idleDelayMs;
            const fallbackDelay = originalDelay + 500;

            cancelPendingTimer(sessionID);
            state.pendingInjectTimer = setTimeout(() => {
                state.pendingInjectTimer = null;
                maybeInject(sessionID).catch((error) => {
                    debug("Error in text.complete fallback maybeInject", error);
                });
            }, fallbackDelay);

            debug("Scheduled fallback injection from text.complete", {
                sessionID,
                fallbackDelay,
            });
        },
    };
};
