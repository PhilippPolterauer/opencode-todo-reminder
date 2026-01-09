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
     * @default "Incomplete tasks remain in your todo list.\nContinue working on the next pending task now; do not ask for permission; mark tasks complete when done.\n\nStatus: {completed}/{total} completed, {remaining} remaining."
     */
    messageFormat: z
        .string()
        .optional()
        .default(
            "Incomplete tasks remain in your todo list.\n" +
            "Continue working on the next pending task now; do not ask for permission; mark tasks complete when done.\n\n" +
            "Status: {completed}/{total} completed, {remaining} remaining."
        ),

    /**
     * Whether to show toast notifications (only if TUI supports it).
     * @default true
     */
    useToasts: z.boolean().optional().default(true),

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
        "Continue working on the next pending task now; do not ask for permission; mark tasks complete when done.\n\n" +
        "Status: {completed}/{total} completed, {remaining} remaining.",
    useToasts: true,
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
