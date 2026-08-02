import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const TodoReminderConfigSchema = z.object({
    /**
     * Whether the plugin is enabled
     * @default true
     */
    enabled: z.boolean().optional().default(true),

    /**
     * Todo statuses that trigger the reminder
     * @default ["pending", "in_progress", "open"]
     */
    triggerStatuses: z
        .array(z.string())
        .optional()
        .default(["pending", "in_progress", "open"]),

    /**
     * Max number of auto-submits per TODO to prevent infinite loops
     * @default 3
     */
    maxAutoSubmitsPerTodo: z.number().optional().default(3),

    /**
     * Delay in milliseconds before injecting a continuation prompt after session becomes idle.
     * Prevents racing with late events.
     * @default 500
     */
    idleDelayMs: z.number().optional().default(500),

    /**
     * Custom message format for the reminder prompt.
     * Supports interpolation: {total}, {completed}, {pending}, {remaining}
     * @default "Incomplete tasks remain in your todo list.\nIf any are already done, call todowrite to mark them complete/cancelled first.\nKeep todo statuses current going forward - update each one via todowrite as soon as it is finished, not only when reminded.\nContinue working on the next pending task now; do not ask for permission; mark tasks complete when done.\n\nStatus: {completed}/{total} completed, {remaining} remaining.{orphan_table}"
     */
    messageFormat: z
        .string()
        .optional()
        .default(
            "Incomplete tasks remain in your todo list.\n" +
            "If any are already done, call todowrite to mark them complete/cancelled first.\n" +
            "Keep todo statuses current going forward - update each one via todowrite as soon as it is finished, not only when reminded.\n" +
            "Continue working on the next pending task now; do not ask for permission; mark tasks complete when done.\n\n" +
            "Status: {completed}/{total} completed, {remaining} remaining.{orphan_table}"
        ),

    /**
     * Message format used instead of messageFormat when one of the pending
     * todos already has status "in_progress" - i.e. the model was mid-task,
     * not idle-and-stuck. messageFormat's default wording ("continue on the
     * next pending task") is wrong in this case: it reads as an instruction
     * to move on, when the correct instruction is to finish the task
     * already underway. Supports the same interpolations as messageFormat,
     * plus {current_task} (the in_progress todo's content).
     * @default "You have an in-progress task: \"{current_task}\".\nIf it's already done, call todowrite to mark it complete first - otherwise continue working on THIS task until it's done; do not skip ahead to a different one or restart it. Keep todo statuses current going forward, not only when reminded. Mark it complete when finished.\n\nStatus: {completed}/{total} completed, {remaining} remaining.{orphan_table}"
     */
    inProgressMessageFormat: z
        .string()
        .optional()
        .default(
            "You have an in-progress task: \"{current_task}\".\n" +
            "If it's already done, call todowrite to mark it complete first - otherwise " +
            "continue working on THIS task until it's done; do not skip ahead to a different one or restart it. " +
            "Keep todo statuses current going forward, not only when reminded. Mark it complete when finished.\n\n" +
            "Status: {completed}/{total} completed, {remaining} remaining.{orphan_table}"
        ),

    /**
     * Whether to show toast notifications (only if TUI supports it).
     * @default true
     */
    useToasts: z.boolean().optional().default(true),

    /**
     * Whether TodoWrite calls are guarded against silently dropping
     * unfinished todos. opencode's todowrite tool fully replaces the
     * session's todo list on every call (delete-then-insert, verified in
     * opencode's session/todo.ts) - there is no merge, and Todo has no
     * stable id (verified in packages/schema/src/session-todo.ts: only
     * content/status/priority), so anything the model forgets to
     * re-include just disappears. When true, any todo the model didn't
     * mention in a new TodoWrite call, and whose prior status was
     * "pending" or "in_progress" (matched by exact content string - the
     * only identity available), is appended back before the call reaches
     * opencode. This does not let the model send a partial list on
     * purpose (its tool description still says "the updated todo list"),
     * it only stops accidental loss-by-omission.
     * @default true
     */
    preserveUnfinishedTodos: z.boolean().optional().default(true),

    /**
     * Whether to check for incomplete todos left behind in OTHER sessions
     * in this project when the CURRENT session has none of its own.
     * Session IDs change on every new/resumed/compacted session, and
     * opencode's todo table is keyed by session_id with no cross-session
     * carryover (verified: session table has project_id/parent_id, but
     * SessionTodo has no linkage of its own) - so a session's incomplete
     * todos, once that session ends, just sit in the DB forever unless
     * something specifically goes looking across sessions. Off by default:
     * this does extra API calls (session.list + one todo fetch per
     * candidate session) that the other fixes in this plugin don't need,
     * and surfaces information about possibly-abandoned/no-longer-relevant
     * old work, which can be noise as easily as it can be useful. When
     * enabled, this only shows a toast (does not inject anything into the
     * model's context) - old sessions' tasks are not this session's plan,
     * and should not be silently presented to the model as if they were.
     * @default false
     */
    warnOrphanedTodos: z.boolean().optional().default(false),

    /**
     * Upper bound on how many other sessions (most-recently-updated first)
     * to check for orphaned todos when warnOrphanedTodos is enabled. Bounds
     * API cost when a project has accumulated many past sessions.
     * @default 20
     */
    orphanScanLimit: z.number().optional().default(20),

    /**
     * Whether the injected prompt is synthetic (hidden from user)
     * @default false
     */
    syntheticPrompt: z.boolean().optional().default(false),

    /**
     * Enable debug logging to .opencode/todo-reminder.log
     * @default false
     */
    debug: z.boolean().optional().default(false),
});

