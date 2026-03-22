import type { OrchestrationEvent } from "@orka/core";
import { describe, expect, mock, test } from "bun:test";
import { createTimelineCache } from "./timelineCache";
import { createMemoryTimelineStorage } from "./timelineDb";
import type { RpcClient } from "./rpcClient";

function makeEvent(eventId: string, sessionId = "sess-1"): OrchestrationEvent {
  return {
    v: 1,
    type: "assistant.text",
    eventId,
    sessionId,
    timestamp: new Date().toISOString(),
    text: `Event ${eventId}`,
  } as unknown as OrchestrationEvent;
}

function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("TimelineCache", () => {
  test("get returns null for unknown session", () => {
    const storage = createMemoryTimelineStorage();
    const cache = createTimelineCache(storage);
    expect(cache.getState().get("unknown")).toBeNull();
  });

  test("set stores events in memory", () => {
    const storage = createMemoryTimelineStorage();
    const cache = createTimelineCache(storage);

    const events = [makeEvent("e1"), makeEvent("e2")];
    cache.getState().set("sess-1", events);

    expect(cache.getState().get("sess-1")).toEqual(events);
  });

  test("set persists to storage", async () => {
    const storage = createMemoryTimelineStorage();
    const cache = createTimelineCache(storage);

    const events = [makeEvent("e1"), makeEvent("e2")];
    cache.getState().set("sess-1", events);

    await tick();

    const stored = await storage.load("sess-1");
    expect(stored?.events).toEqual(events);
    expect(stored?.updatedAt).toBeGreaterThan(0);
  });

  test("set overwrites existing cache", () => {
    const storage = createMemoryTimelineStorage();
    const cache = createTimelineCache(storage);

    cache.getState().set("sess-1", [makeEvent("e1")]);
    cache.getState().set("sess-1", [makeEvent("e2"), makeEvent("e3")]);

    const cached = cache.getState().get("sess-1");
    expect(cached).toHaveLength(2);
    expect(cached && cached[0] && cached[0].eventId).toBe("e2");
  });

  test("hydrate loads from storage into memory", async () => {
    const storage = createMemoryTimelineStorage();
    const events = [makeEvent("e1")];
    await storage.save("sess-1", { events, updatedAt: Date.now() });

    const cache = createTimelineCache(storage);
    expect(cache.getState().get("sess-1")).toBeNull();

    const hydrated = await cache.getState().hydrate("sess-1");
    expect(hydrated).toEqual(events);
    expect(cache.getState().get("sess-1")).toEqual(events);
  });

  test("hydrate returns in-memory data without hitting storage", async () => {
    const storage = createMemoryTimelineStorage();
    const cache = createTimelineCache(storage);

    const events = [makeEvent("e1")];
    cache.getState().set("sess-1", events);

    const loadSpy = mock(() => storage.load("sess-1"));
    storage.load = loadSpy;

    const hydrated = await cache.getState().hydrate("sess-1");
    expect(hydrated).toEqual(events);
    expect(loadSpy).not.toHaveBeenCalled();
  });

  test("hydrate returns null for missing session", async () => {
    const storage = createMemoryTimelineStorage();
    const cache = createTimelineCache(storage);

    const result = await cache.getState().hydrate("nonexistent");
    expect(result).toBeNull();
  });

  test("prefetch fetches from server when not cached", async () => {
    const storage = createMemoryTimelineStorage();
    const cache = createTimelineCache(storage);

    const events = [makeEvent("e1"), makeEvent("e2")];
    const mockClient = {
      getSessionTimeline: mock(() => Promise.resolve({ events, total: events.length })),
    } as unknown as RpcClient;

    cache.getState().prefetch(mockClient, "sess-1");

    await tick(50);

    expect(cache.getState().get("sess-1")).toEqual(events);
    const stored = await storage.load("sess-1");
    expect(stored?.events).toEqual(events);
  });

  test("prefetch uses IDB cache when available", async () => {
    const storage = createMemoryTimelineStorage();
    const events = [makeEvent("e1")];
    await storage.save("sess-1", { events, updatedAt: Date.now() });

    const cache = createTimelineCache(storage);
    const mockClient = {
      getSessionTimeline: mock(() => Promise.resolve({ events: [], total: 0 })),
    } as unknown as RpcClient;

    cache.getState().prefetch(mockClient, "sess-1");

    await tick(50);

    // Should have loaded from IDB, not fetched from server
    expect(cache.getState().get("sess-1")).toEqual(events);
    expect(mockClient.getSessionTimeline).not.toHaveBeenCalled();
  });

  test("prefetch skips if already in memory", () => {
    const storage = createMemoryTimelineStorage();
    const cache = createTimelineCache(storage);

    cache.getState().set("sess-1", [makeEvent("e1")]);

    const mockClient = {
      getSessionTimeline: mock(() => Promise.resolve({ events: [], total: 0 })),
    } as unknown as RpcClient;

    cache.getState().prefetch(mockClient, "sess-1");

    expect(mockClient.getSessionTimeline).not.toHaveBeenCalled();
  });

  test("prefetch skips if already inflight", async () => {
    const storage = createMemoryTimelineStorage();
    const cache = createTimelineCache(storage);

    let resolveFirst!: (value: unknown) => void;
    const firstPromise = new Promise((r) => { resolveFirst = r; });

    const mockClient = {
      getSessionTimeline: mock(() => firstPromise),
    } as unknown as RpcClient;

    cache.getState().prefetch(mockClient, "sess-1");
    cache.getState().prefetch(mockClient, "sess-1");

    // Let the async IDB check resolve before asserting
    await tick();

    // Only one call despite two prefetch attempts
    expect(mockClient.getSessionTimeline).toHaveBeenCalledTimes(1);

    resolveFirst({ events: [makeEvent("e1")], total: 1 });
    await tick();
  });

  test("prefetch handles server error gracefully", async () => {
    const storage = createMemoryTimelineStorage();
    const cache = createTimelineCache(storage);

    const mockClient = {
      getSessionTimeline: mock(() => Promise.reject(new Error("network error"))),
    } as unknown as RpcClient;

    cache.getState().prefetch(mockClient, "sess-1");

    await tick(50);

    expect(cache.getState().get("sess-1")).toBeNull();
    // Session should not remain in inflight after error
    expect(cache.getState().inflight.has("sess-1")).toBe(false);
  });
});

