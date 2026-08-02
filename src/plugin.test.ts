import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Todo } from "@opencode-ai/sdk";
import { TodoReminderPlugin } from "./plugin.js";
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
        triggerStatuses: ["pending", "in_progress", "open"],
        maxAutoSubmitsPerTodo: 3,
        idleDelayMs: 500,
        messageFormat:
            "Incomplete tasks remain in your todo list.\n" +
            "If any are already done, call todowrite to mark them complete/cancelled first.\n" +
            "Keep todo statuses current going forward - update each one via todowrite as soon as it is finished, not only when reminded.\n" +
            "Continue working on the next pending task now; do not ask for permission; mark tasks complete when done.\n\n" +
            "Status: {completed}/{total} completed, {remaining} remaining.",
        inProgressMessageFormat:
            "You have an in-progress task: \"{current_task}\".\n" +
            "If it's already done, call todowrite to mark it complete first - otherwise " +
            "continue working on THIS task until it's done; do not skip ahead to a different one or restart it. " +
            "Keep todo statuses current going forward, not only when reminded. Mark it complete when finished.\n\n" +
            "Status: {completed}/{total} completed, {remaining} remaining.",
        useToasts: true,
        preserveUnfinishedTodos: true,
        syntheticPrompt: false,
        debug: false,
        ...overrides,
    };
}

// Mock config module
let mockConfig = createConfig();
vi.mock("./config.js", () => ({
    loadConfig: () => mockConfig
}));