export type TodoReminderConfig = z.infer<typeof TodoReminderConfigSchema>;

const DEFAULT_CONFIG: Required<TodoReminderConfig> = {
    enabled: true,
    triggerStatuses: ["pending", "in_progress", "open"],
    maxAutoSubmitsPerTodo: 3,
    idleDelayMs: 500,
    messageFormat:
        "Incomplete tasks remain in your todo list.\n" +
        "If any are already done, call todowrite to mark them complete/cancelled first.\n" +
        "Keep todo statuses current going forward - update each one via todowrite as soon as it is finished, not only when reminded.\n" +
        "Continue working on the next pending task now; do not ask for permission; mark tasks complete when done.\n\n" +
        "Status: {completed}/{total} completed, {remaining} remaining.{orphan_table}",
    inProgressMessageFormat:
        "You have an in-progress task: \"{current_task}\".\n" +
        "If it's already done, call todowrite to mark it complete first - otherwise " +
            "continue working on THIS task until it's done; do not skip ahead to a different one or restart it. " +
        "Keep todo statuses current going forward, not only when reminded. Mark it complete when finished.\n\n" +
        "Status: {completed}/{total} completed, {remaining} remaining.{orphan_table}",
    useToasts: true,
    preserveUnfinishedTodos: true,
    warnOrphanedTodos: false,
    orphanScanLimit: 20,
    syntheticPrompt: false,
    debug: false,
};

export function loadConfig(projectDir?: string): Required<TodoReminderConfig> {
    const paths: string[] = [];

    if (projectDir) {
        paths.push(join(projectDir, ".opencode", "todo-reminder.json"));
    } else {
        paths.push(join(process.cwd(), ".opencode", "todo-reminder.json"));
    }

    paths.push(join(homedir(), ".config", "opencode", "todo-reminder.json"));

    for (const configPath of paths) {
        try {
            const content = readFileSync(configPath, "utf-8");
            const userConfig = JSON.parse(content);
            const parsed = TodoReminderConfigSchema.parse(userConfig);
            return { ...DEFAULT_CONFIG, ...parsed } as Required<TodoReminderConfig>;
        } catch {
            continue;
        }
    }

    return DEFAULT_CONFIG;
}
