import { describe, expect, test } from "bun:test";
import { RpcLatencyStore } from "./rpcLatencyStore";

describe("RpcLatencyStore", () => {
  test("keeps only the configured number of samples per method", () => {
    const store = new RpcLatencyStore(3);

    store.onRpcComplete({
      method: "listSessions",
      duration: 10,
      success: true,
      timestamp: 1,
    });
    store.onRpcComplete({
      method: "listSessions",
      duration: 20,
      success: true,
      timestamp: 2,
    });
    store.onRpcComplete({
      method: "listSessions",
      duration: 30,
      success: false,
      timestamp: 3,
    });
    store.onRpcComplete({
      method: "listSessions",
      duration: 40,
      success: true,
      timestamp: 4,
    });

    expect(store.getMethodStats("listSessions")).toMatchObject({
      avg: 30,
      p95: 40,
      p99: 40,
      min: 20,
      max: 40,
      count: 3,
    });
    expect(store.getLastRtt("listSessions")).toBe(40);
    expect(store.getConnectionRtt()).toBe(40);
  });

  test("returns snapshots for all tracked methods", () => {
    const store = new RpcLatencyStore(5);

    store.onRpcComplete({
      method: "listSessions",
      duration: 11,
      success: true,
      timestamp: 1,
    });
    store.onRpcComplete({
      method: "spawn",
      duration: 29,
      success: true,
      timestamp: 2,
    });

    expect(store.getAllStats()).toEqual({
      listSessions: {
        avg: 11,
        p95: 11,
        p99: 11,
        min: 11,
        max: 11,
        count: 1,
      },
      spawn: {
        avg: 29,
        p95: 29,
        p99: 29,
        min: 29,
        max: 29,
        count: 1,
      },
    });
    expect(store.getSnapshot()).toEqual({
      stats: store.getAllStats(),
      lastRttByMethod: {
        listSessions: 11,
        spawn: 29,
      },
      connectionRtt: 29,
    });
  });
});
