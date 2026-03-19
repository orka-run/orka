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
        await this.tailSession(session.id);
      }
    } catch {
      // Ignore errors during tick
    }
  }

  private async tailSession(sessionId: string): Promise<void> {
    const content = await this.svc.getLogContent(sessionId);
    if (!content) return;

    const currentOffset = this.offsets.get(sessionId) ?? 0;
    if (content.length <= currentOffset) return;

    const nextContent = content.slice(currentOffset);
    this.offsets.set(sessionId, content.length);
    this.hub.broadcast("session.logLine", {
      sessionId,
      content: nextContent,
      offset: currentOffset,
    });
  }

  forget(sessionId: string): void {
    this.offsets.delete(sessionId);
  }
}
