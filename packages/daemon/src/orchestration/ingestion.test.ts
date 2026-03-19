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

  test("maps task, hook, status, and compaction events", () => {
    const taskStarted = mapProviderEvent("session-1", {
      eventId: "evt-task-started",
      provider: "claude-code",
      threadId: "thread-1",
      createdAt: "2026-03-18T00:00:02.000Z",
      turnId: "turn-1",
      itemId: "tool-1",
      type: "task.started",
      payload: {
        taskId: "task-1",
        toolUseId: "tool-1",
        title: "Explore dashboard structure",
        detail: "Inspect chat timeline rendering",
        taskKind: "research",
      },
    } as unknown as ProviderRuntimeEvent);
    const hookResponse = mapProviderEvent("session-1", {
      eventId: "evt-hook-response",
      provider: "claude-code",
      threadId: "thread-1",
      createdAt: "2026-03-18T00:00:03.000Z",
      type: "hook.response",
      payload: {
        hookName: "SessionStart:startup",
        decision: "allowed",
      },
    } as unknown as ProviderRuntimeEvent);
    const sessionStatus = mapProviderEvent("session-1", {
      eventId: "evt-session-status",
      provider: "claude-code",
      threadId: "thread-1",
      createdAt: "2026-03-18T00:00:04.000Z",
      type: "session.status",
      payload: {
        status: "compacting",
        detail: "Preparing to trim context",
      },
    } as unknown as ProviderRuntimeEvent);
    const compacted = mapProviderEvent("session-1", {
      eventId: "evt-session-compacted",
      provider: "claude-code",
      threadId: "thread-1",
      createdAt: "2026-03-18T00:00:05.000Z",
      type: "session.compacted",
      payload: {
        tokenCountBefore: 120000,
        tokenCountAfter: 64000,
      },
    } as unknown as ProviderRuntimeEvent);

    expect(taskStarted).toEqual({
      v: 1,
      eventId: "evt-task-started",
      type: "task.started",
      sessionId: "session-1",
      turnId: "turn-1",
      itemId: "tool-1",
      taskId: "task-1",
      toolUseId: "tool-1",
      title: "Explore dashboard structure",
      detail: "Inspect chat timeline rendering",
      taskKind: "research",
      timestamp: "2026-03-18T00:00:02.000Z",
    });
    expect(hookResponse).toEqual({
      v: 1,
      eventId: "evt-hook-response",
      type: "hook.response",
      sessionId: "session-1",
      hookName: "SessionStart:startup",
      decision: "allowed",
      timestamp: "2026-03-18T00:00:03.000Z",
    });
    expect(sessionStatus).toEqual({
      v: 1,
      eventId: "evt-session-status",
      type: "session.status",
      sessionId: "session-1",
      status: "compacting",
      detail: "Preparing to trim context",
      timestamp: "2026-03-18T00:00:04.000Z",
    });
    expect(compacted).toEqual({
      v: 1,
      eventId: "evt-session-compacted",
      type: "session.compacted",
      sessionId: "session-1",
      tokenCountBefore: 120000,
      tokenCountAfter: 64000,
      timestamp: "2026-03-18T00:00:05.000Z",
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
