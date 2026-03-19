import { type Plugin } from "@opencode-ai/plugin";
import { type Todo } from "@opencode-ai/sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";

// === DEBUG LOGGING ===

let debugEnabled = false;
let debugLogPath: string | null = null;

const PROMPT_GUARD_INSTALLED_KEY = "__todoReminderPromptGuardInstalled";
const PROMPT_GUARD_MATCHERS_KEY = "__todoReminderPromptGuardMatchers";

type PromptGuardMatcher = (options: unknown) => boolean;

type PromptFunction = (options: unknown) => Promise<unknown>;

interface PromptGuardedSession {
    prompt: PromptFunction;
    [PROMPT_GUARD_INSTALLED_KEY]?: boolean;
    [PROMPT_GUARD_MATCHERS_KEY]?: PromptGuardMatcher[];
}

function escapeRegexLiteral(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createReminderMessagePattern(template: string): RegExp {
    const escapedTemplate = escapeRegexLiteral(template);
    const withPlaceholders = escapedTemplate
        .replace(/\\\{total\\\}/g, "\\d+")
        .replace(/\\\{completed\\\}/g, "\\d+")
        .replace(/\\\{pending\\\}/g, "\\d+")
        .replace(/\\\{remaining\\\}/g, "\\d+");

    return new RegExp(`^${withPlaceholders}$`);
}

function getPromptPayload(
    options: unknown,
): { sessionID: string; text: string } | null {
    if (!options || typeof options !== "object") {
        return null;
    }

    const typedOptions = options as {
        path?: { id?: unknown };
        body?: {
            parts?: Array<{ type?: unknown; text?: unknown }>;
        };
    };

    const sessionID = typedOptions.path?.id;
    if (typeof sessionID !== "string") {
        return null;
    }

    const parts = typedOptions.body?.parts;
    if (!Array.isArray(parts) || parts.length !== 1) {
        return null;
    }

    const [part] = parts;
    if (!part || part.type !== "text" || typeof part.text !== "string") {
        return null;
    }

    return {
        sessionID,
        text: part.text,
    };
}

function installPromptGuard(client: unknown, matcher: PromptGuardMatcher): void {
    const typedClient = client as { session?: unknown };
    const session = typedClient.session as PromptGuardedSession | undefined;

    if (!session || typeof session.prompt !== "function") {
        return;
    }

    const promptFn = session.prompt as PromptFunction & { mock?: unknown };

    // Keep tests simple: vitest mocks expose `mock` and should not be wrapped.
    if (typeof promptFn.mock !== "undefined") {
        return;
    }

    if (!Array.isArray(session[PROMPT_GUARD_MATCHERS_KEY])) {
        session[PROMPT_GUARD_MATCHERS_KEY] = [];
    }
    session[PROMPT_GUARD_MATCHERS_KEY]?.push(matcher);

    if (session[PROMPT_GUARD_INSTALLED_KEY]) {
        return;
    }

    const originalPrompt = session.prompt.bind(session);

    session.prompt = async (options: unknown): Promise<unknown> => {
        const matchers = session[PROMPT_GUARD_MATCHERS_KEY] ?? [];
        for (const shouldBlock of matchers) {
            if (shouldBlock(options)) {
                return { data: { info: {} } };
            }
        }

        return originalPrompt(options);
    };

    session[PROMPT_GUARD_INSTALLED_KEY] = true;
}

function isMessageAbortedError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
        return false;
    }
    const maybeError = error as { name?: unknown };
    return maybeError.name === "MessageAbortedError";
}

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

    async function showInterruptionPausedToast(): Promise<void> {
        if (!config.useToasts) {
            return;
        }

        try {
            await client.tui.showToast({
                query: { directory },
                body: {
                    title: "TODO Reminder Paused",
                    message:
                        "No reminder will be fired because you interrupted the last response. Send a new message to resume reminders.",
                    variant: "info",
                },
            });
        } catch (e) {
            log("Interruption toast error (ignored)", String(e));
        }
    }

    async function pauseSessionAfterAbort(
        sessionID: string,
        source: string,
    ): Promise<void> {
        const wasPaused = abortedSessions.has(sessionID);
        abortedSessions.add(sessionID);
        cancelTimer(sessionID);
        log("SESSION ABORTED by user", { sessionID, source, wasPaused });

        if (!wasPaused) {
            await showInterruptionPausedToast();
        }
    }

    const reminderMessagePattern = createReminderMessagePattern(config.messageFormat);

    installPromptGuard(client, (options: unknown): boolean => {
        const payload = getPromptPayload(options);
        if (!payload) {
            return false;
        }

        if (!abortedSessions.has(payload.sessionID)) {
            return false;
        }

        if (!reminderMessagePattern.test(payload.text)) {
            return false;
        }

        log("PROMPT GUARD BLOCKED reminder on paused session", {
            sessionID: payload.sessionID,
        });
        return true;
    });

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

        if (abortedSessions.has(sessionID)) {
            log("INJECT SKIPPED - session paused after abort", { sessionID });
            return;
        }

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
            if (abortedSessions.has(sessionID)) {
                log("PROMPT SKIPPED - session paused after abort", { sessionID });
                return;
            }

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

            const promptResponse = await client.session.prompt({
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

            const promptError = (promptResponse as {
                data?: { info?: { error?: unknown } };
            }).data?.info?.error;
            if (isMessageAbortedError(promptError)) {
                log("PROMPT RESULT ABORTED", { sessionID });
                await pauseSessionAfterAbort(sessionID, "prompt-response");
                return;
            }

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
                    log("SKIP INJECT - session paused after user abort", { sessionID });
                    cancelTimer(sessionID);
                    return;
                }

                scheduleInject(sessionID);
            }

            if (event.type === "message.updated") {
                // User sent a new message - cancel any pending reminder and clear abort state
                const { info } = event.properties as {
                    info: {
                        sessionID: string;
                        role: string;
                        id: string;
                        error?: { name?: string };
                    };
                };

                if (
                    info.role === "assistant" &&
                    isMessageAbortedError(info.error)
                ) {
                    log("ASSISTANT MESSAGE ABORTED", { sessionID: info.sessionID });
                    await pauseSessionAfterAbort(info.sessionID, "message-updated");
                    return;
                }

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
                    error?: { name?: string };
                };
                if (sessionID && isMessageAbortedError(error)) {
                    await pauseSessionAfterAbort(sessionID, "session-error");
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
