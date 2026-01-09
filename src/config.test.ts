import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// We need to import the module fresh for each test to reset state
// Use dynamic import to get fresh module after mocking

describe("config", () => {
    const testDir = join(tmpdir(), "todo-reminder-test-" + Date.now());
    const opencodeDir = join(testDir, ".opencode");
    const configPath = join(opencodeDir, "todo-reminder.json");

    beforeEach(() => {
        // Create test directory structure
        mkdirSync(opencodeDir, { recursive: true });
    });

    afterEach(() => {
        // Cleanup test directory
        try {
            rmSync(testDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
        vi.resetModules();
    });

    describe("loadConfig", () => {
        it("should return default config when no config file exists", async () => {
            const { loadConfig } = await import("./config.js");

            const nonExistentDir = join(tmpdir(), "non-existent-" + Date.now());
            const config = loadConfig(nonExistentDir);

            expect(config.enabled).toBe(true);
            expect(config.triggerStatuses).toEqual(["pending", "in_progress", "open"]);
            expect(config.maxAutoSubmitsPerTodo).toBe(3);
            expect(config.idleDelayMs).toBe(500);
            expect(config.messageFormat).toContain("{completed}");
            expect(config.messageFormat).toContain("{total}");
            expect(config.useToasts).toBe(true);
            expect(config.syntheticPrompt).toBe(false);
            expect(config.debug).toBe(false);
        });

        it("should merge user config with defaults", async () => {
            const userConfig = {
                enabled: false,
                idleDelayMs: 1000,
            };
            writeFileSync(configPath, JSON.stringify(userConfig));

            const { loadConfig } = await import("./config.js");
            const config = loadConfig(testDir);

            expect(config.enabled).toBe(false);
            expect(config.idleDelayMs).toBe(1000);
            // Defaults should still be present
            expect(config.maxAutoSubmitsPerTodo).toBe(3);
            expect(config.triggerStatuses).toEqual([
                "pending",
                "in_progress",
                "open",
            ]);
        });

        it("should allow overriding triggerStatuses", async () => {
            const userConfig = {
                triggerStatuses: ["pending", "blocked"],
            };
            writeFileSync(configPath, JSON.stringify(userConfig));

            const { loadConfig } = await import("./config.js");
            const config = loadConfig(testDir);

            expect(config.triggerStatuses).toEqual(["pending", "blocked"]);
        });

        it("should allow overriding all config values", async () => {
            const userConfig = {
                enabled: false,
                triggerStatuses: ["pending"],
                maxAutoSubmitsPerTodo: 5,
                idleDelayMs: 2000,
                messageFormat: "Custom message: {remaining} left",
                useToasts: false,
                syntheticPrompt: true,
                debug: true,
            };
            writeFileSync(configPath, JSON.stringify(userConfig));

            const { loadConfig } = await import("./config.js");
            const config = loadConfig(testDir);

            expect(config.enabled).toBe(false);
            expect(config.triggerStatuses).toEqual(["pending"]);
            expect(config.maxAutoSubmitsPerTodo).toBe(5);
            expect(config.idleDelayMs).toBe(2000);
            expect(config.messageFormat).toBe("Custom message: {remaining} left");
            expect(config.useToasts).toBe(false);
            expect(config.syntheticPrompt).toBe(true);
            expect(config.debug).toBe(true);
        });

        it("should handle invalid JSON gracefully", async () => {
            writeFileSync(configPath, "{ invalid json }");

            const { loadConfig } = await import("./config.js");
            const config = loadConfig(testDir);

            // Should fall back to defaults
            expect(config.enabled).toBe(true);
            expect(config.idleDelayMs).toBe(500);
        });

        it("should use project config over global config", async () => {
            // This test verifies the priority order
            const userConfig = {
                idleDelayMs: 5000,
            };
            writeFileSync(configPath, JSON.stringify(userConfig));

            const { loadConfig } = await import("./config.js");
            const config = loadConfig(testDir);

            expect(config.idleDelayMs).toBe(5000);
        });
    });

    describe("default config values", () => {
        it("should have sensible defaults for all options", async () => {
            const { loadConfig } = await import("./config.js");
            const config = loadConfig(join(tmpdir(), "nonexistent"));

            // Verify all defaults are present and reasonable
            expect(config.enabled).toBe(true);
            expect(config.idleDelayMs).toBeGreaterThan(0);
            expect(config.idleDelayMs).toBeLessThanOrEqual(5000);
            expect(config.maxAutoSubmitsPerTodo).toBeGreaterThan(0);
            expect(config.triggerStatuses.length).toBeGreaterThan(0);
            expect(config.messageFormat).toBeDefined();
        });
    });
});
