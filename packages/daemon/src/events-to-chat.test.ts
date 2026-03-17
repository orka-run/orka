import { describe, expect, test } from "bun:test";
import type { OrchestrationEvent } from "@orka/core";
import { eventsToChat } from "./local-client";

describe("eventsToChat", () => {
  test("returns empty array for no events", () => {
    expect(eventsToChat([])).toEqual([]);
  });

  test("maps session lifecycle events to system/error entries", () => {
    const events: OrchestrationEvent[] = [
      { type: "session.created", sessionId: "s1", threadId: "t1", backend: "claude-code", timestamp: "2026-01-01T00:00:00Z" },
      { type: "session.started", sessionId: "s1", timestamp: "2026-01-01T00:00:01Z" },
      { type: "session.completed", sessionId: "s1", exitCode: 0, timestamp: "2026-01-01T00:01:00Z" },
    ];
    const entries = eventsToChat(events);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ kind: "system", title: "Session created", body: "Backend: claude-code" });
    expect(entries[1]).toMatchObject({ kind: "system", title: "Session started" });
    expect(entries[2]).toMatchObject({ kind: "system", title: "Session completed", body: "Exit code: 0" });
  });

  test("maps session.failed to error entry", () => {
    const events: OrchestrationEvent[] = [
      { type: "session.failed", sessionId: "s1", error: "Process crashed", timestamp: "2026-01-01T00:01:00Z" },
    ];
    const entries = eventsToChat(events);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "error", title: "Session failed", body: "Process crashed" });
  });

  test("accumulates content.delta into assistant entries grouped by turn", () => {
    const events: OrchestrationEvent[] = [
      { type: "content.delta", sessionId: "s1", turnId: "t1", streamKind: "assistant_text", delta: "Hello ", timestamp: "2026-01-01T00:00:10Z" },
      { type: "content.delta", sessionId: "s1", turnId: "t1", streamKind: "assistant_text", delta: "world", timestamp: "2026-01-01T00:00:11Z" },
      { type: "content.delta", sessionId: "s1", turnId: "t2", streamKind: "assistant_text", delta: "Second turn", timestamp: "2026-01-01T00:01:00Z" },
    ];
    const entries = eventsToChat(events);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "assistant", body: "Hello world" });
    expect(entries[1]).toMatchObject({ kind: "assistant", body: "Second turn" });
  });

  test("maps item.started to tool entry with correct icon", () => {
    const events: OrchestrationEvent[] = [
      { type: "item.started", sessionId: "s1", turnId: "t1", itemId: "i1", itemType: "command_execution", title: "Run tests", detail: "bun test", timestamp: "2026-01-01T00:00:05Z" },
      { type: "item.started", sessionId: "s1", turnId: "t1", itemId: "i2", itemType: "file_change", title: "Edit file", detail: "src/index.ts", timestamp: "2026-01-01T00:00:10Z" },
    ];
    const entries = eventsToChat(events);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "tool", icon: "command", title: "Run tests" });
    expect(entries[1]).toMatchObject({ kind: "tool", icon: "file", title: "Edit file" });
  });

  test("maps runtime.error to error entry", () => {
    const events: OrchestrationEvent[] = [
      { type: "runtime.error", sessionId: "s1", error: "Connection lost", class: "transport_error", timestamp: "2026-01-01T00:00:30Z" },
    ];
    const entries = eventsToChat(events);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "error", title: "transport_error", body: "Connection lost" });
  });

  test("maps turn events with token/cost info", () => {
    const events: OrchestrationEvent[] = [
      { type: "turn.started", sessionId: "s1", turnId: "t1", timestamp: "2026-01-01T00:00:00Z" },
      { type: "turn.completed", sessionId: "s1", turnId: "t1", tokens: { input: 1000, output: 500 }, cost: 0.015, timestamp: "2026-01-01T00:00:30Z" },
    ];
    const entries = eventsToChat(events);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "system", title: "Turn started" });
    expect(entries[1]).toMatchObject({ kind: "system", title: "Turn completed" });
    const completedEntry = entries[1];
    if (!completedEntry || completedEntry.kind !== "system" || !completedEntry.body) {
      throw new Error("expected a system turn completion entry with body text");
    }
    expect(completedEntry.body).toContain("Tokens: 1000 in / 500 out");
    expect(completedEntry.body).toContain("Cost: $0.0150");
  });

  test("maps user.input to a user chat entry", () => {
    const events: OrchestrationEvent[] = [
      { type: "user.input", sessionId: "s1", text: "continue", timestamp: "2026-01-01T00:00:05Z" },
    ];
    const entries = eventsToChat(events);
    expect(entries).toEqual([
      { kind: "user", timestamp: "2026-01-01T00:00:05Z", body: "continue" },
    ]);
  });

  test("entries are sorted by timestamp", () => {
    const events: OrchestrationEvent[] = [
      { type: "session.started", sessionId: "s1", timestamp: "2026-01-01T00:00:01Z" },
      { type: "session.created", sessionId: "s1", threadId: "t1", backend: "claude-code", timestamp: "2026-01-01T00:00:00Z" },
      { type: "content.delta", sessionId: "s1", turnId: "t1", streamKind: "assistant_text", delta: "hi", timestamp: "2026-01-01T00:00:02Z" },
    ];
    const entries = eventsToChat(events);
    expect(entries).toHaveLength(3);
    const [createdEntry, startedEntry, deltaEntry] = entries;
    expect(createdEntry?.kind).toBe("system"); // created
    expect(startedEntry?.kind).toBe("system"); // started
    expect(deltaEntry?.kind).toBe("assistant"); // delta
  });
});
