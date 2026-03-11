import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import type { OrkaService } from "@orka/core";
import type { PushHub } from "./push-hub";

/**
 * Watches log files of active sessions and broadcasts new content
 * to push subscribers on the "session.logLine" channel.
 */
export class LogTailer {
  private offsets = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private svc: OrkaService,
    private hub: PushHub,
    private intervalMs = 500,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.hub.subscriberCount("session.logLine") === 0) return;

    try {
      const sessions = await this.svc.listSessions();
      const active = sessions.filter(
        (s) => s.status === "running" || s.status === "preparing",
      );

      for (const session of active) {
        this.tailSession(session.id, session.logFile);
      }
    } catch {
      // Ignore errors during tick
    }
  }

  private tailSession(sessionId: string, logFile: string): void {
    if (!logFile || !existsSync(logFile)) return;

    let size: number;
    try {
      size = statSync(logFile).size;
    } catch {
      return;
    }

    const currentOffset = this.offsets.get(sessionId) ?? 0;
    if (size <= currentOffset) return;

    const bytesToRead = size - currentOffset;
    const buf = Buffer.alloc(bytesToRead);

    let fd: number | undefined;
    try {
      fd = openSync(logFile, "r");
      readSync(fd, buf, 0, bytesToRead, currentOffset);
    } catch {
      return;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }

    this.offsets.set(sessionId, size);
    this.hub.broadcast("session.logLine", {
      sessionId,
      content: buf.toString("utf-8"),
      offset: currentOffset,
    });
  }

  forget(sessionId: string): void {
    this.offsets.delete(sessionId);
  }
}
