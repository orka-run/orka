import { describe, test, expect } from "bun:test";
import { mapCodexEvent } from "./codex-adapter";

describe("mapCodexEvent", () => {
  test("maps session.started to a canonical session.started event", () => {
    const event = mapCodexEvent("thread-1", { type: "session.started" });

    expect(event).not.toBeNull();
    expect(event?.type).toBe("session.started");
    expect(event?.provider).toBe("codex");
    expect(event?.threadId).toBe("thread-1");
  });

  test("maps message.delta to assistant content delta", () => {
    const event = mapCodexEvent("thread-1", { type: "message.delta", delta: "hello" });

    expect(event).not.toBeNull();
    expect(event?.type).toBe("content.delta");
    expect(event?.payload).toEqual({
      streamKind: "assistant_text",
      delta: "hello",
    });
  });

  test("maps turn.completed to canonical usage payload", () => {
    const event = mapCodexEvent("thread-1", {
      type: "turn.completed",
      usage: { input_tokens: 12, output_tokens: 34 },
    });

    expect(event).not.toBeNull();
    expect(event?.type).toBe("turn.completed");
    expect(event?.payload).toEqual({
      state: "completed",
      usage: {
        inputTokens: 12,
        outputTokens: 34,
      },
    });
  });

  test("maps command.start to item.started", () => {
    const event = mapCodexEvent("thread-1", {
      type: "command.start",
      command: "ls -la",
    });

    expect(event).not.toBeNull();
    expect(event?.type).toBe("item.started");
    expect(event?.payload).toEqual({
      itemType: "command_execution",
      status: "in_progress",
      title: "ls -la",
      detail: "ls -la",
    });
  });

  test("returns null for unknown event types", () => {
    expect(mapCodexEvent("thread-1", { type: "unknown.event" })).toBeNull();
  });
});
