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
        .replace(/\\\{remaining\\\}/g, "\\d+")
        .replace(/\\\{current_task\\\}/g, "[\\s\\S]*")
        .replace(/\\\{orphan_table\\\}/g, "[\\s\\S]*");

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

// True for ANY assistant-message error, not just user-initiated aborts.
// opencode's processor.halt() sets assistantMessage.error identically for a
// deny-rule tool-permission block (Effect.orDie -> defect -> halt, verified
// in session/tools.ts + processor.ts:596-624) as it does for an escape-key
// abort - both flip session status to idle via the same code path. Filtering
// on MessageAbortedError alone let that error case fall through as ordinary
// idle, unpaused. NOTE: this does not address the separate, likely more
// common case of the reminder firing on a normal idle mid-task with no error
// at all - that is the plugin's underlying idle-triggers-reminder design and
// is out of scope here.
function hasAssistantMessageError(error: unknown): boolean {
    return !!error && typeof error === "object";
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
    const abortedSessions = new Set<string>(); // sessions paused: user abort OR any assistant-message error (e.g. permission denial)
    const orphanTableCache = new Map<string, string>(); // sessionID -> cached {orphan_table} text, scanned once per session lifetime

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
                        "No reminder will be fired because the last response was interrupted or ended in an error. Send a new message to resume reminders.",
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

    const reminderMessagePatterns = [
        createReminderMessagePattern(config.messageFormat),
        createReminderMessagePattern(config.inProgressMessageFormat),
    ];

    installPromptGuard(client, (options: unknown): boolean => {
        const payload = getPromptPayload(options);
        if (!payload) {
            return false;
        }

        if (!abortedSessions.has(payload.sessionID)) {
            return false;
        }

        if (!reminderMessagePatterns.some((pattern) => pattern.test(payload.text))) {
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
    // Session IDs change on every new/resumed/compacted session, and
    // opencode's todo table has no cross-session linkage of its own -
    // once a session ends, its incomplete todos just sit in the DB
    // forever unless something specifically goes looking. Rather than a
    // separate toast/notification path, this is folded directly into the
    // existing periodic reminder text via {orphan_table} - scanned once
    // per session lifetime (cached, not re-scanned on every reminder),
    // and only ever appended to a message this session was already
    // going to receive. Never sent as its own standalone message -
    // another session's leftover plan is not this session's plan.
    async function getOrphanedTodoTable(sessionID: string): Promise<string> {
        if (!config.warnOrphanedTodos) return "";
        if (orphanTableCache.has(sessionID)) return orphanTableCache.get(sessionID) ?? "";

        let sessions: Array<{ id: string; title: string; time: { updated: number } }>;
        try {
            const resp = await client.session.list({ query: { directory } });
            sessions = Array.isArray(resp.data) ? (resp.data as typeof sessions) : [];
        } catch (e) {
            log("getOrphanedTodoTable: failed to list sessions", String(e));
            return "";
        }

        const candidates = sessions
            .filter((s) => s.id !== sessionID)
            .sort((a, b) => b.time.updated - a.time.updated)
            .slice(0, config.orphanScanLimit);

        const openCounts = new Map<string, number>();
        for (const candidate of candidates) {
            try {
                const resp = await client.session.todo({ path: { id: candidate.id } });
                const todos = Array.isArray(resp.data) ? resp.data : [];
                const openCount = todos.filter(
                    (t) => t.status === "pending" || t.status === "in_progress",
                ).length;
                if (openCount > 0) {
                    openCounts.set(candidate.id, openCount);
                }
            } catch (e) {
                log("getOrphanedTodoTable: failed to fetch todos for candidate", {
                    sessionID: candidate.id,
                    error: String(e),
                });
            }
        }

        let table = "";
        if (openCounts.size > 0) {
            const rows = [...openCounts.entries()]
                .map(([id, count]) => `${id} - ${count} open`)
                .join("\n");
            table = `\n\nOrphaned todos in other sessions (never revisited):\n${rows}`;
        }

        orphanTableCache.set(sessionID, table);
        log("getOrphanedTodoTable: scanned", {
            sessionID,
            checked: candidates.length,
            sessionsWithOrphans: openCounts.size,
        });
        return table;
    }

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

        // No pending todos = nothing to do. Orphaned todos in OTHER
        // sessions aren't checked here - they only ride along on a
        // reminder this session was already going to send (below), never
        // as a reason to send one on their own.
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

        // Build the reminder message using the configured format.
        // A todo already marked in_progress means the model was mid-task,
        // not idle-and-stuck - messageFormat's "next pending task" wording
        // is wrong there (reads as "move on" when it should be "finish
        // this one"), so use inProgressMessageFormat instead.
        const completed = todos.filter(
            (t) => t.status === "completed" || t.status === "cancelled",
        ).length;
        const inProgressTodo = pending.find((t) => t.status === "in_progress");
        const template = inProgressTodo
            ? config.inProgressMessageFormat
            : config.messageFormat;
        const orphanTable = await getOrphanedTodoTable(sessionID);
        const message = template
            .replace(/\{total\}/g, String(todos.length))
            .replace(/\{completed\}/g, String(completed))
            .replace(/\{pending\}/g, String(pending.length))
            .replace(/\{remaining\}/g, String(pending.length))
            .replace(/\{current_task\}/g, inProgressTodo?.content ?? "")
            .replace(/\{orphan_table\}/g, orphanTable);

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

    // Guard against opencode's todowrite tool silently dropping unfinished
    // todos. Verified in opencode source: SessionTodo.Service.update does a
    // full delete-then-insert of whatever `todos` array it's given - no
    // merge, no diffing against the prior list. Todo has no stable id
    // (packages/schema/src/session-todo.ts: content/status/priority only),
    // so the only identity available for matching across calls is the
    // content string. If the model's new TodoWrite call omits a todo that
    // was pending/in_progress, that todo is gone with no warning. This
    // backfills it before the call reaches opencode - it does NOT let the
    // model send an intentionally partial list (its tool description still
    // says "the updated todo list"), it only stops accidental loss.
    async function guardTodoWrite(
        input: { tool: string; sessionID: string; callID: string },
        output: { args: any },
    ): Promise<void> {
        if (!config.preserveUnfinishedTodos) return;
        if (input.tool !== "todowrite") return;

        const proposed = output.args?.todos;
        if (!Array.isArray(proposed)) return;

        let current: Todo[];
        try {
            const resp = await client.session.todo({ path: { id: input.sessionID } });
            current = Array.isArray(resp.data) ? resp.data : [];
        } catch (e) {
            log("guardTodoWrite: failed to fetch current todos", String(e));
            return;
        }

        const proposedContents = new Set(
            proposed
                .map((t) => (t && typeof t === "object" ? (t as { content?: unknown }).content : undefined))
                .filter((c): c is string => typeof c === "string"),
        );

        const dropped = current.filter(
            (t) =>
                (t.status === "pending" || t.status === "in_progress") &&
                !proposedContents.has(t.content),
        );

        if (dropped.length === 0) return;

        log("guardTodoWrite: backfilling dropped unfinished todos", {
            sessionID: input.sessionID,
            dropped: dropped.map((t) => t.content),
        });

        output.args.todos = [...proposed, ...dropped];
    }

    // Handle events
    return {
        "tool.execute.before": guardTodoWrite,
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
                    hasAssistantMessageError(info.error)
                ) {
                    log("ASSISTANT MESSAGE ERRORED", {
                        sessionID: info.sessionID,
                        errorName: (info.error as { name?: unknown })?.name,
                    });
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
                // Any session-level error (user abort, permission denial,
                // provider error, etc.) halts the turn and flips status to
                // idle via the same opencode code path - pause reminders for
                // all of them, not just escape-key aborts.
                const { sessionID, error } = event.properties as {
                    sessionID?: string;
                    error?: { name?: string };
                };
                if (sessionID && hasAssistantMessageError(error)) {
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
                orphanTableCache.delete(info.id);
            }
        },
    };
};
