/**
 * Mock for @opencode-ai/sdk package
 * Provides type definitions without the broken ESM exports
 */

export interface Todo {
    id: string;
    content: string;
    status: string;
    priority: string;
}

export interface EventTodoUpdated {
    type: "todo.updated";
    properties: {
        sessionID: string;
        todos: Todo[];
    };
}

export interface EventSessionIdle {
    type: "session.idle";
    properties: {
        sessionID: string;
    };
}

export interface EventSessionDeleted {
    type: "session.deleted";
    properties: {
        info: {
            id: string;
            projectID: string;
            directory: string;
            title: string;
            version: string;
            time: {
                created: number;
                updated: number;
            };
        };
    };
}

export interface EventMessageUpdated {
    type: "message.updated";
    properties: {
        info: {
            id: string;
            sessionID: string;
            role: "user" | "assistant";
            [key: string]: any;
        };
    };
}

export interface EventMessagePartUpdated {
    type: "message.part.updated";
    properties: {
        part: {
            id: string;
            sessionID: string;
            messageID: string;
            type: string;
            [key: string]: any;
        };
        delta?: string;
    };
}

export type Event =
    | EventTodoUpdated
    | EventSessionIdle
    | EventSessionDeleted
    | EventMessageUpdated
    | EventMessagePartUpdated
    | { type: string; properties: any };
