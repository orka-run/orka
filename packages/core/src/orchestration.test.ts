import { describe, expect, test } from "bun:test";
import {
  KnownOrchestrationEventTypeSchema,
  WireOrchestrationEventSchema,
  parseWireEvent,
  normalizeEvent,
} from "./orchestration";

const BASE = {
  sessionId: "sess-abc123",
  timestamp: "2026-03-15T00:00:00.000Z",
};

describe("KnownOrchestrationEventTypeSchema", () => {
  test("accepts all known event types", () => {
    const known = [
      "session.created", "session.started", "session.state.changed",
      "session.completed", "session.failed", "session.cancelled",
      "turn.started", "turn.completed", "turn.aborted",
      "user.input", "content.delta",
      "item.started", "item.updated", "item.completed",
      "request.opened", "request.resolved",
      "tool.progress", "runtime.error", "runtime.warning",
      "session.rate_limited", "session.api_retry",
      "event.passthrough",
    ];
    for (const t of known) {
      expect(KnownOrchestrationEventTypeSchema.safeParse(t).success).toBe(true);
    }
  });

  test("rejects unknown event types", () => {
    expect(KnownOrchestrationEventTypeSchema.safeParse("something.new").success).toBe(false);
    expect(KnownOrchestrationEventTypeSchema.safeParse("").success).toBe(false);
  });
});

