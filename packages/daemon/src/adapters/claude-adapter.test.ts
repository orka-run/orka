import { describe, expect, test } from "bun:test";
import { mapClaudeEvent } from "./claude-adapter";

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
    });

    expect(event).not.toBeNull();
    expect(event?.type).toBe("content.delta");
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
    });
    const fileEvent = mapClaudeEvent("thread-1", {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-2", name: "Read", input: { file_path: "src/index.ts" } }],
      },
    });

    expect(commandEvent?.type).toBe("item.started");
    expect(commandEvent?.itemId).toBe("tool-1");
    expect(commandEvent?.payload).toEqual({
      itemType: "command_execution",
      status: "in_progress",
      title: "ls -la",
      detail: "ls -la",
    });

    expect(fileEvent?.type).toBe("item.started");
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
    });

    expect(event).not.toBeNull();
    expect(event?.type).toBe("turn.completed");
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
