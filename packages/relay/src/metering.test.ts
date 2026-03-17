import { describe, test, beforeEach, mock } from "bun:test";
import { UsageMeter } from "./metering";

describe("UsageMeter", () => {
  let meter: UsageMeter;

  const noopDeps = {
    insertUsageEvents: mock(() => {}),
    deleteOldUsageEvents: mock(() => {}),
  };

  beforeEach(() => {
    // Use a long interval so flush doesn't fire during tests
    meter = new UsageMeter(null as any, 600_000, noopDeps);
  });

  test("record buffers events", () => {
    meter.record({
      accountId: "acc-1",
      eventType: "ws_connect",
      bytesIn: 0,
      bytesOut: 0,
      timestamp: new Date().toISOString(),
    });
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
    meter.recordConnection("acc-1", "ws_connect");
    meter.shutdown();
  });
});