describe("WireOrchestrationEventSchema", () => {
  test("parses a valid session.created event", () => {
    const result = WireOrchestrationEventSchema.safeParse({
      ...BASE,
      type: "session.created",
      threadId: "thread-1",
      backend: "claude-code",
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("expected session.created to parse");
    }
    expect((result.data as { type: string }).type).toBe("session.created");
  });

  test("parses session.completed with null exitCode", () => {
    const result = WireOrchestrationEventSchema.safeParse({
      ...BASE,
      type: "session.completed",
      exitCode: null,
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("expected session.completed to parse");
    }
    expect((result.data as { type: string }).type).toBe("session.completed");
  });

  test("parses session.completed with numeric exitCode", () => {
    const result = WireOrchestrationEventSchema.safeParse({
      ...BASE,
      type: "session.completed",
      exitCode: 0,
    });
    expect(result.success).toBe(true);
  });

  test("parses turn.completed with optional fields", () => {
    const result = WireOrchestrationEventSchema.safeParse({
      ...BASE,
      type: "turn.completed",
      turnId: "turn-1",
      state: "completed",
      cost: 0.05,
      tokens: { input: 100, output: 200 },
    });
    expect(result.success).toBe(true);
  });

  test("parses content.delta event", () => {
    const result = WireOrchestrationEventSchema.safeParse({
      ...BASE,
      type: "content.delta",
      turnId: "turn-1",
      streamKind: "assistant_text",
      delta: "Hello world",
    });
    expect(result.success).toBe(true);
  });

  test("parses session.rate_limited event", () => {
    const result = WireOrchestrationEventSchema.safeParse({
      ...BASE,
      type: "session.rate_limited",
      status: "allowed_warning",
      resetsAt: 1773990000,
      rateLimitType: "seven_day",
      utilization: 0.78,
      surpassedThreshold: 0.75,
      isUsingOverage: false,
    });
    expect(result.success).toBe(true);
  });

  test("parses session.api_retry event", () => {
    const result = WireOrchestrationEventSchema.safeParse({
      ...BASE,
      type: "session.api_retry",
      attempt: 1,
      maxAttempts: 10,
      error: "overloaded_error",
      delayMs: 1000,
    });
    expect(result.success).toBe(true);
  });

  test("wraps known type with invalid variant fields as event.passthrough", () => {
    // session.created requires threadId + backend, omitting them causes variant failure
    const result = WireOrchestrationEventSchema.safeParse({
      ...BASE,
      type: "session.created",
      // missing threadId and backend
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("expected invalid known type to wrap as passthrough");
    }
    expect((result.data as { type: string }).type).toBe("event.passthrough");
    expect((result.data as any).originalType).toBe("session.created");
  });

  test("passes through unknown event types with base fields intact", () => {
    const result = WireOrchestrationEventSchema.safeParse({
      ...BASE,
      type: "future.event.v2",
      someNewField: 42,
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("expected future event to parse");
    }
    expect((result.data as { type: string }).type).toBe("future.event.v2");
  });

  test("preserves extra unknown fields via .passthrough()", () => {
    const result = WireOrchestrationEventSchema.safeParse({
      ...BASE,
      type: "session.started",
      customField: "preserved",
    });
    expect(result.success).toBe(true);
    expect((result.data as any).customField).toBe("preserved");
  });

  test("rejects events missing base fields", () => {
    const result = WireOrchestrationEventSchema.safeParse({
      type: "session.started",
      // missing sessionId and timestamp
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-object values", () => {
    expect(WireOrchestrationEventSchema.safeParse("string").success).toBe(false);
    expect(WireOrchestrationEventSchema.safeParse(42).success).toBe(false);
    expect(WireOrchestrationEventSchema.safeParse(null).success).toBe(false);
  });
});

describe("parseWireEvent", () => {
  test("parses a valid session.started event", () => {
    const event = parseWireEvent({ ...BASE, type: "session.started" });
    expect(event).not.toBeNull();
    expect(event!.type).toBe("session.started");
    expect(event!.sessionId).toBe("sess-abc123");
  });

  test("sets v to 1 when absent", () => {
    const event = parseWireEvent({ ...BASE, type: "session.started" });
    expect(event!.v).toBe(1);
  });

  test("preserves existing v value", () => {
    const event = parseWireEvent({ ...BASE, type: "session.started", v: 2 });
    expect(event!.v).toBe(2);
  });

  test("wraps unknown event type as event.passthrough", () => {
    const event = parseWireEvent({
      ...BASE,
      type: "brand.new.event",
      customData: { foo: "bar" },
    });
    expect(event).not.toBeNull();
    expect(event!.type).toBe("event.passthrough");
    expect((event as any).originalType).toBe("brand.new.event");
    expect((event as any).rawPayload).toHaveProperty("customData");
  });

  test("returns null for non-object input", () => {
    expect(parseWireEvent("not an object")).toBeNull();
    expect(parseWireEvent(42)).toBeNull();
    expect(parseWireEvent(null)).toBeNull();
    expect(parseWireEvent(undefined)).toBeNull();
  });

  test("returns null for objects missing required base fields", () => {
    expect(parseWireEvent({ type: "session.started" })).toBeNull();
    expect(parseWireEvent({ sessionId: "s1", timestamp: "t1" })).toBeNull();
  });

  test("parses runtime.error event", () => {
    const event = parseWireEvent({
      ...BASE,
      type: "runtime.error",
      error: "something broke",
      class: "provider_error",
      terminal: true,
    });
    expect(event).not.toBeNull();
    expect(event!.type).toBe("runtime.error");
    expect((event as any).error).toBe("something broke");
  });

  test("parses user.input event", () => {
    const event = parseWireEvent({
      ...BASE,
      type: "user.input",
      text: "hello agent",
      queued: true,
    });
    expect(event).not.toBeNull();
    expect(event!.type).toBe("user.input");
    expect((event as any).text).toBe("hello agent");
    expect((event as any).queued).toBe(true);
  });

  test("parses event.passthrough directly", () => {
    const event = parseWireEvent({
      ...BASE,
      type: "event.passthrough",
      originalType: "vendor.custom",
      rawPayload: { x: 1 },
    });
    expect(event).not.toBeNull();
    expect(event!.type).toBe("event.passthrough");
  });

  test("parses item.started with all fields", () => {
    const event = parseWireEvent({
      ...BASE,
      type: "item.started",
      turnId: "turn-1",
      itemId: "item-1",
      itemType: "command_execution",
      status: "in_progress",
      title: "Running bash",
      detail: "ls -la",
    });
    expect(event).not.toBeNull();
    expect(event!.type).toBe("item.started");
  });
});

describe("normalizeEvent", () => {
  test("sets v=1 when missing", () => {
    const result = normalizeEvent({ ...BASE, type: "session.started" });
    expect(result.v).toBe(1);
  });

  test("keeps existing v", () => {
    const result = normalizeEvent({ ...BASE, type: "session.started", v: 3 });
    expect(result.v).toBe(3);
  });

  test("returns known types as-is", () => {
    const result = normalizeEvent({ ...BASE, type: "session.failed", error: "boom" });
    expect(result.type).toBe("session.failed");
  });

  test("wraps unknown type as event.passthrough", () => {
    const result = normalizeEvent({
      ...BASE,
      type: "exotic.new.type",
      extra: "data",
    });
    expect(result.type).toBe("event.passthrough");
    expect((result as any).originalType).toBe("exotic.new.type");
    expect((result as any).rawPayload).toHaveProperty("extra");
  });

  test("preserves turnId in passthrough wrapper when present", () => {
    const result = normalizeEvent({
      ...BASE,
      type: "unknown.type",
      turnId: "turn-42",
      detail: "something",
    });
    expect(result.type).toBe("event.passthrough");
    expect((result as any).turnId).toBe("turn-42");
  });

  test("omits turnId in passthrough wrapper when absent", () => {
    const result = normalizeEvent({
      ...BASE,
      type: "unknown.type",
    });
    expect(result.type).toBe("event.passthrough");
    expect((result as any).turnId).toBeUndefined();
  });
});
