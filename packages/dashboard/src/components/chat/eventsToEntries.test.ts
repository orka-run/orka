import { describe, expect, test } from "bun:test";
import type { OrchestrationEvent } from "@orka/core";
import { eventsToEntries } from "./eventsToEntries";

describe("eventsToEntries", () => {
  test("marks queued user input as pending until the next turn restarts", () => {
    const queuedOnly: OrchestrationEvent[] = [
      {
        type: "user.input",
        sessionId: "s1",
        text: "follow up",
        queued: true,
        timestamp: "2026-03-11T00:00:05Z",
      },
    ];

    expect(eventsToEntries(queuedOnly)).toContainEqual({
      id: "user-input-s1-2026-03-11T00:00:05Z",
      type: "user",
      timestamp: "2026-03-11T00:00:05Z",
      body: "follow up",
      queued: true,
    });

    const delivered: OrchestrationEvent[] = [
      ...queuedOnly,
      {
        type: "turn.completed",
        sessionId: "s1",
        turnId: "turn-1",
        timestamp: "2026-03-11T00:00:10Z",
      },
      {
        type: "turn.started",
        sessionId: "s1",
        turnId: "turn-2",
        timestamp: "2026-03-11T00:00:11Z",
      },
      {
        type: "content.delta",
        sessionId: "s1",
        turnId: "turn-2",
        streamKind: "assistant_text",
        delta: "On it",
        timestamp: "2026-03-11T00:00:12Z",
      },
    ];

    const deliveredEntry = eventsToEntries(delivered).find((entry) => entry.id === "user-input-s1-2026-03-11T00:00:05Z");
    expect(deliveredEntry).toMatchObject({
      id: "user-input-s1-2026-03-11T00:00:05Z",
      type: "user",
      timestamp: "2026-03-11T00:00:05Z",
      body: "follow up",
      queued: false,
    });
  });
});
