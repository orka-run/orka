import { describe, expect, test } from "bun:test";
import type { ProviderRuntimeEvent } from "@orka/core";
import { ClaudeCodeAdapter, mapClaudeEvent } from "./claude-adapter";

describe("mapClaudeEvent", () => {
  test("maps system init to session.started", () => {
    const [event] = mapClaudeEvent("thread-1", {
      type: "system",
      subtype: "init",
      message: "Claude Code started",
    });

    expect(event).toBeDefined();
    expect(event?.type).toBe("session.started");
    expect(event?.provider).toBe("claude-code");
    expect(event?.threadId).toBe("thread-1");
    expect(event?.payload).toEqual({ message: "Claude Code started" });
  });

  test("maps rate_limit_event to rate.limit", () => {
    const [event] = mapClaudeEvent("thread-1", {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        resetsAt: 1773990000,
        rateLimitType: "seven_day",
        utilization: 0.78,
        surpassedThreshold: 0.75,
        isUsingOverage: false,
      },
    });

    expect(event).toBeDefined();
    expect(event?.type).toBe("rate.limit");
    expect(event?.payload).toEqual({
      rateLimitInfo: {
        status: "allowed_warning",
        resetsAt: 1773990000,
        rateLimitType: "seven_day",
        utilization: 0.78,
        surpassedThreshold: 0.75,
        isUsingOverage: false,
      },
    });
  });

  test("maps system api_retry to api.retry", () => {
    const [event] = mapClaudeEvent("thread-1", {
      type: "system",
      subtype: "api_retry",
      api_retry_info: {
        attempt: 1,
        max_attempts: 10,
        error: "overloaded_error",
        delay_ms: 1000,
      },
    });

    expect(event).toBeDefined();
    expect(event?.type).toBe("api.retry");
    expect(event?.payload).toEqual({
      attempt: 1,
      maxAttempts: 10,
      error: "overloaded_error",
      delayMs: 1000,
    });
  });

  test("maps system task_progress to tool.progress", () => {
    const [event] = mapClaudeEvent("thread-1", {
      type: "system",
      subtype: "task_progress",
      tool_use_id: "tool-1",
      last_tool_name: "Read",
      progress_text: "Reading src/db.ts",
      elapsed_seconds: 2,
    }, { turnId: "turn-1" });

    expect(event).toBeDefined();
    expect(event?.type).toBe("tool.progress");
    expect(event?.turnId).toBe("turn-1");
    expect(event?.itemId).toBe("tool-1");
    expect(event?.payload).toEqual({
      toolName: "Read",
      summary: "Reading src/db.ts",
      elapsedSeconds: 2,
    });
  });

  test("maps system task lifecycle events", () => {
    const startedEvents = mapClaudeEvent("thread-1", {
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      tool_use_id: "tool-1",
      description: "Explore dashboard structure",
      prompt: "Inspect chat timeline rendering",
      subagent_type: "research",
    }, { turnId: "turn-1" });

    const completedEvents = mapClaudeEvent("thread-1", {
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      tool_use_id: "tool-1",
      status: "completed",
      summary: "Found the timeline renderer and summarized the missing cases.",
    }, { turnId: "turn-1" });

    const started = startedEvents[0];
    const completed = completedEvents[0];

    expect(started?.type).toBe("task.started");
    expect(started?.turnId).toBe("turn-1");
    expect(started?.itemId).toBe("tool-1");
    expect(started?.payload).toEqual({
      taskId: "task-1",
      toolUseId: "tool-1",
      title: "Explore dashboard structure",
      detail: "Inspect chat timeline rendering",
      taskKind: "research",
    });

    expect(completed?.type).toBe("task.completed");
    expect(completed?.turnId).toBe("turn-1");
    expect(completed?.itemId).toBe("tool-1");
    expect(completed?.payload).toEqual({
      taskId: "task-1",
      toolUseId: "tool-1",
      summary: "Found the timeline renderer and summarized the missing cases.",
      status: "completed",
    });
  });

  test("maps hook, status, and compaction system events", () => {
    const [hookStarted] = mapClaudeEvent("thread-1", {
      type: "system",
      subtype: "hook_started",
      hook_name: "SessionStart:startup",
      matcher: "startup",
    });
    const [hookResponse] = mapClaudeEvent("thread-1", {
      type: "system",
      subtype: "hook_response",
      hook_name: "SessionStart:startup",
      approved: true,
      reason: "Hook completed",
    });
    const [status] = mapClaudeEvent("thread-1", {
      type: "system",
      subtype: "status",
      status: "compacting",
      message: "Preparing to trim context",
    });
    const [compacted] = mapClaudeEvent("thread-1", {
      type: "system",
      subtype: "compact_boundary",
      pre_compaction_token_count: 120000,
      post_compaction_token_count: 64000,
    });

    expect(hookStarted?.type).toBe("hook.started");
    expect(hookStarted?.payload).toEqual({
      hookName: "SessionStart:startup",
      matcher: "startup",
    });

    expect(hookResponse?.type).toBe("hook.response");
    expect(hookResponse?.payload).toEqual({
      hookName: "SessionStart:startup",
      decision: "allowed",
      reason: "Hook completed",
    });

    expect(status?.type).toBe("session.status");
    expect(status?.payload).toEqual({
      status: "compacting",
      detail: "Preparing to trim context",
    });

    expect(compacted?.type).toBe("session.compacted");
    expect(compacted?.payload).toEqual({
      tokenCountBefore: 120000,
      tokenCountAfter: 64000,
    });
  });

  test("maps assistant text to content.delta", () => {
    const [event] = mapClaudeEvent("thread-1", {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I'll inspect the file." }],
      },
    }, { turnId: "turn-1" });

    expect(event).toBeDefined();
    expect(event?.type).toBe("content.delta");
    expect(event?.turnId).toBe("turn-1");
    expect(event?.payload).toEqual({
      streamKind: "assistant_text",
      delta: "I'll inspect the file.",
    });
  });

  test("maps assistant tool_use to item.started with the correct item type", () => {
    const [commandEvent] = mapClaudeEvent("thread-1", {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls -la" } }],
      },
    }, { turnId: "turn-1" });
    const [fileEvent] = mapClaudeEvent("thread-1", {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-2", name: "Read", input: { file_path: "src/index.ts" } }],
      },
    }, { turnId: "turn-1" });

    expect(commandEvent?.type).toBe("item.started");
    expect(commandEvent?.turnId).toBe("turn-1");
    expect(commandEvent?.itemId).toBe("tool-1");
    expect(commandEvent?.payload).toEqual({
      itemType: "command_execution",
      status: "in_progress",
      title: "ls -la",
      detail: "ls -la",
      args: { command: "ls -la" },
    });

    expect(fileEvent?.type).toBe("item.started");
    expect(fileEvent?.turnId).toBe("turn-1");
    expect(fileEvent?.itemId).toBe("tool-2");
    expect(fileEvent?.payload).toEqual({
      itemType: "file_read",
      status: "in_progress",
      title: "Read src/index.ts",
      detail: "src/index.ts",
      args: { file_path: "src/index.ts" },
    });
  });

  test("maps result to turn.completed with cost and tokens", () => {
    const [event] = mapClaudeEvent("thread-1", {
      type: "result",
      subtype: "success",
      result: "Final answer",
      is_error: false,
      total_cost_usd: 0.42,
      duration_ms: 15000,
      num_turns: 3,
      usage: { input_tokens: 5000, output_tokens: 2000 },
      modelUsage: {
        "claude-sonnet-4-20250514": {
          inputTokens: 5000,
          outputTokens: 2000,
        },
      },
    }, { turnId: "turn-1" });

    expect(event).toBeDefined();
    expect(event?.type).toBe("turn.completed");
    expect(event?.turnId).toBe("turn-1");
    expect(event?.payload).toEqual({
      state: "completed",
      stopReason: "success",
      totalCostUsd: 0.42,
      usage: {
        inputTokens: 5000,
        outputTokens: 2000,
      },
    });
  });

  test("maps result to session.exited in exit mode", () => {
    const [event] = mapClaudeEvent(
      "thread-1",
      {
        type: "result",
        subtype: "success",
        is_error: false,
      },
      "exit",
    );

    expect(event).toBeDefined();
    expect(event?.type).toBe("session.exited");
    expect(event?.payload).toEqual({
      reason: "Claude Code result: success",
      exitKind: "graceful",
    });
  });

  test("returns empty array for unknown event types", () => {
    expect(mapClaudeEvent("thread-1", { type: "unknown.event" })).toEqual([]);
  });

  test("emits subagent.spawned alongside task.started", () => {
    const events = mapClaudeEvent("thread-1", {
      type: "system",
      subtype: "task_started",
      task_id: "agent-abc",
      tool_use_id: "tool-1",
      description: "Explore codebase",
      prompt: "Find all routes",
      subagent_type: "research",
    }, { turnId: "turn-1" });

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("task.started");
    expect(events[1]?.type).toBe("subagent.spawned");
    expect(events[1]?.payload).toEqual({
      agentId: "agent-abc",
      prompt: "Find all routes",
      description: "Explore codebase",
    });
  });

  test("emits subagent.tool_use alongside tool.progress when agentId is present", () => {
    const events = mapClaudeEvent("thread-1", {
      type: "system",
      subtype: "task_progress",
      tool_use_id: "tool-1",
      task_id: "agent-abc",
      last_tool_name: "Read",
      progress_text: "Reading db.ts",
      elapsed_seconds: 3,
    }, { turnId: "turn-1" });

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("tool.progress");
    expect(events[1]?.type).toBe("subagent.tool_use");
    expect(events[1]?.payload).toEqual({
      agentId: "agent-abc",
      toolName: "Read",
      summary: "Reading db.ts",
      elapsedSeconds: 3,
    });
  });

  test("emits subagent.completed alongside task.completed", () => {
    const events = mapClaudeEvent("thread-1", {
      type: "system",
      subtype: "task_notification",
      task_id: "agent-abc",
      tool_use_id: "tool-1",
      status: "completed",
      summary: "Found 5 routes.",
    }, { turnId: "turn-1" });

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("task.completed");
    expect(events[1]?.type).toBe("subagent.completed");
    expect(events[1]?.payload).toEqual({
      agentId: "agent-abc",
      status: "completed",
      summary: "Found 5 routes.",
    });
  });

  test("does not emit subagent events when taskId is missing", () => {
    const events = mapClaudeEvent("thread-1", {
      type: "system",
      subtype: "task_started",
      tool_use_id: "tool-1",
      description: "Some task",
    }, { turnId: "turn-1" });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("task.started");
  });
});

