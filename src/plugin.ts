import { randomUUID } from "node:crypto";
import { type Plugin } from "@opencode-ai/plugin";
import { loadConfig } from "./config.js";

const PENDING_STATUSES = new Set(["in_progress", "pending"]);

type SessionTodo = {
    id: string;
    content: string;
    status: string;
    priority?: string;
};

const buildReminderText = (pendingTodos: SessionTodo[]) => {
    return [
        "<system-reminder>",
        `You have ${pendingTodos.length} pending todo(s):`,
        ...pendingTodos.map(todo => `- [ ] ${todo.content} (${todo.priority ?? "normal"})`),
        "",
        "Please review your progress and complete these tasks.",
        "</system-reminder>",
    ].join("\n");
};

export const TodoReminderPlugin: Plugin = async ({ client, directory }) => {
    const config = loadConfig(directory);

    if (config.enabled) {
        try {
            await client.tui.showToast({
                query: { directory },
                body: {
                    title: "Todo Reminder",
                    message: "Plugin loaded",
                    variant: "success",
                    duration: 2500,
                },
            });
        } catch {
            // Ignore toast failures to avoid disrupting the UI
        }
    }

    return {
        "experimental.chat.messages.transform": async (_input, output) => {
            if (!config.enabled) return;

            const userMessage = output.messages.findLast(
                message => message.info.role === "user"
            );
            if (!userMessage) return;

            try {
                const todoResp = await client.session.todo({
                    path: { id: userMessage.info.sessionID },
                });

                if (!todoResp.data || !Array.isArray(todoResp.data)) {
                    return;
                }

                const pendingTodos = todoResp.data.filter(todo =>
                    PENDING_STATUSES.has(todo.status)
                );

                if (pendingTodos.length === 0) {
                    return;
                }

                userMessage.parts.push({
                    id: randomUUID(),
                    messageID: userMessage.info.id,
                    sessionID: userMessage.info.sessionID,
                    type: "text",
                    text: buildReminderText(pendingTodos),
                    synthetic: true,
                });
            } catch (error) {
                // Silently fail to avoid disrupting the UI
                console.error("TodoReminderPlugin error:", error);
            }
        },
    };
};

export default TodoReminderPlugin;
