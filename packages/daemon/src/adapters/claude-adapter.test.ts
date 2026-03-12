import { describe, expect, test } from "bun:test";
import type { ProviderRuntimeEvent } from "@orka/core";
import { ClaudeCodeAdapter, mapClaudeEvent } from "./claude-adapter";

describe("mapClaudeEvent", () => {
  test("maps system init to session.started", () => {
    const event = mapClaudeEvent("thread-1", {
      type: "system",
      subtype: "init",
      message: "Claude Code started",
    });

    expect(event).not.toBeNull();
    expect(event?.type).toBe("session.started");
    expect(event?.provider).toBe("claude-code");
    expect(event?.threadId).toBe("thread-1");
    expect(event?.payload).toEqual({ message: "Claude Code started" });
  });

  test("maps assistant text to content.delta", () => {
    const event = mapClaudeEvent("thread-1", {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I'll inspect the file." }],
      },
    }, { turnId: "turn-1" });

    expect(event).not.toBeNull();
    expect(event?.type).toBe("content.delta");
    expect(event?.turnId).toBe("turn-1");
    expect(event?.payload).toEqual({
      streamKind: "assistant_text",
      delta: "I'll inspect the file.",
    });
  });

  test("maps assistant tool_use to item.started with the correct item type", () => {
    const commandEvent = mapClaudeEvent("thread-1", {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls -la" } }],
      },
    }, { turnId: "turn-1" });
    const fileEvent = mapClaudeEvent("thread-1", {
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
    });

    expect(fileEvent?.type).toBe("item.started");
    expect(fileEvent?.turnId).toBe("turn-1");
    expect(fileEvent?.itemId).toBe("tool-2");
    expect(fileEvent?.payload).toEqual({
      itemType: "file_change",
      status: "in_progress",
      title: "src/index.ts",
      detail: "src/index.ts",
    });
  });

  test("maps result to turn.completed with cost and tokens", () => {
    const event = mapClaudeEvent("thread-1", {
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

    expect(event).not.toBeNull();
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
    const event = mapClaudeEvent(
      "thread-1",
      {
        type: "result",
        subtype: "success",
        is_error: false,
      },
      "exit",
    );

    expect(event).not.toBeNull();
    expect(event?.type).toBe("session.exited");
    expect(event?.payload).toEqual({
      reason: "Claude Code result: success",
      exitKind: "graceful",
    });
  });

  test("returns null for unknown event types", () => {
    expect(mapClaudeEvent("thread-1", { type: "unknown.event" })).toBeNull();
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
      "auto",
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
    const sentMsg = JSON.parse(stdin.writes[0]!);
    expect(sentMsg).toEqual({
      type: "user",
      message: { role: "user", content: "Inspect the project" },
      parent_tool_use_id: null,
    });
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
    expect(turnStartedEvents[0]!.turnId).toMatch(/^turn-/);
    expect(turnStartedEvents[1]!.turnId).toMatch(/^turn-/);
    expect(turnStartedEvents[0]!.turnId).not.toBe(turnStartedEvents[1]!.turnId);

    // sendTurn should have written a JSON message
    expect(stdin.writes).toHaveLength(2);
    const secondMsg = JSON.parse(stdin.writes[1]!);
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
        setTimeout(() => reject(new Error("Timed out waiting for Claude adapter event")), 2_000);
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
  private onEnd?: () => void;

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
