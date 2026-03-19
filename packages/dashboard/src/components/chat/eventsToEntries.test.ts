import { describe, expect, test } from "bun:test";
import type { OrchestrationEvent } from "@orka/core";
import { eventsToEntries } from "./eventsToEntries";

describe("eventsToEntries", () => {
  test("renders seven-day quota warnings as usage budget entries", () => {
    const realNow = Date.now;
    Date.now = () => new Date("2026-03-18T13:00:00Z").getTime();
    try {
      const entries = eventsToEntries([
        {
          type: "session.rate_limited",
          sessionId: "s1",
          timestamp: "2026-03-18T13:00:00Z",
          status: "allowed_warning",
          resetsAt: Math.floor(new Date("2026-03-18T15:00:00Z").getTime() / 1000),
          rateLimitType: "seven_day",
          utilization: 0.78,
        },
      ]);

      expect(entries).toContainEqual({
        id: "rate-limit-2026-03-18T13:00:00Z",
        type: "rate-limit",
        timestamp: "2026-03-18T13:00:00Z",
        title: "Usage warning",
        body: "Usage: 78% of 7d budget (resets in 2h)",
        tone: "warning",
        limitKind: "usage",
      });
    } finally {
      Date.now = realNow;
    }
  });

  test("renders rate limit retries separately from usage budget warnings", () => {
    const entries = eventsToEntries([
      {
        type: "session.api_retry",
        sessionId: "s1",
        timestamp: "2026-03-18T13:00:00Z",
        attempt: 2,
        maxAttempts: 10,
        error: "rate_limit_error",
        delayMs: 2_000,
      },
    ]);

    expect(entries).toContainEqual({
      id: "api-retry-2026-03-18T13:00:00Z-2",
      type: "api-retry",
      timestamp: "2026-03-18T13:00:00Z",
      body: "Rate limited - retrying in 2s (attempt 2/10)",
    });
  });

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
