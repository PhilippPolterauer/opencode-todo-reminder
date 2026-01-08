import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Todo } from "@opencode-ai/sdk";
import {
    createSessionState,
    getTodoKey,
    buildPromptText,
    filterPendingTodos,
    TodoReminderPlugin,
} from "./plugin.js";
import type { TodoReminderConfig } from "./config.js";

// Helper to create a mock todo
function createTodo(overrides: Partial<Todo> = {}): Todo {
    return {
        id: "todo-1",
        content: "Test todo",
        status: "pending",
        priority: "medium",
        ...overrides,
    };
}

// Helper to create default config
function createConfig(
    overrides: Partial<TodoReminderConfig> = {},
): Required<TodoReminderConfig> {
    return {
        enabled: true,
        message: "Test message",
        marker: "---",
        triggerStatuses: ["pending", "in_progress", "open"],
        maxAutoSubmitsPerTodo: 3,
        idleDelayMs: 1500,
        cooldownMs: 15000,
        includeProgressInPrompt: true,
        useToasts: false,
        ...overrides,
    };
}

describe("plugin helper functions", () => {
    describe("createSessionState", () => {
        it("should create a fresh session state with correct defaults", () => {
            const state = createSessionState();

            expect(state.hasPending).toBe(false);
            expect(state.lastInjectAtMs).toBe(0);
            expect(state.pendingInjectTimer).toBeNull();
            expect(state.perTodoInjectCount).toBeInstanceOf(Map);
            expect(state.perTodoInjectCount.size).toBe(0);
            expect(state.loopProtectionTriggered).toBe(false);
        });

        it("should create independent state objects", () => {
            const state1 = createSessionState();
            const state2 = createSessionState();

            state1.hasPending = true;
            state1.perTodoInjectCount.set("todo-1", 5);

            expect(state2.hasPending).toBe(false);
            expect(state2.perTodoInjectCount.size).toBe(0);
        });
    });

    describe("getTodoKey", () => {
        it("should return id when present", () => {
            const todo = createTodo({ id: "my-id", content: "my content" });
            expect(getTodoKey(todo)).toBe("my-id");
        });

        it("should return content when id is empty string", () => {
            const todo = createTodo({ id: "", content: "my content" });
            expect(getTodoKey(todo)).toBe("my content");
        });

        it("should handle todos with only content", () => {
            const todo = createTodo({ id: "", content: "fallback content" });
            expect(getTodoKey(todo)).toBe("fallback content");
        });
    });

    describe("filterPendingTodos", () => {
        it("should filter todos by trigger statuses", () => {
            const todos: Todo[] = [
                createTodo({ id: "1", status: "pending" }),
                createTodo({ id: "2", status: "completed" }),
                createTodo({ id: "3", status: "in_progress" }),
                createTodo({ id: "4", status: "cancelled" }),
            ];

            const pending = filterPendingTodos(todos, [
                "pending",
                "in_progress",
            ]);

            expect(pending).toHaveLength(2);
            expect(pending.map((t) => t.id)).toEqual(["1", "3"]);
        });

        it("should return empty array when no matches", () => {
            const todos: Todo[] = [
                createTodo({ id: "1", status: "completed" }),
                createTodo({ id: "2", status: "cancelled" }),
            ];

            const pending = filterPendingTodos(todos, ["pending"]);

            expect(pending).toHaveLength(0);
        });

        it("should handle empty todos array", () => {
            const pending = filterPendingTodos([], ["pending"]);
            expect(pending).toHaveLength(0);
        });

        it("should handle custom trigger statuses", () => {
            const todos: Todo[] = [
                createTodo({ id: "1", status: "blocked" }),
                createTodo({ id: "2", status: "pending" }),
            ];

            const pending = filterPendingTodos(todos, ["blocked"]);

            expect(pending).toHaveLength(1);
            expect(pending[0]!.id).toBe("1");
        });
    });

    describe("buildPromptText", () => {
        it("should build basic prompt without progress when disabled", () => {
            const config = createConfig({ includeProgressInPrompt: false });
            const pendingTodos = [createTodo()];
            const allTodos = [createTodo()];

            const text = buildPromptText(config, pendingTodos, allTodos);

            expect(text).toContain("Incomplete tasks remain");
            expect(text).toContain("Continue working");
            expect(text).not.toContain("Status:");
        });

        it("should include progress when enabled", () => {
            const config = createConfig({ includeProgressInPrompt: true });
            const pendingTodos = [createTodo({ status: "pending" })];
            const allTodos = [
                createTodo({ id: "1", status: "pending" }),
                createTodo({ id: "2", status: "completed" }),
                createTodo({ id: "3", status: "completed" }),
            ];

            const text = buildPromptText(config, pendingTodos, allTodos);

            expect(text).toContain("Status: 2/3 completed, 1 remaining.");
        });

        it("should count cancelled as completed for progress", () => {
            const config = createConfig({ includeProgressInPrompt: true });
            const pendingTodos = [createTodo({ status: "pending" })];
            const allTodos = [
                createTodo({ id: "1", status: "pending" }),
                createTodo({ id: "2", status: "completed" }),
                createTodo({ id: "3", status: "cancelled" }),
            ];

            const text = buildPromptText(config, pendingTodos, allTodos);

            expect(text).toContain("Status: 2/3 completed, 1 remaining.");
        });

        it("should handle all pending todos", () => {
            const config = createConfig({ includeProgressInPrompt: true });
            const pendingTodos = [
                createTodo({ id: "1", status: "pending" }),
                createTodo({ id: "2", status: "pending" }),
            ];
            const allTodos = pendingTodos;

            const text = buildPromptText(config, pendingTodos, allTodos);

            expect(text).toContain("Status: 0/2 completed, 2 remaining.");
        });

        it("should not show progress for empty todo list", () => {
            const config = createConfig({ includeProgressInPrompt: true });
            const pendingTodos: Todo[] = [];
            const allTodos: Todo[] = [];

            const text = buildPromptText(config, pendingTodos, allTodos);

            expect(text).not.toContain("Status:");
        });
    });
});

