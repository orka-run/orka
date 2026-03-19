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

  test("renders task progress, hook, and compaction events as inline system entries", () => {
    const entries = eventsToEntries([
      {
        type: "tool.progress",
        sessionId: "s1",
        turnId: "turn-1",
        toolName: "Read",
        summary: "Reading src/db.ts",
        timestamp: "2026-03-11T00:00:01Z",
      },
      {
        type: "task.started",
        sessionId: "s1",
        turnId: "turn-1",
        taskId: "task-1",
        title: "Explore dashboard structure",
        detail: "Inspect chat timeline rendering",
        timestamp: "2026-03-11T00:00:02Z",
      },
      {
        type: "hook.response",
        sessionId: "s1",
        hookName: "PreToolUse:Bash",
        decision: "allowed",
        timestamp: "2026-03-11T00:00:03Z",
      },
      {
        type: "session.compacted",
        sessionId: "s1",
        tokenCountBefore: 120000,
        tokenCountAfter: 64000,
        timestamp: "2026-03-11T00:00:04Z",
      },
    ]);

    expect(entries).toContainEqual({
      id: "tool-progress-2026-03-11T00:00:01Z-turn-1",
      type: "system",
      timestamp: "2026-03-11T00:00:01Z",
      title: "Read",
      body: "Reading src/db.ts",
      tone: "info",
    });
    expect(entries).toContainEqual({
      id: "task-started-2026-03-11T00:00:02Z-task-1",
      type: "system",
      timestamp: "2026-03-11T00:00:02Z",
      title: "Task started",
      body: "Explore dashboard structure - Inspect chat timeline rendering",
      tone: "info",
    });
    expect(entries).toContainEqual({
      id: "hook-hook.response-2026-03-11T00:00:03Z-PreToolUse:Bash",
      type: "system",
      timestamp: "2026-03-11T00:00:03Z",
      title: "Hook",
      body: "PreToolUse:Bash - allowed",
      tone: "info",
    });
    expect(entries).toContainEqual({
      id: "session-compacted-2026-03-11T00:00:04Z",
      type: "system",
      timestamp: "2026-03-11T00:00:04Z",
      title: "Context compacted",
      body: "Trimmed context from 120000 to 64000 tokens.",
      tone: "info",
    });
  });
});
