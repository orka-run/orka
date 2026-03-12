import { describe, expect, test } from "bun:test";
import type { OrchestrationEvent } from "@orka/core";
import { deriveInputState } from "./useInputState";

function createEvent(event: OrchestrationEvent): OrchestrationEvent {
  return event;
}

describe("deriveInputState", () => {
  test("returns disabled for terminal sessions", () => {
    expect(deriveInputState([], "completed", "codex")).toBe("disabled");
    expect(deriveInputState([], "failed", "codex")).toBe("disabled");
    expect(deriveInputState([], "cancelled", "codex")).toBe("disabled");
  });

  test("returns not_started when a queued or preparing session has no events", () => {
    expect(deriveInputState([], "queued", "codex")).toBe("not_started");
    expect(deriveInputState([], "preparing", "codex")).toBe("not_started");
  });

  test("returns busy when a turn has started but not completed", () => {
    const events: OrchestrationEvent[] = [
      createEvent({
        type: "turn.started",
        sessionId: "sess-1",
        turnId: "turn-1",
        timestamp: "2026-03-12T10:00:00.000Z",
      }),
    ];

    expect(deriveInputState(events, "running", "codex")).toBe("busy");
  });

  test("returns busy when an item has started but not completed", () => {
    const events: OrchestrationEvent[] = [
      createEvent({
        type: "turn.started",
        sessionId: "sess-1",
        turnId: "turn-1",
        timestamp: "2026-03-12T10:00:00.000Z",
      }),
      createEvent({
        type: "item.started",
        sessionId: "sess-1",
        turnId: "turn-1",
        itemId: "item-1",
        itemType: "command_execution",
        timestamp: "2026-03-12T10:00:01.000Z",
      }),
    ];

    expect(deriveInputState(events, "running", "codex")).toBe("busy");
  });

  test("returns waiting after the latest turn completes while the session is still active", () => {
    const events: OrchestrationEvent[] = [
      createEvent({
        type: "turn.started",
        sessionId: "sess-1",
        turnId: "turn-1",
        timestamp: "2026-03-12T10:00:00.000Z",
      }),
      createEvent({
        type: "item.started",
        sessionId: "sess-1",
        turnId: "turn-1",
        itemId: "item-1",
        itemType: "command_execution",
        timestamp: "2026-03-12T10:00:01.000Z",
      }),
      createEvent({
        type: "item.completed",
        sessionId: "sess-1",
        turnId: "turn-1",
        itemId: "item-1",
        itemType: "command_execution",
        timestamp: "2026-03-12T10:00:02.000Z",
      }),
      createEvent({
        type: "turn.completed",
        sessionId: "sess-1",
        turnId: "turn-1",
        timestamp: "2026-03-12T10:00:03.000Z",
      }),
    ];

    expect(deriveInputState(events, "running", "codex")).toBe("waiting");
  });

  test("falls back to disabled when no waiting or busy condition applies", () => {
    const events: OrchestrationEvent[] = [
      createEvent({
        type: "session.started",
        sessionId: "sess-1",
        timestamp: "2026-03-12T10:00:00.000Z",
      }),
    ];

    expect(deriveInputState(events, "running", "codex")).toBe("disabled");
  });
});
