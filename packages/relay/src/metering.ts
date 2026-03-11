import { type UsageEvent, insertUsageEvents, deleteOldUsageEvents } from "./db";
import { withSpanSync } from "./tracing";

export class UsageMeter {
  private buffer: UsageEvent[] = [];
  private flushTimer: Timer;
  private retentionTimer: Timer;

  constructor(flushIntervalMs: number = 5_000) {
    this.flushTimer = setInterval(() => this.flush(), flushIntervalMs);
    if (typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
      (this.flushTimer as any).unref();
    }

    // Daily retention cleanup: delete events older than 90 days
    this.retentionTimer = setInterval(() => this.cleanOld(), 24 * 3_600_000);
    if (typeof this.retentionTimer === "object" && "unref" in this.retentionTimer) {
      (this.retentionTimer as any).unref();
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

  recordRequest(accountId: string, method: string, bytesIn: number, nodeId?: string): void {
    this.record({
      accountId,
      eventType: "request",
      bytesIn,
      bytesOut: 0,
      nodeId,
      requestMethod: method,
      timestamp: new Date().toISOString(),
    });
  }

  recordResponse(accountId: string, bytesOut: number, nodeId?: string): void {
    this.record({
      accountId,
      eventType: "response",
      bytesIn: 0,
      bytesOut,
      nodeId,
      timestamp: new Date().toISOString(),
    });
  }

  recordConnection(accountId: string, eventType: "ws_connect" | "ws_disconnect" | "node_connect" | "node_disconnect", nodeId?: string): void {
    this.record({
      accountId,
      eventType,
      bytesIn: 0,
      bytesOut: 0,
      nodeId,
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
        insertUsageEvents(batch);
      } catch {
        // Best effort — don't crash on metering failure
      }
    });
  }

  private cleanOld(): void {
    const cutoff = new Date(Date.now() - 90 * 24 * 3_600_000).toISOString();
    try {
      deleteOldUsageEvents(cutoff);
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
