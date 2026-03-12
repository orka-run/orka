import { describe, expect, test } from "bun:test";
import { createRpcLatencyStore } from "./rpcLatencyStore";

describe("rpcLatencyStore", () => {
  test("keeps only the most recent entries per method", () => {
    const store = createRpcLatencyStore(3);

    store.onRpcComplete({ method: "listSessions", duration: 10, ok: true, timestamp: 1 });
    store.onRpcComplete({ method: "listSessions", duration: 20, ok: true, timestamp: 2 });
    store.onRpcComplete({ method: "listSessions", duration: 30, ok: false, timestamp: 3 });
    store.onRpcComplete({ method: "listSessions", duration: 40, ok: true, timestamp: 4 });

    expect(store.getLastRtt("listSessions")).toBe(40);
    expect(store.getConnectionRtt()).toBe(40);
    expect(store.getMethodStats("listSessions")).toMatchObject({
      avg: 30,
      p95: 40,
      p99: 40,
      min: 20,
      max: 40,
      count: 3,
    });
  });

  test("tracks methods independently", () => {
    const store = createRpcLatencyStore(2);

    store.onRpcComplete({ method: "listSessions", duration: 15, ok: true, timestamp: 1 });
    store.onRpcComplete({ method: "getSession", duration: 5, ok: false, timestamp: 2 });

    expect(store.getAllStats()).toMatchObject({
      listSessions: {
        avg: 15,
        p95: 15,
        p99: 15,
        min: 15,
        max: 15,
        count: 1,
      },
      getSession: {
        avg: 5,
        p95: 5,
        p99: 5,
        min: 5,
        max: 5,
        count: 1,
      },
    });
    expect(store.getLastRtt("getSession")).toBe(5);
  });
});
