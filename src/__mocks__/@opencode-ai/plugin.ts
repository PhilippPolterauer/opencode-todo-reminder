/**
 * Mock for @opencode-ai/plugin package
 * Provides type definitions without the broken ESM exports
 */

export interface PluginInput {
    client: any;
    project: any;
    directory: string;
    worktree: string;
    serverUrl: URL;
    $: any;
}

export interface Hooks {
    event?: (input: { event: any }) => Promise<void>;
    "experimental.text.complete"?: (
        input: { sessionID: string; messageID: string; partID: string },
        output: { text: string },
    ) => Promise<void>;
    [key: string]: any;
}

export type Plugin = (input: PluginInput) => Promise<Hooks>;
