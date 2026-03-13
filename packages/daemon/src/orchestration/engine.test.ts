import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { createEvent, type OrchestrationEvent, type ProviderRuntimeEvent } from "@orka/core";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTracing } from "../tracing";
import { OrchestrationEngine } from "./engine";

const previousOrkaHome = process.env["ORKA_HOME"];
let testHome = "";

function versioned<T extends Record<string, unknown>>(event: T): T & { v: number } {
  return {
    ...event,
    v: 1,
  };
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "orka-engine-home-"));
  process.env["ORKA_HOME"] = testHome;
  initTracing();
});

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true });
  if (previousOrkaHome === undefined) {
    delete process.env["ORKA_HOME"];
  } else {
    process.env["ORKA_HOME"] = previousOrkaHome;
  }
});

describe("OrchestrationEngine", () => {
  test("ingests session.started and notifies listeners with the mapped event", () => {
    const engine = new OrchestrationEngine();
    const received: unknown[] = [];

    const unsubscribe = engine.onEvent((event) => {
      received.push(event);
    });

    engine.ingest(
      "session-1",
      createEvent("session.started", "thread-1", {}, { createdAt: "2026-03-11T00:00:00.000Z" }),
    );

    unsubscribe();

    expect(received).toEqual([
      versioned({
        type: "session.started",
        sessionId: "session-1",
        timestamp: "2026-03-11T00:00:00.000Z",
      }),
    ]);
  });

  test("stores content.delta events in the append-only log", () => {
    const engine = new OrchestrationEngine();

    engine.ingest(
      "session-1",
      createEvent(
        "content.delta",
        "thread-1",
        { streamKind: "assistant_text", delta: "Hello" },
        { turnId: "turn-1", createdAt: "2026-03-11T00:01:00.000Z" },
      ),
    );

    expect(engine.getSessionEvents("session-1")).toEqual([
      versioned({
        type: "content.delta",
        sessionId: "session-1",
        turnId: "turn-1",
        streamKind: "assistant_text",
        delta: "Hello",
        timestamp: "2026-03-11T00:01:00.000Z",
      }),
    ]);
  });

  test("persists mapped events with provider metadata when configured", () => {
    const persisted: unknown[] = [];
    const engine = new OrchestrationEngine({
      persistEvent: (event) => {
        persisted.push(event);
      },
    });

    engine.ingest(
      "session-1",
      createEvent(
        "session.started",
        "thread-1",
        {},
        {
          eventId: "evt-1",
          provider: "codex",
          createdAt: "2026-03-11T00:00:00.000Z",
        },
      ),
    );

    expect(persisted).toEqual([
      versioned({
        eventId: "evt-1",
        provider: "codex",
        type: "session.started",
        sessionId: "session-1",
        timestamp: "2026-03-11T00:00:00.000Z",
      }),
    ]);
  });

  test("persists unknown provider events as passthrough events", () => {
    const persisted: unknown[] = [];
    const engine = new OrchestrationEngine({
      persistEvent: (event) => {
        persisted.push(event);
      },
    });

    const rawPayload = {
      code: "future_event",
      detail: {
        value: 42,
      },
    };

    engine.ingest(
      "session-1",
      {
        eventId: "evt-passthrough",
        provider: "claude-code",
        threadId: "thread-1",
        createdAt: "2026-03-13T00:00:00.000Z",
        type: "provider.future.event",
        payload: rawPayload,
      } as unknown as ProviderRuntimeEvent,
    );

    const expectedRawPayload = {
      payload: rawPayload,
      eventId: "evt-passthrough",
      threadId: "thread-1",
    };

    expect(engine.getSessionEvents("session-1")).toEqual([
      {
        v: 1,
        type: "event.passthrough",
        sessionId: "session-1",
        originalType: "provider.future.event",
        provider: "claude-code",
        rawPayload: expectedRawPayload,
        timestamp: "2026-03-13T00:00:00.000Z",
      },
    ]);
    expect(persisted).toEqual([
      {
        v: 1,
        eventId: "evt-passthrough",
        provider: "claude-code",
        type: "event.passthrough",
        sessionId: "session-1",
        originalType: "provider.future.event",
        rawPayload: expectedRawPayload,
        timestamp: "2026-03-13T00:00:00.000Z",
      },
    ]);
  });

  test("filters events by session id", () => {
    const engine = new OrchestrationEngine();

    engine.ingest(
      "session-1",
      createEvent("session.started", "thread-1", {}, { createdAt: "2026-03-11T00:00:00.000Z" }),
    );
    engine.ingest(
      "session-2",
      createEvent("session.started", "thread-2", {}, { createdAt: "2026-03-11T00:00:01.000Z" }),
    );

    expect(engine.getSessionEvents("session-1")).toEqual([
      versioned({
        type: "session.started",
        sessionId: "session-1",
        timestamp: "2026-03-11T00:00:00.000Z",
      }),
    ]);
  });

  test("loads persisted session timelines into the in-memory log", () => {
    const timeline: OrchestrationEvent[] = [
      {
        type: "session.started",
        sessionId: "session-1",
        timestamp: "2026-03-11T00:00:00.000Z",
      },
      {
        type: "content.delta",
        sessionId: "session-1",
        turnId: "turn-1",
        streamKind: "assistant_text",
        delta: "Hello",
        timestamp: "2026-03-11T00:00:01.000Z",
      },
    ];

    const engine = new OrchestrationEngine({
      getSessionTimeline: (sessionId) => (sessionId === "session-1" ? [...timeline] : []),
    });

    expect(engine.getSessionTimeline("session-1")).toEqual(timeline);
    expect(engine.loadSessionEvents("session-1")).toEqual(timeline);
    expect(engine.getSessionEvents("session-1")).toEqual(timeline);
  });

  test("projects session status across started, running, and completed states", () => {
    const engine = new OrchestrationEngine();

    expect(engine.getSessionState("session-1")).toEqual({
      sessionId: "session-1",
      status: "queued",
      currentTurnId: null,
      totalCost: 0,
      totalTokens: { input: 0, output: 0 },
      pendingRequests: [],
      timeToFirstOutputMs: null,
      bootTimeMs: null,
      avgTurnDurationMs: null,
      totalActiveDurationMs: null,
    });

    engine.ingest(
      "session-1",
      createEvent("session.started", "thread-1", {}, { createdAt: "2026-03-11T00:00:00.000Z" }),
    );
    expect(engine.getSessionState("session-1").status).toBe("running");

    engine.ingest(
      "session-1",
      createEvent("turn.started", "thread-1", {}, { turnId: "turn-1", createdAt: "2026-03-11T00:00:01.000Z" }),
    );
    expect(engine.getSessionState("session-1")).toMatchObject({
      status: "running",
      currentTurnId: "turn-1",
    });

    engine.ingest(
      "session-1",
      createEvent("session.exited", "thread-1", { exitKind: "graceful" }, { createdAt: "2026-03-11T00:00:02.000Z" }),
    );
    expect(engine.getSessionState("session-1")).toMatchObject({
      status: "completed",
      currentTurnId: null,
    });
  });

  test("maps provider error exits to failed and graceful exits to completed", () => {
    const failedEngine = new OrchestrationEngine();
    failedEngine.ingest(
      "session-failed",
      createEvent(
        "session.exited",
        "thread-1",
        { exitKind: "error", reason: "provider crashed" },
        { createdAt: "2026-03-11T00:02:00.000Z" },
      ),
    );

    expect(failedEngine.getSessionEvents("session-failed")).toEqual([
      versioned({
        type: "session.failed",
        sessionId: "session-failed",
        error: "provider crashed",
        timestamp: "2026-03-11T00:02:00.000Z",
      }),
    ]);
    expect(failedEngine.getSessionState("session-failed").status).toBe("failed");

    const completedEngine = new OrchestrationEngine();
    completedEngine.ingest(
      "session-completed",
      createEvent(
        "session.exited",
        "thread-1",
        { exitKind: "graceful", reason: "done" },
        { createdAt: "2026-03-11T00:02:01.000Z" },
      ),
    );

    expect(completedEngine.getSessionState("session-completed").status).toBe("completed");
  });

  test("maps user-initiated stops to cancelled", () => {
    const engine = new OrchestrationEngine();

    engine.ingest(
      "session-1",
      createEvent(
        "session.exited",
        "thread-1",
        { exitKind: "graceful", reason: "stopped" },
        { createdAt: "2026-03-11T00:02:00.000Z" },
      ),
    );

    expect(engine.getSessionEvents("session-1")).toEqual([
      versioned({
        type: "session.cancelled",
        sessionId: "session-1",
        reason: "stopped",
        timestamp: "2026-03-11T00:02:00.000Z",
      }),
    ]);
    expect(engine.getSessionState("session-1").status).toBe("cancelled");
  });

  test("broadcasts orchestration events and final session state when pushHub is configured", () => {
    const broadcasts: Array<{ channel: string; data: unknown }> = [];
    const engine = new OrchestrationEngine({
      pushHub: {
        broadcast(channel: string, data: unknown) {
          broadcasts.push({ channel, data });
        },
      } as never,
    });

    engine.ingest(
      "session-1",
      createEvent(
        "session.exited",
        "thread-1",
        { exitKind: "graceful", reason: "done" },
        { createdAt: "2026-03-11T00:02:01.000Z" },
      ),
    );

    expect(broadcasts).toEqual([
      {
        channel: "orchestration.event",
        data: {
          v: 1,
          type: "session.completed",
          sessionId: "session-1",
          exitCode: null,
          timestamp: "2026-03-11T00:02:01.000Z",
        },
      },
      {
        channel: "orchestration.sessionUpdated",
        data: {
          sessionId: "session-1",
          status: "completed",
        },
      },
    ]);
  });

  test("accumulates turn cost and tokens in the session projection", () => {
    const engine = new OrchestrationEngine();

    engine.ingest(
      "session-1",
      createEvent(
        "turn.completed",
        "thread-1",
        {
          state: "completed",
          totalCostUsd: 1.25,
          usage: { inputTokens: 100, outputTokens: 50 },
        },
        { turnId: "turn-1", createdAt: "2026-03-11T00:02:00.000Z" },
      ),
    );
    engine.ingest(
      "session-1",
      createEvent(
        "turn.completed",
        "thread-1",
        {
          state: "completed",
          totalCostUsd: 0.75,
          usage: { inputTokens: 40, outputTokens: 20 },
        },
        { turnId: "turn-2", createdAt: "2026-03-11T00:03:00.000Z" },
      ),
    );

    expect(engine.getSessionState("session-1")).toEqual({
      sessionId: "session-1",
      status: "running",
      currentTurnId: null,
      totalCost: 2,
      totalTokens: { input: 140, output: 70 },
      pendingRequests: [],
      timeToFirstOutputMs: null,
      bootTimeMs: null,
      avgTurnDurationMs: null,
      totalActiveDurationMs: null,
    });
  });

  test("computes lifecycle timing metrics and emits them on session exit", () => {
    const engine = new OrchestrationEngine({
      getSessionTimeline: (sessionId) =>
        sessionId === "session-1"
          ? [
              {
                type: "session.created",
                sessionId,
                threadId: "thread-1",
                backend: "codex",
                timestamp: "2026-03-11T00:00:00.000Z",
              },
            ]
          : [],
    });

    engine.loadSessionEvents("session-1");
    engine.ingest(
      "session-1",
      createEvent("session.started", "thread-1", {}, { createdAt: "2026-03-11T00:00:01.000Z" }),
    );
    engine.ingest(
      "session-1",
      createEvent("turn.started", "thread-1", {}, { turnId: "turn-1", createdAt: "2026-03-11T00:00:02.000Z" }),
    );
    engine.ingest(
      "session-1",
      createEvent(
        "content.delta",
        "thread-1",
        { streamKind: "assistant_text", delta: "hello" },
        { turnId: "turn-1", createdAt: "2026-03-11T00:00:04.000Z" },
      ),
    );
    engine.ingest(
      "session-1",
      createEvent(
        "turn.completed",
        "thread-1",
        { state: "completed" },
        { turnId: "turn-1", createdAt: "2026-03-11T00:00:07.000Z" },
      ),
    );
    engine.ingest(
      "session-1",
      createEvent("session.exited", "thread-1", { exitKind: "graceful" }, { createdAt: "2026-03-11T00:00:11.000Z" }),
    );

    expect(engine.getSessionState("session-1")).toMatchObject({
      status: "completed",
      bootTimeMs: 1000,
      timeToFirstOutputMs: 3000,
      avgTurnDurationMs: 5000,
      totalActiveDurationMs: 10000,
    });

    const lifecycleTimingSpan = [...readTraceEntries()]
      .reverse()
      .find((entry) => entry.name === "orka.session.lifecycle_timing");
    expect(lifecycleTimingSpan).toMatchObject({
      attributes: {
        "orka.session.id": "session-1",
        "orka.timing.boot_ms": 1000,
        "orka.timing.ttfo_ms": 3000,
        "orka.timing.total_active_ms": 10000,
        "orka.timing.avg_turn_ms": 5000,
        "orka.timing.turn_count": 1,
      },
    });
  });

  test("keeps timing metrics null while lifecycle milestones are incomplete", () => {
    const engine = new OrchestrationEngine({
      getSessionTimeline: (sessionId) =>
        sessionId === "session-1"
          ? [
              {
                type: "session.created",
                sessionId,
                threadId: "thread-1",
                backend: "codex",
                timestamp: "2026-03-11T00:00:00.000Z",
              },
            ]
          : [],
    });

    engine.loadSessionEvents("session-1");
    engine.ingest(
      "session-1",
      createEvent("session.started", "thread-1", {}, { createdAt: "2026-03-11T00:00:01.000Z" }),
    );
    engine.ingest(
      "session-1",
      createEvent("turn.started", "thread-1", {}, { turnId: "turn-1", createdAt: "2026-03-11T00:00:02.000Z" }),
    );

    expect(engine.getSessionState("session-1")).toMatchObject({
      bootTimeMs: 1000,
      timeToFirstOutputMs: null,
      avgTurnDurationMs: null,
      totalActiveDurationMs: null,
    });
  });

  test("stores item lifecycle events and keeps the session running", () => {
    const engine = new OrchestrationEngine();

    engine.ingest(
      "session-1",
      createEvent("session.started", "thread-1", {}, { createdAt: "2026-03-11T00:03:00.000Z" }),
    );
    engine.ingest(
      "session-1",
      createEvent(
        "item.started",
        "thread-1",
        {
          itemType: "command_execution",
          status: "in_progress",
          title: "ls -la",
          detail: "ls -la",
        },
        {
          turnId: "turn-1",
          itemId: "item-1",
          createdAt: "2026-03-11T00:03:01.000Z",
        },
      ),
    );
    engine.ingest(
      "session-1",
      createEvent(
        "item.updated",
        "thread-1",
        {
          itemType: "command_execution",
          status: "in_progress",
          detail: "still running",
        },
        {
          turnId: "turn-1",
          itemId: "item-1",
          createdAt: "2026-03-11T00:03:02.000Z",
        },
      ),
    );
    engine.ingest(
      "session-1",
      createEvent(
        "item.completed",
        "thread-1",
        {
          itemType: "command_execution",
          status: "completed",
          detail: "finished",
        },
        {
          turnId: "turn-1",
          itemId: "item-1",
          createdAt: "2026-03-11T00:03:03.000Z",
        },
      ),
    );

    expect(engine.getSessionEvents("session-1")).toMatchObject([
      {
        type: "session.started",
        sessionId: "session-1",
      },
      {
        type: "item.started",
        sessionId: "session-1",
        turnId: "turn-1",
        itemId: "item-1",
        itemType: "command_execution",
      },
      {
        type: "item.updated",
        sessionId: "session-1",
        turnId: "turn-1",
        itemId: "item-1",
        itemType: "command_execution",
      },
      {
        type: "item.completed",
        sessionId: "session-1",
        turnId: "turn-1",
        itemId: "item-1",
        itemType: "command_execution",
        status: "completed",
      },
    ]);
    expect(engine.getSessionState("session-1")).toMatchObject({
      status: "running",
      currentTurnId: "turn-1",
    });
  });

  test("uses a synthetic turn id when the provider omits turnId", () => {
    const engine = new OrchestrationEngine();

    engine.ingest(
      "session-1",
      createEvent(
        "content.delta",
        "thread-1",
        { streamKind: "assistant_text", delta: "Hello" },
        { eventId: "evt-missing-turn", createdAt: "2026-03-11T00:04:00.000Z" },
      ),
    );

    expect(engine.getSessionEvents("session-1")).toEqual([
      versioned({
        type: "content.delta",
        sessionId: "session-1",
        turnId: "unknown-turn:evt-missing-turn",
        streamKind: "assistant_text",
        delta: "Hello",
        timestamp: "2026-03-11T00:04:00.000Z",
      }),
    ]);
    expect(engine.getSessionState("session-1").currentTurnId).toBeNull();
  });
});

function readTraceEntries(): Array<{ name: string; attributes: Record<string, unknown> }> {
  const traceFile = join(testHome, "traces.jsonl");
  if (!existsSync(traceFile)) {
    return [];
  }

  return readFileSync(traceFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { name: string; attributes: Record<string, unknown> });
}
