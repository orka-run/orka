import { describe, test, expect } from "bun:test";
import { createEvent } from "@orka/core";
import { OrchestrationEngine } from "./engine";

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
      {
        type: "session.started",
        sessionId: "session-1",
        timestamp: "2026-03-11T00:00:00.000Z",
      },
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
      {
        type: "content.delta",
        sessionId: "session-1",
        turnId: "turn-1",
        delta: "Hello",
        timestamp: "2026-03-11T00:01:00.000Z",
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
      {
        type: "session.started",
        sessionId: "session-1",
        timestamp: "2026-03-11T00:00:00.000Z",
      },
    ]);
  });

  test("projects session status across started, running, and completed states", () => {
    const engine = new OrchestrationEngine();

    expect(engine.getSessionState("session-1")).toEqual({
      sessionId: "session-1",
      status: "created",
      currentTurnId: null,
      totalCost: 0,
      totalTokens: { input: 0, output: 0 },
      pendingRequests: [],
    });

    engine.ingest(
      "session-1",
      createEvent("session.started", "thread-1", {}, { createdAt: "2026-03-11T00:00:00.000Z" }),
    );
    expect(engine.getSessionState("session-1").status).toBe("started");

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
      createEvent("session.exited", "thread-1", {}, { createdAt: "2026-03-11T00:00:02.000Z" }),
    );
    expect(engine.getSessionState("session-1")).toMatchObject({
      status: "completed",
      currentTurnId: null,
    });
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
    });
  });
});