describe("TodoReminderPlugin", () => {
    // Mock client and timer functions
    let mockClient: {
        session: {
            todo: ReturnType<typeof vi.fn>;
            prompt: ReturnType<typeof vi.fn>;
            messages: ReturnType<typeof vi.fn>;
        };
        tui: {
            showToast: ReturnType<typeof vi.fn>;
        };
    };
    let mockProject: { id: string; name: string };

    beforeEach(() => {
        vi.useFakeTimers();
        mockConfig = createConfig();

        mockClient = {
            session: {
                todo: vi.fn(),
                prompt: vi.fn(),
                messages: vi.fn().mockResolvedValue({ data: [] }),
            },
            tui: {
                showToast: vi.fn(),
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
                await vi.advanceTimersByTimeAsync(200);
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

            it("should NOT cancel on assistant message.updated (ignores assistant messages)", async () => {
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
                mockClient.session.messages.mockResolvedValue({
                    data: [
                        {
                            info: {
                                id: "msg-1",
                                role: "assistant",
                                time: { completed: Date.now() },
                            },
                        },
                    ],
                });

                // Trigger idle
                await hooks.event?.({
                    event: {
                        type: "session.idle",
                        properties: { sessionID: "session-1" },
                    } as any,
                });

                // Assistant message arrives (should be ignored for cancellation)
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

                // Should have sent prompt because assistant messages don't cancel
                expect(mockClient.session.prompt).toHaveBeenCalled();
            });

            it("should pause reminders when assistant message is aborted", async () => {
                const hooks = await createPlugin();

                await hooks.event?.({
                    event: {
                        type: "todo.updated",
                        properties: {
                            sessionID: "session-assistant-aborted",
                            todos: [createTodo({ status: "pending" })],
                        },
                    } as any,
                });

                mockClient.session.todo.mockResolvedValue({
                    data: [createTodo({ status: "pending" })],
                });

                await hooks.event?.({
                    event: {
                        type: "message.updated",
                        properties: {
                            info: {
                                id: "assistant-msg-1",
                                sessionID: "session-assistant-aborted",
                                role: "assistant",
                                error: { name: "MessageAbortedError" },
                            },
                        },
                    } as any,
                });

                // Multiple idle events should still be paused
                for (let i = 0; i < 2; i++) {
                    await hooks.event?.({
                        event: {
                            type: "session.idle",
                            properties: { sessionID: "session-assistant-aborted" },
                        } as any,
                    });
                    await vi.advanceTimersByTimeAsync(2000);
                }

                expect(mockClient.session.prompt).not.toHaveBeenCalled();

                // New user message unpauses reminders
                await hooks.event?.({
                    event: {
                        type: "message.updated",
                        properties: {
                            info: {
                                id: "user-msg-1",
                                sessionID: "session-assistant-aborted",
                                role: "user",
                            },
                        },
                    } as any,
                });

                await hooks.event?.({
                    event: {
                        type: "session.idle",
                        properties: { sessionID: "session-assistant-aborted" },
                    } as any,
                });
                await vi.advanceTimersByTimeAsync(2000);

                expect(mockClient.session.prompt).toHaveBeenCalledTimes(1);
            });
        });

        describe("message.part.updated event", () => {
            it("should NOT cancel on message.part.updated (ignores all part updates)", async () => {
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
                mockClient.session.messages.mockResolvedValue({
                    data: [
                        {
                            info: {
                                id: "msg-1",
                                role: "assistant",
                                time: { completed: Date.now() },
                            },
                        },
                    ],
                });

                // Trigger idle
                await hooks.event?.({
                    event: {
                        type: "session.idle",
                        properties: { sessionID: "session-1" },
                    } as any,
                });

                // Part update (should be ignored for cancellation)
                await vi.advanceTimersByTimeAsync(200);
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

                // Should have sent prompt because part updates are ignored
                expect(mockClient.session.prompt).toHaveBeenCalled();
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

        describe("session.error event", () => {
            it("should pause reminders after user abort until next user message", async () => {
                const hooks = await createPlugin();

                await hooks.event?.({
                    event: {
                        type: "todo.updated",
                        properties: {
                            sessionID: "session-error-abort",
                            todos: [createTodo({ status: "pending" })],
                        },
                    } as any,
                });

                mockClient.session.todo.mockResolvedValue({
                    data: [createTodo({ status: "pending" })],
                });

                await hooks.event?.({
                    event: {
                        type: "session.error",
                        properties: {
                            sessionID: "session-error-abort",
                            error: { name: "MessageAbortedError" },
                        },
                    } as any,
                });

                // Multiple idle events should remain paused after abort
                for (let i = 0; i < 2; i++) {
                    await hooks.event?.({
                        event: {
                            type: "session.idle",
                            properties: { sessionID: "session-error-abort" },
                        } as any,
                    });
                    await vi.advanceTimersByTimeAsync(2000);
                }

                expect(mockClient.session.prompt).not.toHaveBeenCalled();

                // Resume after user sends a new message
                await hooks.event?.({
                    event: {
                        type: "message.updated",
                        properties: {
                            info: {
                                id: "user-msg-after-abort",
                                sessionID: "session-error-abort",
                                role: "user",
                            },
                        },
                    } as any,
                });

                await hooks.event?.({
                    event: {
                        type: "session.idle",
                        properties: { sessionID: "session-error-abort" },
                    } as any,
                });
                await vi.advanceTimersByTimeAsync(2000);

                expect(mockClient.session.prompt).toHaveBeenCalledTimes(1);
            });

            it("should show interruption toast and avoid duplicate spam while paused", async () => {
                const hooks = await createPlugin();

                await hooks.event?.({
                    event: {
                        type: "session.error",
                        properties: {
                            sessionID: "session-abort-toast",
                            error: { name: "MessageAbortedError" },
                        },
                    } as any,
                });

                await hooks.event?.({
                    event: {
                        type: "session.error",
                        properties: {
                            sessionID: "session-abort-toast",
                            error: { name: "MessageAbortedError" },
                        },
                    } as any,
                });

                expect(mockClient.tui.showToast).toHaveBeenCalledTimes(1);
                expect(mockClient.tui.showToast).toHaveBeenCalledWith(
                    expect.objectContaining({
                        body: expect.objectContaining({
                            title: "TODO Reminder Paused",
                            message: expect.stringContaining(
                                "No reminder will be fired",
                            ),
                            variant: "info",
                        }),
                    }),
                );

                // User activity clears pause so a future interruption can notify again
                await hooks.event?.({
                    event: {
                        type: "message.updated",
                        properties: {
                            info: {
                                id: "user-resume-1",
                                sessionID: "session-abort-toast",
                                role: "user",
                            },
                        },
                    } as any,
                });

                await hooks.event?.({
                    event: {
                        type: "session.error",
                        properties: {
                            sessionID: "session-abort-toast",
                            error: { name: "MessageAbortedError" },
                        },
                    } as any,
                });

                expect(mockClient.tui.showToast).toHaveBeenCalledTimes(2);
            });
        });

        it("should show toast notification when enabled", async () => {
            const hooks = await createPlugin();

            // Setup pending state
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

            await vi.advanceTimersByTimeAsync(2000);

            // Should have called showToast
            expect(mockClient.tui.showToast).toHaveBeenCalled();
        });

        it("should use synthetic flag from config in prompt", async () => {
            mockConfig = createConfig({ syntheticPrompt: true });
            const hooks = await createPlugin();

            await hooks.event?.({
                event: {
                    type: "todo.updated",
                    properties: {
                        sessionID: "session-synthetic",
                        todos: [createTodo({ status: "pending" })],
                    },
                } as any,
            });

            mockClient.session.todo.mockResolvedValue({
                data: [createTodo({ status: "pending" })],
            });

            await hooks.event?.({
                event: {
                    type: "session.idle",
                    properties: { sessionID: "session-synthetic" },
                } as any,
            });

            await vi.advanceTimersByTimeAsync(2000);

            expect(mockClient.session.prompt).toHaveBeenCalledWith(
                expect.objectContaining({
                    body: expect.objectContaining({
                        parts: expect.arrayContaining([
                            expect.objectContaining({
                                synthetic: true,
                            }),
                        ]),
                    }),
                }),
            );
        });

        it("should use inProgressMessageFormat, naming the in-progress task, instead of messageFormat when a todo is already in_progress", async () => {
            const hooks = await createPlugin();

            const inProgressTodo = createTodo({
                id: "task-2",
                status: "in_progress",
                content: "Write axiom_gate_context.py",
            });

            await hooks.event?.({
                event: {
                    type: "todo.updated",
                    properties: {
                        sessionID: "session-in-progress",
                        todos: [
                            createTodo({ id: "task-1", status: "completed" }),
                            inProgressTodo,
                            createTodo({ id: "task-3", status: "pending" }),
                        ],
                    },
                } as any,
            });

            mockClient.session.todo.mockResolvedValue({
                data: [
                    createTodo({ id: "task-1", status: "completed" }),
                    inProgressTodo,
                    createTodo({ id: "task-3", status: "pending" }),
                ],
            });

            await hooks.event?.({
                event: {
                    type: "session.idle",
                    properties: { sessionID: "session-in-progress" },
                } as any,
            });

            await vi.advanceTimersByTimeAsync(2000);

            const call = (mockClient.session.prompt as any).mock.calls[0][0];
            const sentText: string = call.body.parts[0].text;

            expect(sentText).toContain("Write axiom_gate_context.py");
            expect(sentText).not.toContain("next pending task");
        });

        it("should keep using messageFormat (\"next pending task\") when no todo is in_progress", async () => {
            const hooks = await createPlugin();

            await hooks.event?.({
                event: {
                    type: "todo.updated",
                    properties: {
                        sessionID: "session-all-pending",
                        todos: [createTodo({ status: "pending" })],
                    },
                } as any,
            });

            mockClient.session.todo.mockResolvedValue({
                data: [createTodo({ status: "pending" })],
            });

            await hooks.event?.({
                event: {
                    type: "session.idle",
                    properties: { sessionID: "session-all-pending" },
                } as any,
            });

            await vi.advanceTimersByTimeAsync(2000);

            const call = (mockClient.session.prompt as any).mock.calls[0][0];
            const sentText: string = call.body.parts[0].text;

            expect(sentText).toContain("next pending task");
        });
    });

    describe("maybeInject logic", () => {
        it("should inject once per idle event (no periodic reminders)", async () => {
            mockConfig = createConfig({
                idleDelayMs: 1000,
                useToasts: false,
            });
            const hooks = await createPlugin();

            await hooks.event?.({
                event: {
                    type: "todo.updated",
                    properties: {
                        sessionID: "session-once",
                        todos: [createTodo({ status: "pending" })],
                    },
                } as any,
            });

            mockClient.session.todo.mockResolvedValue({
                data: [createTodo({ status: "pending" })],
            });

            // First injection
            await hooks.event?.({
                event: {
                    type: "session.idle",
                    properties: { sessionID: "session-once" },
                } as any,
            });

            await vi.advanceTimersByTimeAsync(1500);
            expect(mockClient.session.prompt).toHaveBeenCalledTimes(1);

            // Fast forward a long time - should not prompt again
            await vi.advanceTimersByTimeAsync(600000);
            expect(mockClient.session.prompt).toHaveBeenCalledTimes(1);
        });

        it("should pause after an aborted injected prompt until user re-engages", async () => {
            mockConfig = createConfig({
                idleDelayMs: 1000,
                useToasts: false,
            });
            const hooks = await createPlugin();

            await hooks.event?.({
                event: {
                    type: "todo.updated",
                    properties: {
                        sessionID: "session-cancelled",
                        todos: [createTodo({ status: "pending" })],
                    },
                } as any,
            });

            mockClient.session.todo.mockResolvedValue({
                data: [createTodo({ status: "pending" })],
            });
            mockClient.session.prompt.mockResolvedValue({
                data: {
                    info: {
                        error: { name: "MessageAbortedError" },
                    },
                },
            });

            await hooks.event?.({
                event: {
                    type: "session.idle",
                    properties: { sessionID: "session-cancelled" },
                } as any,
            });

            await vi.advanceTimersByTimeAsync(1500);
            expect(mockClient.session.prompt).toHaveBeenCalledTimes(1);

            // Session should remain paused on future idle events
            await hooks.event?.({
                event: {
                    type: "session.idle",
                    properties: { sessionID: "session-cancelled" },
                } as any,
            });
            await vi.advanceTimersByTimeAsync(1500);
            expect(mockClient.session.prompt).toHaveBeenCalledTimes(1);

            // User message should clear pause and allow reminders again
            mockClient.session.prompt.mockResolvedValue({
                data: {
                    info: {},
                },
            });
            await hooks.event?.({
                event: {
                    type: "message.updated",
                    properties: {
                        info: {
                            id: "user-msg-resume",
                            sessionID: "session-cancelled",
                            role: "user",
                        },
                    },
                } as any,
            });

            await hooks.event?.({
                event: {
                    type: "session.idle",
                    properties: { sessionID: "session-cancelled" },
                } as any,
            });
            await vi.advanceTimersByTimeAsync(1500);

            expect(mockClient.session.prompt).toHaveBeenCalledTimes(2);
        });

        it("should block reminder-like prompt injections from other plugin instances while paused", async () => {
            mockConfig = createConfig({
                useToasts: false,
            });

            let forwardedCalls = 0;
            const forwardedMessages: string[] = [];

            (mockClient.session as any).prompt = async (options: any) => {
                forwardedCalls += 1;
                const text = options?.body?.parts?.[0]?.text;
                if (typeof text === "string") {
                    forwardedMessages.push(text);
                }
                return { data: { info: {} } };
            };

            const hooks = await createPlugin();

            // Pause the session by simulating user abort.
            await hooks.event?.({
                event: {
                    type: "session.error",
                    properties: {
                        sessionID: "session-shared-guard",
                        error: { name: "MessageAbortedError" },
                    },
                } as any,
            });

            // Simulate another plugin trying to inject the reminder text.
            await (mockClient.session.prompt as any)({
                path: { id: "session-shared-guard" },
                query: { directory: "/test/dir" },
                body: {
                    parts: [
                        {
                            type: "text",
                            text:
                                "Incomplete tasks remain in your todo list.\n" +
                                "If any are already done, call todowrite to mark them complete/cancelled first.\n" +
            "Keep todo statuses current going forward - update each one via todowrite as soon as it is finished, not only when reminded.\n" +
            "Continue working on the next pending task now; do not ask for permission; mark tasks complete when done.\n\n" +
                                "Status: 0/5 completed, 5 remaining.",
                        },
                    ],
                },
            } as any);

            // Reminder should be blocked by guard.
            expect(forwardedCalls).toBe(0);

            // Normal user prompt text should still go through.
            await (mockClient.session.prompt as any)({
                path: { id: "session-shared-guard" },
                body: {
                    parts: [
                        {
                            type: "text",
                            text: "continue please",
                        },
                    ],
                },
            } as any);

            expect(forwardedCalls).toBe(1);
            expect(forwardedMessages).toEqual(["continue please"]);
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

                // 4th attempt should trigger loop protection
                await hooks.event?.({
                    event: {
                        type: "session.idle",
                        properties: { sessionID: "session-1" },
                    } as any,
                });
                await vi.advanceTimersByTimeAsync(2000);

                // Should still be 3 (no new prompt)
                expect(mockClient.session.prompt).toHaveBeenCalledTimes(3);

                // Should show warning toast
                expect(mockClient.tui.showToast).toHaveBeenCalledWith(
                    expect.objectContaining({
                        body: expect.objectContaining({
                            title: "TODO Reminder Paused",
                            variant: "warning",
                        }),
                    }),
                );
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

        it("should send reminder when last assistant message is completed", async () => {
            const hooks = await createPlugin();

            // Set up pending state
            await hooks.event?.({
                event: {
                    type: "todo.updated",
                    properties: {
                        sessionID: "session-completed",
                        todos: [createTodo({ status: "pending" })],
                    },
                } as any,
            });

            mockClient.session.todo.mockResolvedValue({
                data: [createTodo({ status: "pending" })],
            });

            // Mock assistant message with time.completed (finished)
            mockClient.session.messages.mockResolvedValue({
                data: [
                    {
                        info: {
                            role: "assistant",
                            sessionID: "session-completed",
                            time: { started: Date.now(), completed: Date.now() },
                        },
                    },
                ],
            });

            // Trigger idle
            await hooks.event?.({
                event: {
                    type: "session.idle",
                    properties: { sessionID: "session-completed" },
                } as any,
            });

            await vi.advanceTimersByTimeAsync(2000);

            // Should have called prompt (assistant finished)
            expect(mockClient.session.prompt).toHaveBeenCalled();
        });
    });

    describe("todowrite merge-guard (preserveUnfinishedTodos)", () => {
        it("should backfill a pending todo the model omitted from a new TodoWrite call", async () => {
            const hooks = await createPlugin();

            mockClient.session.todo.mockResolvedValue({
                data: [
                    createTodo({ content: "Task A", status: "in_progress" }),
                    createTodo({ content: "Task B", status: "pending" }),
                ],
            });

            const output = {
                args: {
                    todos: [
                        { content: "Task A", status: "completed", priority: "medium" },
                    ],
                },
            };

            await hooks["tool.execute.before"]?.(
                { tool: "todowrite", sessionID: "session-x", callID: "call-1" },
                output,
            );

            expect(output.args.todos).toEqual([
                { content: "Task A", status: "completed", priority: "medium" },
                expect.objectContaining({ content: "Task B", status: "pending" }),
            ]);
        });

        it("should not touch the call when nothing was dropped", async () => {
            const hooks = await createPlugin();

            mockClient.session.todo.mockResolvedValue({
                data: [createTodo({ content: "Task A", status: "pending" })],
            });

            const originalTodos = [
                { content: "Task A", status: "in_progress", priority: "medium" },
            ];
            const output = { args: { todos: originalTodos } };

            await hooks["tool.execute.before"]?.(
                { tool: "todowrite", sessionID: "session-x", callID: "call-1" },
                output,
            );

            expect(output.args.todos).toBe(originalTodos);
        });

        it("should not backfill a dropped todo that was already completed/cancelled", async () => {
            const hooks = await createPlugin();

            mockClient.session.todo.mockResolvedValue({
                data: [
                    createTodo({ content: "Task A", status: "completed" }),
                    createTodo({ content: "Task B", status: "pending" }),
                ],
            });

            const output = {
                args: {
                    todos: [
                        { content: "Task B", status: "in_progress", priority: "medium" },
                    ],
                },
            };

            await hooks["tool.execute.before"]?.(
                { tool: "todowrite", sessionID: "session-x", callID: "call-1" },
                output,
            );

            // "Task A" was already completed, so its omission is fine - not backfilled.
            expect(output.args.todos).toEqual([
                { content: "Task B", status: "in_progress", priority: "medium" },
            ]);
        });

        it("should ignore tool calls other than todowrite", async () => {
            const hooks = await createPlugin();

            const output = { args: { path: "foo.ts" } };
            await hooks["tool.execute.before"]?.(
                { tool: "read", sessionID: "session-x", callID: "call-1" },
                output,
            );

            expect(mockClient.session.todo).not.toHaveBeenCalled();
            expect(output.args).toEqual({ path: "foo.ts" });
        });

        it("should do nothing when preserveUnfinishedTodos is disabled", async () => {
            mockConfig = createConfig({ preserveUnfinishedTodos: false });
            const hooks = await createPlugin();

            const output = {
                args: {
                    todos: [{ content: "Task A", status: "completed", priority: "medium" }],
                },
            };

            await hooks["tool.execute.before"]?.(
                { tool: "todowrite", sessionID: "session-x", callID: "call-1" },
                output,
            );

            expect(mockClient.session.todo).not.toHaveBeenCalled();
            expect(output.args.todos).toEqual([
                { content: "Task A", status: "completed", priority: "medium" },
            ]);
        });
    });

});
