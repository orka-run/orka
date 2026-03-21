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

  test("renders hook and compaction events as system entries, skips tool.progress standalone", () => {
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
        type: "hook.started",
        sessionId: "s1",
        hookName: "PreToolUse:Bash",
        timestamp: "2026-03-11T00:00:02.5Z",
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

    // tool.progress is collected into background task entries, not standalone
    expect(entries).not.toContainEqual(
      expect.objectContaining({ id: "tool-progress-2026-03-11T00:00:01Z-turn-1" }),
    );
    expect(entries).toContainEqual({
      id: "hook-2026-03-11T00:00:02.5Z-PreToolUse:Bash",
      type: "system",
      timestamp: "2026-03-11T00:00:02.5Z",
      title: "Hook",
      body: "PreToolUse:Bash - allowed",
      tone: "info",
      defaultCollapsed: true,
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

  test("renders task.started as background-task entry with status and progress", () => {
    const entries = eventsToEntries([
      {
        type: "task.started",
        sessionId: "s1",
        turnId: "turn-1",
        taskId: "task-1",
        toolUseId: "tool-use-1",
        title: "Explore dashboard structure",
        detail: "Inspect chat timeline rendering",
        timestamp: "2026-03-11T00:00:02Z",
      },
      {
        type: "tool.progress",
        sessionId: "s1",
        turnId: "turn-1",
        itemId: "tool-use-1",
        summary: "Searching for files…",
        timestamp: "2026-03-11T00:00:03Z",
      },
      {
        type: "task.completed",
        sessionId: "s1",
        turnId: "turn-1",
        taskId: "task-1",
        toolUseId: "tool-use-1",
        summary: "Found 12 files",
        status: "completed",
        timestamp: "2026-03-11T00:00:05Z",
      },
    ]);

    expect(entries).toContainEqual({
      id: "bg-task-task-1",
      type: "background-task",
      timestamp: "2026-03-11T00:00:02Z",
      taskId: "task-1",
      title: "Explore dashboard structure",
      detail: "Inspect chat timeline rendering",
      status: "completed",
      progressUpdates: [{ summary: "Searching for files…", timestamp: "2026-03-11T00:00:03Z" }],
    });
  });

  test("renders running background task when no task.completed exists", () => {
    const entries = eventsToEntries([
      {
        type: "task.started",
        sessionId: "s1",
        turnId: "turn-1",
        taskId: "task-2",
        title: "Running tests",
        timestamp: "2026-03-11T00:00:02Z",
      },
    ]);

    expect(entries).toContainEqual(
      expect.objectContaining({
        type: "background-task",
        taskId: "task-2",
        status: "running",
        title: "Running tests",
      }),
    );
  });
});
