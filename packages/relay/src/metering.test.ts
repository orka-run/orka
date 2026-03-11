import { describe, test, expect, beforeEach, mock } from "bun:test";
import { UsageMeter } from "./metering";

// Mock the DB functions since we don't want actual SQLite in unit tests
mock.module("./db", () => ({
  insertUsageEvents: mock(() => {}),
  deleteOldUsageEvents: mock(() => {}),
  getRelayHome: () => "/tmp/orka-test-relay",
}));

describe("UsageMeter", () => {
  let meter: UsageMeter;

  beforeEach(() => {
    // Use a long interval so flush doesn't fire during tests
    meter = new UsageMeter(600_000);
  });

  test("record buffers events", () => {
    meter.record({
      accountId: "acc-1",
      eventType: "request",
      bytesIn: 100,
      bytesOut: 0,
      timestamp: new Date().toISOString(),
    });
  });

  test("recordRequest creates event with correct shape", () => {
    meter.recordRequest("acc-1", "tools/call", 256, "node-1");
    meter.flush();
  });

  test("recordResponse creates event with correct shape", () => {
    meter.recordResponse("acc-1", 1024, "node-1");
    meter.flush();
  });

  test("recordConnection creates connection events", () => {
    meter.recordConnection("acc-1", "ws_connect");
    meter.recordConnection("acc-1", "ws_disconnect");
    meter.recordConnection("acc-1", "node_connect", "node-1");
    meter.recordConnection("acc-1", "node_disconnect", "node-1");
    meter.flush();
  });

  test("flush is idempotent when empty", () => {
    meter.flush();
    meter.flush();
  });

  test("shutdown flushes remaining events", () => {
    meter.recordRequest("acc-1", "test", 50);
    meter.shutdown();
  });
});
