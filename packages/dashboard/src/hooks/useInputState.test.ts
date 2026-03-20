import { describe, expect, test } from "bun:test";
import type { OrchestrationEvent } from "@orka/core";
import { deriveInputState } from "./useInputState";

function createEvent(event: OrchestrationEvent): OrchestrationEvent {
  return event;
}

describe("deriveInputState", () => {
  test("returns disabled when sendTurn not in allowedActions", () => {
    expect(deriveInputState([], [])).toBe("not_started");
    expect(deriveInputState([createEvent({ type: "session.started", sessionId: "s", timestamp: "t" })], [])).toBe("disabled");
  });

  test("returns waiting when sendTurn allowed but no events", () => {
    expect(deriveInputState([], ["sendTurn"])).toBe("waiting");
  });

  test("returns busy when a turn has started but not completed", () => {
    const events: OrchestrationEvent[] = [
      createEvent({ type: "turn.started", sessionId: "s", turnId: "t1", timestamp: "t" }),
    ];
    expect(deriveInputState(events, ["sendTurn"])).toBe("busy");
  });

  test("returns waiting after turn completes", () => {
    const events: OrchestrationEvent[] = [
      createEvent({ type: "turn.started", sessionId: "s", turnId: "t1", timestamp: "t" }),
      createEvent({ type: "turn.completed", sessionId: "s", turnId: "t1", timestamp: "t" }),
    ];
    expect(deriveInputState(events, ["sendTurn"])).toBe("waiting");
  });

  test("returns waiting when sendTurn allowed and no open turns", () => {
    const events: OrchestrationEvent[] = [
      createEvent({ type: "session.started", sessionId: "s", timestamp: "t" }),
    ];
    expect(deriveInputState(events, ["sendTurn"])).toBe("waiting");
  });

  test("returns disabled when only stop allowed", () => {
    const events: OrchestrationEvent[] = [
      createEvent({ type: "session.started", sessionId: "s", timestamp: "t" }),
    ];
    expect(deriveInputState(events, ["stop"])).toBe("disabled");
  });
});
