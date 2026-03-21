import { metrics, withSpanSync } from "./tracing";

// --- Abuse Detection ---

export interface AbuseSignal {
  type: string;
  severity: "low" | "medium" | "high";
  accountId: string;
  details: Record<string, unknown>;
  timestamp: string;
}

interface AccountStats {
  /** Messages in the last 10 seconds */
  recentMessages: number[];
  /** Connection opens in the last minute */
  recentConnections: number[];
  /** Node registrations */
  nodeCount: number;
  /** Warn/throttle count in current window */
  signalCount: number;
  signalWindowStart: number;
}

export type AbuseAction = "none" | "warn" | "throttle" | "suspend";

export class AbuseDetector {
  private accountStats = new Map<string, AccountStats>();
  private pruneTimer: Timer;

  constructor() {
    this.pruneTimer = setInterval(() => this.prune(), 60_000);
    if (typeof this.pruneTimer === "object" && "unref" in this.pruneTimer) {
      (this.pruneTimer as unknown as { unref(): void }).unref();
    }
  }

  /** Check on each message. Returns action to take. */
  checkMessage(accountId: string, messageBytes: number, rateLimit: number): AbuseAction {
    return withSpanSync("orka.relay.abuse.checkMessage", {
      "orka.account.id": accountId,
      "orka.bytes": messageBytes,
    }, () => {
      const stats = this.getOrCreate(accountId);
      const now = Date.now();

      // Track message timestamps (keep last 10 seconds)
      stats.recentMessages.push(now);
      stats.recentMessages = stats.recentMessages.filter((t) => now - t < 10_000);

      // Burst detection: 10x rate limit within 10 seconds
      const burstThreshold = (rateLimit / 6) * 10; // 10x the per-10s equivalent
      if (stats.recentMessages.length > burstThreshold) {
        return this.raiseSignal(accountId, {
          type: "burst",
          severity: "medium",
          accountId,
          details: { count: stats.recentMessages.length, threshold: burstThreshold, windowSec: 10 },
          timestamp: new Date().toISOString(),
        });
      }

      return "none";
    });
  }

  /** Check on connection open */
  checkConnection(accountId: string, connectionRatePerMinute: number): AbuseAction {
    return withSpanSync("orka.relay.abuse.checkConnection", {
      "orka.account.id": accountId,
      "orka.connection_rate_limit": connectionRatePerMinute,
    }, () => {
      const stats = this.getOrCreate(accountId);
      const now = Date.now();

      stats.recentConnections.push(now);
      stats.recentConnections = stats.recentConnections.filter((t) => now - t < 60_000);

      if (stats.recentConnections.length > connectionRatePerMinute) {
        return this.raiseSignal(accountId, {
          type: "connection_churn",
          severity: "medium",
          accountId,
          details: { count: stats.recentConnections.length, limit: connectionRatePerMinute },
          timestamp: new Date().toISOString(),
        });
      }

      return "none";
    });
  }

  /** Check on node registration */
  checkNodeRegistration(accountId: string, maxNodes: number, currentCount: number): AbuseAction {
    if (currentCount >= maxNodes) {
      return this.raiseSignal(accountId, {
        type: "node_registration_abuse",
        severity: "high",
        accountId,
        details: { currentCount, maxNodes },
        timestamp: new Date().toISOString(),
      });
    }
    return "none";
  }

  private raiseSignal(accountId: string, signal: AbuseSignal): AbuseAction {
    const stats = this.getOrCreate(accountId);
    const now = Date.now();

    // Reset signal window every 10 minutes
    if (now - stats.signalWindowStart > 10 * 60_000) {
      stats.signalCount = 0;
      stats.signalWindowStart = now;
    }
    stats.signalCount++;

    metrics.abuseDetections.inc({ account_id: accountId, pattern_type: signal.type });

    // Escalation
    if (signal.severity === "high") return "suspend";
    if (stats.signalCount >= 5) return "suspend";
    if (stats.signalCount >= 3) return "throttle";
    return "warn";
  }

  /** Remove stale entries */
  private prune(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, stats] of this.accountStats) {
      if (stats.recentMessages.length === 0 && stats.recentConnections.length === 0 && stats.signalWindowStart < cutoff) {
        this.accountStats.delete(id);
      }
    }
  }

  private getOrCreate(accountId: string): AccountStats {
    let stats = this.accountStats.get(accountId);
    if (!stats) {
      stats = {
        recentMessages: [],
        recentConnections: [],
        nodeCount: 0,
        signalCount: 0,
        signalWindowStart: Date.now(),
      };
      this.accountStats.set(accountId, stats);
    }
    return stats;
  }

  shutdown(): void {
    clearInterval(this.pruneTimer);
  }
}
