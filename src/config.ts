import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TodoReminderConfig {
    /**
     * Whether the plugin is enabled
     * @default true
     */
    enabled?: boolean;

    /**
     * The reminder message to use
     * @default "You have open todos. Please continue working on them until they are completed."
     */
    message?: string;

    /**
     * Marker used to separate reminder from content (mostly for "append" mode)
     * @default "--- todo-reminder ---"
     */
    marker?: string;

    /**
     * Todo statuses that trigger the reminder
     * @default ["pending", "in_progress", "open"]
     */
    triggerStatuses?: string[];

    /**
     * Max number of auto-submits per TODO to prevent infinite loops
     * @default 3
     */
    maxAutoSubmitsPerTodo?: number;

    /**
     * Delay in milliseconds before injecting a continuation prompt after session becomes idle.
     * Prevents racing with late events.
     * @default 1500
     */
    idleDelayMs?: number;

    /**
     * Minimum time in milliseconds between auto-injections per session.
     * Prevents rapid-fire prompts.
     * @default 15000
     */
    cooldownMs?: number;

    /**
     * Whether to include progress information (X/Y completed, Z remaining) in the prompt.
     * @default true
     */
    includeProgressInPrompt?: boolean;

    /**
     * Whether to show toast notifications (only if TUI supports it).
     * @default false
     */
    useToasts?: boolean;
}

const DEFAULT_CONFIG: Required<TodoReminderConfig> = {
    enabled: true,
    message:
        "You have open todos. Please continue working on them until they are completed.",
    marker: "--- todo-reminder ---",
    triggerStatuses: ["pending", "in_progress", "open"],
    maxAutoSubmitsPerTodo: 3,
    idleDelayMs: 1500,
    cooldownMs: 15000,
    includeProgressInPrompt: true,
    useToasts: false,
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
            const userConfig = JSON.parse(content) as TodoReminderConfig;
            return { ...DEFAULT_CONFIG, ...userConfig };
        } catch {
            continue;
        }
    }

    return DEFAULT_CONFIG;
}
