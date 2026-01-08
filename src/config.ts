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
     * @default 1500
     */
    idleDelayMs: z.number().optional().default(1500),

    /**
     * Minimum time in milliseconds between auto-injections per session.
     * Prevents rapid-fire prompts.
     * @default 15000
     */
    cooldownMs: z.number().optional().default(15000),

    /**
     * Whether to include progress information (X/Y completed, Z remaining) in the prompt.
     * @default true
     */
    includeProgressInPrompt: z.boolean().optional().default(true),

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
});

export type TodoReminderConfig = z.infer<typeof TodoReminderConfigSchema>;

const DEFAULT_CONFIG: Required<TodoReminderConfig> = {
    enabled: true,
    triggerStatuses: ["pending", "in_progress", "open"],
    maxAutoSubmitsPerTodo: 3,
    idleDelayMs: 1500,
    cooldownMs: 15000,
    includeProgressInPrompt: true,
    useToasts: true,
    syntheticPrompt: false,
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
