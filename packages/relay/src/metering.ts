import type { Database } from "bun:sqlite";
import { type UsageEvent, insertUsageEvents as defaultInsert, deleteOldUsageEvents as defaultDelete } from "./db";
import { withSpanSync } from "./tracing";

export interface UsageMeterDeps {
  insertUsageEvents?: (db: Database, events: UsageEvent[]) => void;
  deleteOldUsageEvents?: (db: Database, cutoff: string) => void;
}

export class UsageMeter {
  private readonly db: Database;
  private buffer: UsageEvent[] = [];
  private flushTimer: Timer;
  private retentionTimer: Timer;
  private readonly insertFn: (db: Database, events: UsageEvent[]) => void;
  private readonly deleteFn: (db: Database, cutoff: string) => void;

  constructor(db: Database, flushIntervalMs: number = 5_000, deps?: UsageMeterDeps) {
    this.db = db;
    this.insertFn = deps?.insertUsageEvents ?? defaultInsert;
    this.deleteFn = deps?.deleteOldUsageEvents ?? defaultDelete;
    this.flushTimer = setInterval(() => this.flush(), flushIntervalMs);
    if (typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
      (this.flushTimer as unknown as { unref(): void }).unref();
    }

    // Daily retention cleanup: delete events older than 90 days
    this.retentionTimer = setInterval(() => this.cleanOld(), 24 * 3_600_000);
    if (typeof this.retentionTimer === "object" && "unref" in this.retentionTimer) {
      (this.retentionTimer as unknown as { unref(): void }).unref();
    }
    // Run once at startup too
    setTimeout(() => this.cleanOld(), 10_000);
  }

  record(event: UsageEvent): void {
    withSpanSync("orka.relay.metering.record", {
      "orka.account.id": event.accountId,
      "orka.event.type": event.eventType,
    }, () => {
      this.buffer.push(event);
      if (this.buffer.length >= 1000) this.flush();
    });
  }

  recordConnection(accountId: string, eventType: "ws_connect" | "ws_disconnect" | "node_connect" | "node_disconnect", nodeId?: string): void {
    this.record({
      accountId,
      eventType,
      bytesIn: 0,
      bytesOut: 0,
      ...(nodeId ? { nodeId } : {}),
      timestamp: new Date().toISOString(),
    });
  }

  flush(): void {
    withSpanSync("orka.relay.metering.flush", {
      "orka.buffer.size": this.buffer.length,
    }, () => {
      if (this.buffer.length === 0) return;
      const batch = this.buffer;
      this.buffer = [];
      try {
        this.insertFn(this.db, batch);
      } catch {
        // Best effort — don't crash on metering failure
      }
    });
  }

  private cleanOld(): void {
    const cutoff = new Date(Date.now() - 90 * 24 * 3_600_000).toISOString();
    try {
      this.deleteFn(this.db, cutoff);
    } catch { /* best effort */ }
  }

  shutdown(): void {
    withSpanSync("orka.relay.metering.shutdown", {}, () => {
      clearInterval(this.flushTimer);
      clearInterval(this.retentionTimer);
      this.flush();
    });
  }
}
