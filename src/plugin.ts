import { type Plugin } from "@opencode-ai/plugin";
import { type Todo } from "@opencode-ai/sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";

// === DEBUG LOGGING ===

let debugEnabled = false;
let debugLogPath: string | null = null;

function setupDebug(directory: string | undefined, enabled: boolean): void {
    debugEnabled = enabled;
    if (enabled && directory) {
        const dir = join(directory, ".opencode");
        try {
            mkdirSync(dir, { recursive: true });
        } catch {
            /* ok */
        }
        debugLogPath = join(dir, "todo-reminder.log");
    }
}

function log(...args: unknown[]): void {
    if (!debugEnabled || !debugLogPath) return;
    const time = new Date().toISOString();
    const msg = args
        .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
        .join(" ");
    try {
        appendFileSync(debugLogPath, `${time} ${msg}\n`);
    } catch {
        /* ok */
    }
}

// === PLUGIN ===

export const TodoReminderPlugin: Plugin = async ({ client, directory }) => {
    const config = loadConfig(directory);
    setupDebug(directory, config.debug);

    log("=== PLUGIN START ===", { config });

    // Simple state per session
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const injectCounts = new Map<string, number>();
    const lastSnapshots = new Map<string, string>();
    const seenUserMsgs = new Map<string, string>(); // sessionID -> last user message ID
    const abortedSessions = new Set<string>(); // sessions aborted by user (escape key)

    // Make a snapshot string from todos (to detect changes)
    function snapshot(todos: Todo[]): string {
        return todos
            .map((t) => `${t.id}:${t.status}`)
            .sort()
            .join(",");
    }

    // Cancel any pending timer
    function cancelTimer(sessionID: string): void {
        const t = timers.get(sessionID);
        if (t) {
            clearTimeout(t);
            timers.delete(sessionID);
            log("TIMER CANCELLED", { sessionID });
        }
    }

    // The main inject function - runs when session is idle
    async function inject(sessionID: string): Promise<void> {
        log(">>> INJECT", { sessionID });

        if (!config.enabled) {
            log("Plugin disabled, skip");
            return;
        }

        // Get todos from API
        let todos: Todo[];
        try {
            const resp = await client.session.todo({ path: { id: sessionID } });
            todos = Array.isArray(resp.data) ? resp.data : [];
        } catch (e) {
            log("Error fetching todos", String(e));
            return;
        }

        // Which todos are still pending?
        const validStatuses = new Set(config.triggerStatuses);
        const pending = todos.filter((t) => validStatuses.has(t.status));

        log("Todos", {
            total: todos.length,
            pending: pending.length,
            statuses: todos.map((t) => t.status),
        });

        // No pending todos = nothing to do
        if (pending.length === 0) {
            log("No pending todos, done");
            injectCounts.delete(sessionID);
            lastSnapshots.delete(sessionID);
            return;
        }

        // Check if todos changed since last time
        const currentSnapshot = snapshot(todos);
        const lastSnapshot = lastSnapshots.get(sessionID);

        if (lastSnapshot && lastSnapshot !== currentSnapshot) {
            // Something changed! Reset the counter.
            log("CHANGE DETECTED - resetting counter", {
                was: lastSnapshot,
                now: currentSnapshot,
            });
            injectCounts.set(sessionID, 0);
        }

        // Save current snapshot for next time
        lastSnapshots.set(sessionID, currentSnapshot);

        // Loop protection: don't inject too many times without progress
        const count = injectCounts.get(sessionID) || 0;
        if (count >= config.maxAutoSubmitsPerTodo) {
            log("LOOP PROTECTION - too many injects without progress", {
                count,
            });

            // Show warning toast
            if (config.useToasts) {
                try {
                    await client.tui.showToast({
                        query: { directory },
                        body: {
                            title: "TODO Reminder Paused",
                            message: `No progress after ${count} reminders. Complete a task to resume.`,
                            variant: "warning",
                        },
                    });
                } catch (e) {
                    log("Toast error (ignored)", String(e));
                }
            }
            return;
        }

        // Build the reminder message using the configured format
        const completed = todos.filter(
            (t) => t.status === "completed" || t.status === "cancelled",
        ).length;
        const message = config.messageFormat
            .replace(/\{total\}/g, String(todos.length))
            .replace(/\{completed\}/g, String(completed))
            .replace(/\{pending\}/g, String(pending.length))
            .replace(/\{remaining\}/g, String(pending.length));

        // Send it!
        log("SENDING PROMPT", { message });
        try {
            // Show toast if enabled
            if (config.useToasts) {
                try {
                    await client.tui.showToast({
                        query: { directory },
                        body: {
                            title: "TODO Reminder",
                            message: `${pending.length} task(s) remaining`,
                            variant: "info",
                        },
                    });
                } catch (e) {
                    log("Toast error (ignored)", String(e));
                }
            }

            await client.session.prompt({
                path: { id: sessionID },
                query: { directory },
                body: {
                    parts: [
                        {
                            type: "text",
                            text: message,
                            synthetic: config.syntheticPrompt,
                        },
                    ],
                },
            });
            injectCounts.set(sessionID, count + 1);
            log("SENT OK", { newCount: count + 1 });
        } catch (e) {
            log("Error sending prompt", String(e));
        }
    }

    // Schedule inject after a short delay
    function scheduleInject(sessionID: string): void {
        cancelTimer(sessionID);
        log("SCHEDULING", { sessionID, delayMs: config.idleDelayMs });
        const t = setTimeout(() => {
            timers.delete(sessionID);
            inject(sessionID).catch((e) => log("inject error", String(e)));
        }, config.idleDelayMs);
        timers.set(sessionID, t);
    }

    // Handle events
    return {
        event: async ({ event }) => {
            // log("EVENT", event.type, event.properties);

            if (event.type === "session.idle") {
                // Session went idle - schedule a reminder (unless aborted by user)
                const { sessionID } = event.properties as { sessionID: string };

                // Check if this session was aborted (user pressed escape)
                if (abortedSessions.has(sessionID)) {
                    log("SKIP INJECT - session was aborted by user", { sessionID });
                    abortedSessions.delete(sessionID);
                    cancelTimer(sessionID);
                    return;
                }

                scheduleInject(sessionID);
            }

            if (event.type === "message.updated") {
                // User sent a new message - cancel any pending reminder and clear abort state
                const { info } = event.properties as {
                    info: { sessionID: string; role: string; id: string };
                };
                if (info.role === "user") {
                    // Only react to NEW messages (not duplicates)
                    if (seenUserMsgs.get(info.sessionID) !== info.id) {
                        seenUserMsgs.set(info.sessionID, info.id);
                        cancelTimer(info.sessionID);
                        // Clear abort state - user is actively engaging again
                        abortedSessions.delete(info.sessionID);
                        // Reset inject counter - user engagement resets loop protection
                        injectCounts.set(info.sessionID, 0);
                        log("USER MESSAGE - reset inject counter", { sessionID: info.sessionID });
                    }
                }
            }

            if (event.type === "session.error") {
                // Check if this is a user abort (escape key pressed)
                const { sessionID, error } = event.properties as {
                    sessionID?: string;
                    error?: { name: string };
                };
                if (sessionID && error?.name === "MessageAbortedError") {
                    log("SESSION ABORTED by user", { sessionID });
                    abortedSessions.add(sessionID);
                    cancelTimer(sessionID);
                }
            }

            if (event.type === "session.deleted") {
                // Clean up
                const { info } = event.properties as { info: { id: string } };
                cancelTimer(info.id);
                injectCounts.delete(info.id);
                lastSnapshots.delete(info.id);
                seenUserMsgs.delete(info.id);
                abortedSessions.delete(info.id);
            }
        },
    };
};
