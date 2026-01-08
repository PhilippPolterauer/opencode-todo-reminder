import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: false,
        environment: "node",
        include: ["src/**/*.test.ts"],
        coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            exclude: ["src/**/*.test.ts"],
        },
        alias: {
            // Mock the broken ESM exports from @opencode-ai packages
            "@opencode-ai/plugin": new URL(
                "./src/__mocks__/@opencode-ai/plugin.ts",
                import.meta.url,
            ).pathname,
            "@opencode-ai/sdk": new URL(
                "./src/__mocks__/@opencode-ai/sdk.ts",
                import.meta.url,
            ).pathname,
        },
    },
});
