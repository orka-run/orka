import { describe, expect, test } from "bun:test";
import type { ProviderRuntimeEvent } from "@orka/core";
import { mapProviderEvent } from "./ingestion";

describe("mapProviderEvent", () => {
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
    expect((mapped.rawPayload as any).payload).toBe(rawPayload);
  });
});