describe("ClaudeCodeAdapter", () => {
  test("startSession includes live-path flags and emits turn-scoped events with a stable turnId", async () => {
    const spawnCalls: Array<{ command: string[]; options: Record<string, unknown> }> = [];
    const stdin = new MockWritableSink();
    const adapter = new ClaudeCodeAdapter(((command, options) => {
      spawnCalls.push({ command: [...command], options: options as Record<string, unknown> });
      return {
        stdout: createJsonLineStream([
          { type: "system", subtype: "init", message: "Claude Code started" },
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Inspecting the workspace." }],
            },
          },
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls -la" } }],
            },
          },
          { type: "tool", tool_use_id: "tool-1", content: "total 0" },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            total_cost_usd: 0.12,
            usage: { input_tokens: 10, output_tokens: 20 },
          },
        ]),
        stderr: createTextStream([]),
        stdin,
        exited: Promise.resolve(0),
        kill() {},
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn);

    const handle = await adapter.startSession({
      threadId: "thread-1",
      cwd: "/tmp/project",
      model: "claude-sonnet-4-6",
      reasoningEffort: "medium",
      prompt: "Inspect the project",
      systemPrompt: "Stay concise.",
      allowedTools: ["Bash", "Read"],
      env: { FOO: "bar", CLAUDECODE: "nested" },
    });

    const events = await collectEvents(handle.events);

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.command).toEqual([
      "claude",
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      "claude-sonnet-4-6",
      "--append-system-prompt",
      "Stay concise.",
      "--append-system-prompt",
      "[orka session: thread-1]",
      "--allowedTools",
      "Bash,Read",
      "--effort",
      "medium",
    ]);
    expect(spawnCalls[0]?.options["cwd"]).toBe("/tmp/project");
    const env = spawnCalls[0]?.options["env"];
    expect(
      typeof env === "object" && env !== null
        ? (env as Record<string, unknown>)["FOO"]
        : undefined,
    ).toBe("bar");
    expect(
      typeof env === "object" && env !== null
        ? (env as Record<string, unknown>)["CLAUDECODE"]
        : undefined,
    ).toBeUndefined();
    expect(stdin.writes).toHaveLength(1);
    const firstWrite = stdin.writes[0];
    if (!firstWrite) throw new Error("expected first write");
    const sentMsg = JSON.parse(firstWrite);
    expect(sentMsg).toEqual({
      type: "user",
      message: { role: "user", content: "Inspect the project" },
      parent_tool_use_id: null,
    });
    // Stdin stays open — all sessions are multi-turn
    expect(stdin.ended).toBe(false);

    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "turn.started",
      "content.delta",
      "item.started",
      "item.completed",
      "turn.completed",
      "session.exited",
    ]);

    const turnStarted = events[1];
    expect(turnStarted?.type).toBe("turn.started");
    expect(turnStarted?.payload).toEqual({ model: "claude-sonnet-4-6" });

    const turnScopedEvents = events.filter((event) =>
      event.type === "turn.started" ||
      event.type === "content.delta" ||
      event.type === "item.started" ||
      event.type === "item.completed" ||
      event.type === "turn.completed",
    );
    const turnIds = turnScopedEvents.map((event) => event.turnId);

    expect(turnIds[0]).toMatch(/^turn-/);
    expect(turnIds.every((turnId) => turnId === turnIds[0])).toBe(true);
  });

  test("sendTurn sends JSON message and new turn events are emitted on system:init", async () => {
    const stdin = new MockWritableSink();

    const adapter = new ClaudeCodeAdapter((() => {
      return {
        stdout: createJsonLineStream([
          // Turn 1
          { type: "system", subtype: "init", message: "Claude Code started" },
          {
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "Done with turn 1." }] },
          },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            total_cost_usd: 0.05,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
          // Turn 2 (triggered by sendTurn)
          { type: "system", subtype: "init", message: "Claude Code started" },
          {
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "Done with turn 2." }] },
          },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            total_cost_usd: 0.08,
            usage: { input_tokens: 20, output_tokens: 10 },
          },
        ]),
        stderr: createTextStream([]),
        stdin,
        exited: Promise.resolve(0),
        kill() {},
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn);

    const handle = await adapter.startSession({
      threadId: "thread-2",
      model: "claude-sonnet-4-6",
      prompt: "First task",
    });

    // sendTurn writes a second JSON message to stdin
    await adapter.sendTurn(handle, { input: "Second task" });

    // Process exits naturally after stdout is consumed
    const events = await collectEvents(handle.events);

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "session.started",  // turn 1 init
      "turn.started",     // turn 1
      "content.delta",    // turn 1 text
      "turn.completed",   // turn 1 result
      "session.started",  // turn 2 init
      "turn.started",     // turn 2
      "content.delta",    // turn 2 text
      "turn.completed",   // turn 2 result
      "session.exited",   // from process exit
    ]);

    // Turn 1 and Turn 2 should have different turnIds
    const turnStartedEvents = events.filter((e) => e.type === "turn.started");
    expect(turnStartedEvents).toHaveLength(2);
    const turn0 = turnStartedEvents[0];
    const turn1 = turnStartedEvents[1];
    if (!turn0 || !turn1) throw new Error("expected two turn started events");
    expect(turn0.turnId).toMatch(/^turn-/);
    expect(turn1.turnId).toMatch(/^turn-/);
    expect(turn0.turnId).not.toBe(turn1.turnId);

    // sendTurn should have written a JSON message
    expect(stdin.writes).toHaveLength(2);
    const secondWrite = stdin.writes[1];
    if (!secondWrite) throw new Error("expected second write");
    const secondMsg = JSON.parse(secondWrite);
    expect(secondMsg).toEqual({
      type: "user",
      message: { role: "user", content: "Second task" },
      parent_tool_use_id: null,
    });

    // stdin stays open (not ended by sendTurn or process exit)
    expect(stdin.ended).toBe(false);
  });
});

async function collectEvents(events: AsyncIterable<ProviderRuntimeEvent>): Promise<ProviderRuntimeEvent[]> {
  const collected: ProviderRuntimeEvent[] = [];
  const iterator = events[Symbol.asyncIterator]();

  while (true) {
    const result = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for Claude adapter event")), 200);
      }),
    ]);

    if (result.done) {
      return collected;
    }

    collected.push(result.value);
  }
}

class MockWritableSink {
  writes: string[] = [];
  ended = false;
  private onEnd: (() => void) | undefined;

  constructor(onEnd?: () => void) {
    this.onEnd = onEnd;
  }

  write(value: string): void {
    this.writes.push(value);
  }

  end(): void {
    this.ended = true;
    this.onEnd?.();
  }
}

function createJsonLineStream(events: unknown[]): ReadableStream<Uint8Array> {
  return createTextStream(events.map((event) => JSON.stringify(event)));
}

function createTextStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
}