describe("TodoReminderPlugin", () => {
    // Mock client and timer functions
    let mockClient: {
        session: {
            todo: ReturnType<typeof vi.fn>;
            prompt: ReturnType<typeof vi.fn>;
        };
    };
    let mockProject: { id: string; name: string };

    beforeEach(() => {
        vi.useFakeTimers();

        mockClient = {
            session: {
                todo: vi.fn(),
                prompt: vi.fn(),
            },
        };

        mockProject = {
            id: "test-project",
            name: "Test Project",
        };
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.resetAllMocks();
    });

    async function createPlugin() {
        const { TodoReminderPlugin } = await import("./plugin.js");

        // Create plugin with mocked dependencies
        const hooks = await TodoReminderPlugin({
            client: mockClient as any,
            project: mockProject as any,
            directory: "/test/dir",
            worktree: "/test/dir",
            serverUrl: new URL("http://localhost:3000"),
            $: {} as any,
        });

        return hooks;
    }

    describe("event handler", () => {
        describe("todo.updated event", () => {
            it("should track hasPending state from todo.updated events", async () => {
                const hooks = await createPlugin();

                // Send todo.updated with pending todos
                await hooks.event?.({
                    event: {
                        type: "todo.updated",
                        properties: {
                            sessionID: "session-1",
                            todos: [createTodo({ status: "pending" })],
                        },
                    } as any,
                });

                // Now send session.idle - should schedule injection
                mockClient.session.todo.mockResolvedValue({
                    data: [createTodo({ status: "pending" })],
                });

                await hooks.event?.({
                    event: {
                        type: "session.idle",
                        properties: { sessionID: "session-1" },
                    } as any,
                });

                // Fast-forward past idle delay
                await vi.advanceTimersByTimeAsync(2000);

                // Should have called prompt
                expect(mockClient.session.prompt).toHaveBeenCalled();
            });

            it("should update hasPending to false when all todos completed", async () => {
                const hooks = await createPlugin();

                // First have pending todos
                await hooks.event?.({
                    event: {
                        type: "todo.updated",
                        properties: {
                            sessionID: "session-1",
                            todos: [createTodo({ status: "pending" })],
                        },
                    } as any,
                });

                // Then complete all todos
                await hooks.event?.({
                    event: {
                        type: "todo.updated",
                        properties: {
                            sessionID: "session-1",
                            todos: [createTodo({ status: "completed" })],
                        },
                    } as any,
                });

                // session.idle should not schedule injection
                await hooks.event?.({
                    event: {
                        type: "session.idle",
                        properties: { sessionID: "session-1" },
                    } as any,
                });

                await vi.advanceTimersByTimeAsync(5000);

                // Should NOT have called prompt
                expect(mockClient.session.prompt).not.toHaveBeenCalled();
            });
        });

        describe("session.idle event", () => {
            it("should schedule injection when hasPending is true", async () => {
                const hooks = await createPlugin();

                // Set up pending state
                await hooks.event?.({
                    event: {
                        type: "todo.updated",
                        properties: {
                            sessionID: "session-1",
                            todos: [createTodo({ status: "pending" })],
                        },
                    } as any,
                });

                mockClient.session.todo.mockResolvedValue({
                    data: [createTodo({ status: "pending" })],
                });

                // Trigger idle
                await hooks.event?.({
                    event: {
                        type: "session.idle",
                        properties: { sessionID: "session-1" },
                    } as any,
                });

                // Before delay - no call
                expect(mockClient.session.prompt).not.toHaveBeenCalled();

                // After delay
                await vi.advanceTimersByTimeAsync(1600);

                expect(mockClient.session.prompt).toHaveBeenCalledTimes(1);
            });

            it("should not schedule when hasPending is false", async () => {
                const hooks = await createPlugin();

                // No pending todos set

                await hooks.event?.({
                    event: {
                        type: "session.idle",
                        properties: { sessionID: "session-1" },
                    } as any,
                });

                await vi.advanceTimersByTimeAsync(5000);

                expect(mockClient.session.prompt).not.toHaveBeenCalled();
            });
        });

        describe("message.updated event (user activity)", () => {
            it("should cancel pending injection when user sends a message", async () => {
                const hooks = await createPlugin();

                // Set up pending state
                await hooks.event?.({
                    event: {
                        type: "todo.updated",
                        properties: {
                            sessionID: "session-1",
                            todos: [createTodo({ status: "pending" })],
                        },
                    } as any,
                });

                mockClient.session.todo.mockResolvedValue({
                    data: [createTodo({ status: "pending" })],
                });

                // Trigger idle - schedules injection
                await hooks.event?.({
                    event: {
                        type: "session.idle",
                        properties: { sessionID: "session-1" },
                    } as any,
                });

                // User sends a message before delay expires
                await vi.advanceTimersByTimeAsync(500);
                await hooks.event?.({
                    event: {
                        type: "message.updated",
                        properties: {
                            info: {
                                id: "msg-1",
                                sessionID: "session-1",
                                role: "user",
                            },
                        },
                    } as any,
                });

                // Wait for original delay to pass
                await vi.advanceTimersByTimeAsync(2000);

                // Should NOT have sent prompt because user was active
                expect(mockClient.session.prompt).not.toHaveBeenCalled();
            });

            it("should not cancel on assistant messages", async () => {
                const hooks = await createPlugin();

                // Set up pending state
                await hooks.event?.({
                    event: {
                        type: "todo.updated",
                        properties: {
                            sessionID: "session-1",
                            todos: [createTodo({ status: "pending" })],
                        },
                    } as any,
                });

                mockClient.session.todo.mockResolvedValue({
                    data: [createTodo({ status: "pending" })],
                });

                // Trigger idle
                await hooks.event?.({
                    event: {
                        type: "session.idle",
                        properties: { sessionID: "session-1" },
                    } as any,
                });

                // Assistant message (should not cancel)
                await hooks.event?.({
                    event: {
                        type: "message.updated",
                        properties: {
                            info: {
                                id: "msg-1",
                                sessionID: "session-1",
                                role: "assistant",
                            },
                        },
                    } as any,
                });

                await vi.advanceTimersByTimeAsync(2000);

                // Should have sent prompt
                expect(mockClient.session.prompt).toHaveBeenCalled();
            });
        });

        describe("message.part.updated event", () => {
            it("should cancel pending injection when assistant is generating", async () => {
                const hooks = await createPlugin();

                // Set up pending state
                await hooks.event?.({
                    event: {
                        type: "todo.updated",
                        properties: {
                            sessionID: "session-1",
                            todos: [createTodo({ status: "pending" })],
                        },
                    } as any,
                });

                mockClient.session.todo.mockResolvedValue({
                    data: [createTodo({ status: "pending" })],
                });

                // Trigger idle
                await hooks.event?.({
                    event: {
                        type: "session.idle",
                        properties: { sessionID: "session-1" },
                    } as any,
                });

                // Part update (assistant generating)
                await vi.advanceTimersByTimeAsync(500);
                await hooks.event?.({
                    event: {
                        type: "message.part.updated",
                        properties: {
                            part: {
                                id: "part-1",
                                sessionID: "session-1",
                                messageID: "msg-1",
                                type: "text",
                                text: "hello",
                            },
                        },
                    } as any,
                });

                await vi.advanceTimersByTimeAsync(2000);

                // Should NOT have sent prompt
                expect(mockClient.session.prompt).not.toHaveBeenCalled();
            });
        });

        describe("session.deleted event", () => {
            it("should cleanup session state on deletion", async () => {
                const hooks = await createPlugin();

                // Set up pending state
                await hooks.event?.({
                    event: {
                        type: "todo.updated",
                        properties: {
                            sessionID: "session-1",
                            todos: [createTodo({ status: "pending" })],
                        },
                    } as any,
                });

                // Delete session
                await hooks.event?.({
                    event: {
                        type: "session.deleted",
                        properties: {
                            info: { id: "session-1" },
                        },
                    } as any,
                });

                // Trigger idle - should not schedule because state was cleaned up
                await hooks.event?.({
                    event: {
                        type: "session.idle",
                        properties: { sessionID: "session-1" },
                    } as any,
                });

                await vi.advanceTimersByTimeAsync(5000);

                expect(mockClient.session.prompt).not.toHaveBeenCalled();
            });
        });
    });

    describe("maybeInject logic", () => {
        it("should respect cooldown between injections", async () => {
            const hooks = await createPlugin();

            // Set up pending state
            await hooks.event?.({
                event: {
                    type: "todo.updated",
                    properties: {
                        sessionID: "session-1",
                        todos: [createTodo({ status: "pending" })],
                    },
                } as any,
            });

            mockClient.session.todo.mockResolvedValue({
                data: [createTodo({ status: "pending" })],
            });
            mockClient.session.prompt.mockResolvedValue({});

            // First injection
            await hooks.event?.({
                event: {
                    type: "session.idle",
                    properties: { sessionID: "session-1" },
                } as any,
            });
            await vi.advanceTimersByTimeAsync(2000);

            expect(mockClient.session.prompt).toHaveBeenCalledTimes(1);

            // Try second injection immediately
            await hooks.event?.({
                event: {
                    type: "session.idle",
                    properties: { sessionID: "session-1" },
                } as any,
            });
            await vi.advanceTimersByTimeAsync(2000);

            // Should still be 1 because of cooldown
            expect(mockClient.session.prompt).toHaveBeenCalledTimes(1);

            // Wait for cooldown to pass (15 seconds default)
            await vi.advanceTimersByTimeAsync(15000);

            // Trigger again
            await hooks.event?.({
                event: {
                    type: "session.idle",
                    properties: { sessionID: "session-1" },
                } as any,
            });
            await vi.advanceTimersByTimeAsync(2000);

            // Now should be 2
            expect(mockClient.session.prompt).toHaveBeenCalledTimes(2);
        });

        it("should trigger loop protection after max attempts", async () => {
            const hooks = await createPlugin();

            const pendingTodo = createTodo({ id: "stuck-todo", status: "pending" });

            // Set up pending state
            await hooks.event?.({
                event: {
                    type: "todo.updated",
                    properties: {
                        sessionID: "session-1",
                        todos: [pendingTodo],
                    },
                } as any,
            });

            mockClient.session.todo.mockResolvedValue({
                data: [pendingTodo],
            });
            mockClient.session.prompt.mockResolvedValue({});

            // Simulate 3 injection attempts (maxAutoSubmitsPerTodo default)
            for (let i = 0; i < 3; i++) {
                await hooks.event?.({
                    event: {
                        type: "session.idle",
                        properties: { sessionID: "session-1" },
                    } as any,
                });
                await vi.advanceTimersByTimeAsync(2000);

                // Wait for cooldown
                await vi.advanceTimersByTimeAsync(16000);
            }

            // 3 regular injections
            expect(mockClient.session.prompt).toHaveBeenCalledTimes(3);

            // 4th attempt should trigger loop protection message
            await hooks.event?.({
                event: {
                    type: "session.idle",
                    properties: { sessionID: "session-1" },
                } as any,
            });
            await vi.advanceTimersByTimeAsync(2000);

            // Should be 4 (3 regular + 1 blocked message)
            expect(mockClient.session.prompt).toHaveBeenCalledTimes(4);

            // The 4th call should be the blocked message
            const lastCall = mockClient.session.prompt.mock.calls[3] as any[];
            expect(lastCall).toBeDefined();
            expect(lastCall[0].body.parts[0].text).toContain(
                "Auto-continuation has been paused",
            );

            // 5th attempt should be skipped entirely
            await vi.advanceTimersByTimeAsync(16000);
            await hooks.event?.({
                event: {
                    type: "session.idle",
                    properties: { sessionID: "session-1" },
                } as any,
            });
            await vi.advanceTimersByTimeAsync(2000);

            // Still 4 - no more injections
            expect(mockClient.session.prompt).toHaveBeenCalledTimes(4);
        });

        it("should reset loop protection when blocking todo is completed", async () => {
            const hooks = await createPlugin();

            const stuckTodo = createTodo({ id: "stuck", status: "pending" });
            const newTodo = createTodo({ id: "new", status: "pending" });

            // Set up with stuck todo
            await hooks.event?.({
                event: {
                    type: "todo.updated",
                    properties: {
                        sessionID: "session-1",
                        todos: [stuckTodo],
                    },
                } as any,
            });

            mockClient.session.todo.mockResolvedValue({ data: [stuckTodo] });
            mockClient.session.prompt.mockResolvedValue({});

            // Exhaust attempts on stuck todo
            for (let i = 0; i < 4; i++) {
                await hooks.event?.({
                    event: {
                        type: "session.idle",
                        properties: { sessionID: "session-1" },
                    } as any,
                });
                await vi.advanceTimersByTimeAsync(2000);
                await vi.advanceTimersByTimeAsync(16000);
            }

            // Complete the stuck todo and add a new one
            await hooks.event?.({
                event: {
                    type: "todo.updated",
                    properties: {
                        sessionID: "session-1",
                        todos: [
                            { ...stuckTodo, status: "completed" },
                            newTodo,
                        ],
                    },
                } as any,
            });

            mockClient.session.todo.mockResolvedValue({
                data: [{ ...stuckTodo, status: "completed" }, newTodo],
            });

            // Should be able to inject for new todo
            await hooks.event?.({
                event: {
                    type: "session.idle",
                    properties: { sessionID: "session-1" },
                } as any,
            });
            await vi.advanceTimersByTimeAsync(2000);

            // Should have one more call for the new todo
            const calls = mockClient.session.prompt.mock.calls;
            const lastCall = calls[calls.length - 1] as any[];
            expect(lastCall).toBeDefined();
            expect(lastCall[0].body.parts[0].text).toContain(
                "Incomplete tasks remain",
            );
        });

        it("should handle API errors gracefully", async () => {
            const hooks = await createPlugin();

            // Set up pending state
            await hooks.event?.({
                event: {
                    type: "todo.updated",
                    properties: {
                        sessionID: "session-1",
                        todos: [createTodo({ status: "pending" })],
                    },
                } as any,
            });

            // Make todo API fail
            mockClient.session.todo.mockRejectedValue(new Error("API Error"));

            await hooks.event?.({
                event: {
                    type: "session.idle",
                    properties: { sessionID: "session-1" },
                } as any,
            });
            await vi.advanceTimersByTimeAsync(2000);

            // Should not throw and should not call prompt
            expect(mockClient.session.prompt).not.toHaveBeenCalled();
        });

        it("should handle prompt API errors gracefully", async () => {
            const hooks = await createPlugin();

            // Set up pending state
            await hooks.event?.({
                event: {
                    type: "todo.updated",
                    properties: {
                        sessionID: "session-1",
                        todos: [createTodo({ status: "pending" })],
                    },
                } as any,
            });

            mockClient.session.todo.mockResolvedValue({
                data: [createTodo({ status: "pending" })],
            });
            mockClient.session.prompt.mockRejectedValue(
                new Error("Prompt Error"),
            );

            // Should not throw
            await hooks.event?.({
                event: {
                    type: "session.idle",
                    properties: { sessionID: "session-1" },
                } as any,
            });
            await vi.advanceTimersByTimeAsync(2000);

            expect(mockClient.session.prompt).toHaveBeenCalled();
        });
    });

    describe("experimental.text.complete fallback", () => {
        it("should schedule fallback injection with longer delay", async () => {
            const hooks = await createPlugin();

            // Set up pending state
            await hooks.event?.({
                event: {
                    type: "todo.updated",
                    properties: {
                        sessionID: "session-1",
                        todos: [createTodo({ status: "pending" })],
                    },
                } as any,
            });

            mockClient.session.todo.mockResolvedValue({
                data: [createTodo({ status: "pending" })],
            });

            // Trigger text.complete
            await hooks["experimental.text.complete"]?.(
                {
                    sessionID: "session-1",
                    messageID: "msg-1",
                    partID: "part-1",
                },
                { text: "done" },
            );

            // Default delay (1500) + fallback offset (500) = 2000
            await vi.advanceTimersByTimeAsync(1900);
            expect(mockClient.session.prompt).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(200);
            expect(mockClient.session.prompt).toHaveBeenCalled();
        });

        it("should skip if hasPending is false", async () => {
            const hooks = await createPlugin();

            // No pending todos set

            await hooks["experimental.text.complete"]?.(
                {
                    sessionID: "session-1",
                    messageID: "msg-1",
                    partID: "part-1",
                },
                { text: "done" },
            );

            await vi.advanceTimersByTimeAsync(5000);

            expect(mockClient.session.prompt).not.toHaveBeenCalled();
        });
    });
});