describe("MemoryTimelineStorage", () => {
  test("eviction removes oldest sessions when exceeding limit", async () => {
    const storage = createMemoryTimelineStorage();

    for (let i = 0; i < 55; i++) {
      await storage.save(`sess-${i}`, {
        events: [makeEvent(`e${i}`, `sess-${i}`)],
        updatedAt: i * 1000,
      });
    }

    await storage.evict(50, Infinity);

    // Oldest 5 should be removed
    for (let i = 0; i < 5; i++) {
      expect(await storage.load(`sess-${i}`)).toBeUndefined();
    }
    // Newer ones should remain
    for (let i = 5; i < 55; i++) {
      expect(await storage.load(`sess-${i}`)).toBeDefined();
    }
  });

  test("eviction removes expired entries by TTL", async () => {
    const storage = createMemoryTimelineStorage();

    await storage.save("old-sess", {
      events: [makeEvent("e1", "old-sess")],
      updatedAt: Date.now() - 100_000,
    });
    await storage.save("new-sess", {
      events: [makeEvent("e2", "new-sess")],
      updatedAt: Date.now(),
    });

    await storage.evict(100, 50_000); // 50s TTL

    expect(await storage.load("old-sess")).toBeUndefined();
    expect(await storage.load("new-sess")).toBeDefined();
  });

  test("remove deletes a cached timeline", async () => {
    const storage = createMemoryTimelineStorage();
    await storage.save("sess-1", { events: [makeEvent("e1")], updatedAt: Date.now() });

    await storage.remove("sess-1");

    expect(await storage.load("sess-1")).toBeUndefined();
  });
});
