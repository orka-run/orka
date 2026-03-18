import { describe, expect, test } from "bun:test";
import type { ProviderRuntimeEvent } from "@orka/core";
import { mapProviderEvent } from "./ingestion";

describe("mapProviderEvent", () => {
  test("maps rate.limit events to session.rate_limited", () => {
    const event = {
      eventId: "evt-rate-limit",
      provider: "claude-code",
      threadId: "thread-1",
      createdAt: "2026-03-18T00:00:00.000Z",
      type: "rate.limit",
      payload: {
        rateLimitInfo: {
          status: "allowed_warning",
          resetsAt: 1773990000,
          rateLimitType: "seven_day",
          utilization: 0.78,
          surpassedThreshold: 0.75,
          isUsingOverage: false,
        },
      },
    } as unknown as ProviderRuntimeEvent;

    const mapped = mapProviderEvent("session-1", event);

    expect(mapped).toEqual({
      v: 1,
      eventId: "evt-rate-limit",
      type: "session.rate_limited",
      sessionId: "session-1",
      status: "allowed_warning",
      resetsAt: 1773990000,
      rateLimitType: "seven_day",
      utilization: 0.78,
      surpassedThreshold: 0.75,
      isUsingOverage: false,
      timestamp: "2026-03-18T00:00:00.000Z",
    });
  });

  test("maps api.retry events to session.api_retry", () => {
    const event = {
      eventId: "evt-api-retry",
      provider: "claude-code",
      threadId: "thread-1",
      createdAt: "2026-03-18T00:00:01.000Z",
      type: "api.retry",
      payload: {
        attempt: 1,
        maxAttempts: 10,
        error: "overloaded_error",
        delayMs: 1000,
      },
    } as unknown as ProviderRuntimeEvent;

    const mapped = mapProviderEvent("session-1", event);

    expect(mapped).toEqual({
      v: 1,
      eventId: "evt-api-retry",
      type: "session.api_retry",
      sessionId: "session-1",
      attempt: 1,
      maxAttempts: 10,
      error: "overloaded_error",
      delayMs: 1000,
      timestamp: "2026-03-18T00:00:01.000Z",
    });
  });

  test("maps unknown provider events to event.passthrough", () => {
    const rawPayload = {
      foo: "bar",
      nested: {
        count: 2,
      },
    };
    const event = {
      eventId: "evt-unknown",
      provider: "claude-code",
      threadId: "thread-1",
      createdAt: "2026-03-13T00:00:00.000Z",
      turnId: "turn-1",
      type: "provider.future.event",
      payload: rawPayload,
    } as unknown as ProviderRuntimeEvent;

    const mapped = mapProviderEvent("session-1", event);

    expect(mapped).toEqual({
      eventId: "evt-unknown",
      type: "event.passthrough",
      sessionId: "session-1",
      turnId: "turn-1",
      originalType: "provider.future.event",
      provider: "claude-code",
      rawPayload: {
        payload: rawPayload,
        eventId: "evt-unknown",
        threadId: "thread-1",
      },
      timestamp: "2026-03-13T00:00:00.000Z",
    });
    if (mapped.type !== "event.passthrough") {
      throw new Error("expected passthrough event");
    }
    expect((mapped.rawPayload as any).payload).toBe(rawPayload);
  });
});
