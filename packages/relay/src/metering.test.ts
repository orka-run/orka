import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;
let UsageMeter: typeof import("./metering").UsageMeter;
let db: typeof import("./db");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "orka-test-meter-"));
  process.env.ORKA_RELAY_DATA = tmpDir;
  const metering = await import("./metering");
  UsageMeter = metering.UsageMeter;
  db = await import("./db");
});

afterAll(() => {
  db.closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORKA_RELAY_DATA;
});

function countUsageEvents(): number {
  const row = db.getDb().prepare("SELECT COUNT(*) as count FROM usage_events").get() as any;
  return row.count;
}

function clearUsageEvents(): void {
  db.getDb().exec("DELETE FROM usage_events");
}

describe("UsageMeter", () => {
  test("buffers events without flushing immediately", () => {
    clearUsageEvents();
    const meter = new UsageMeter(999_999); // very long flush interval
    meter.recordRequest("acct-1", "spawn", 100);
    meter.recordRequest("acct-1", "ps", 50);
    // Events are buffered, not written to DB yet
    expect(countUsageEvents()).toBe(0);
    meter.shutdown();
  });

  test("flush() writes events to DB", () => {
    clearUsageEvents();
    const meter = new UsageMeter(999_999);
    meter.recordRequest("acct-1", "spawn", 100);
    meter.recordResponse("acct-1", 200);
    meter.flush();

    expect(countUsageEvents()).toBe(2);
    meter.shutdown();
  });

  test("shutdown() flushes remaining events", () => {
    clearUsageEvents();
    const meter = new UsageMeter(999_999);
    meter.recordRequest("acct-1", "spawn", 100);
    meter.recordResponse("acct-1", 200);
    meter.recordConnection("acct-1", "ws_connect");
    // Don't call flush manually
    meter.shutdown();

    expect(countUsageEvents()).toBe(3);
  });

  test("recordRequest creates proper event", () => {
    clearUsageEvents();
    const meter = new UsageMeter(999_999);
    meter.recordRequest("acct-req", "spawn", 512, "node-1");
    meter.flush();

    const rows = db.getDb().prepare("SELECT * FROM usage_events WHERE account_id = 'acct-req'").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].event_type).toBe("request");
    expect(rows[0].bytes_in).toBe(512);
    expect(rows[0].bytes_out).toBe(0);
    expect(rows[0].node_id).toBe("node-1");
    expect(rows[0].request_method).toBe("spawn");
    meter.shutdown();
  });

  test("recordResponse creates proper event", () => {
    clearUsageEvents();
    const meter = new UsageMeter(999_999);
    meter.recordResponse("acct-resp", 1024, "node-2");
    meter.flush();

    const rows = db.getDb().prepare("SELECT * FROM usage_events WHERE account_id = 'acct-resp'").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].event_type).toBe("response");
    expect(rows[0].bytes_in).toBe(0);
    expect(rows[0].bytes_out).toBe(1024);
    expect(rows[0].node_id).toBe("node-2");
    meter.shutdown();
  });

  test("recordConnection creates proper event", () => {
    clearUsageEvents();
    const meter = new UsageMeter(999_999);
    meter.recordConnection("acct-conn", "ws_connect", "node-3");
    meter.flush();

    const rows = db.getDb().prepare("SELECT * FROM usage_events WHERE account_id = 'acct-conn'").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].event_type).toBe("ws_connect");
    expect(rows[0].bytes_in).toBe(0);
    expect(rows[0].bytes_out).toBe(0);
    expect(rows[0].node_id).toBe("node-3");
    meter.shutdown();
  });

  test("auto-flush at 1000 events threshold", () => {
    clearUsageEvents();
    const meter = new UsageMeter(999_999); // long interval so timer doesn't interfere
    for (let i = 0; i < 999; i++) {
      meter.recordRequest("acct-bulk", "test", 10);
    }
    // 999 events buffered, not flushed yet
    expect(countUsageEvents()).toBe(0);

    // The 1000th event triggers auto-flush
    meter.recordRequest("acct-bulk", "test", 10);
    expect(countUsageEvents()).toBe(1000);

    meter.shutdown();
  });
});
