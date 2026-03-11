import type { RateLimitConfig } from "./db";

// --- Sliding Window Counter ---

interface WindowCounter {
  windowStart: number;   // timestamp of current window start (floored to interval)
  currentCount: number;
  previousCount: number;
}

interface AccountCounters {
  perMinute: WindowCounter;
  perHour: WindowCounter;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number; // seconds until the limit resets
}

export class RateLimiter {
  private counters = new Map<string, AccountCounters>();
  private pruneTimer: Timer;

  constructor() {
    // Periodic cleanup of stale counters
    this.pruneTimer = setInterval(() => this.prune(), 60_000);
    if (typeof this.pruneTimer === "object" && "unref" in this.pruneTimer) {
      (this.pruneTimer as any).unref();
    }
  }

  /** Check and record a request. Returns whether it's allowed. */
  check(accountId: string, limits: RateLimitConfig): RateLimitResult {
    const counters = this.getOrCreate(accountId);
    const now = Date.now();

    // Check per-minute limit
    const perMinResult = this.checkWindow(counters.perMinute, now, 60_000, limits.requestsPerMinute);
    if (!perMinResult.allowed) return perMinResult;

    // Check per-hour limit
    const perHourResult = this.checkWindow(counters.perHour, now, 3_600_000, limits.requestsPerHour);
    if (!perHourResult.allowed) return perHourResult;

    // Record the request
    this.recordWindow(counters.perMinute, now, 60_000);
    this.recordWindow(counters.perHour, now, 3_600_000);

    return { allowed: true };
  }

  /** Check concurrent connection limit */
  checkConnection(limits: RateLimitConfig, currentCount: number): boolean {
    return currentCount < limits.concurrentConnections;
  }

  /** Check message size limit */
  checkMessageSize(limits: RateLimitConfig, bytes: number): boolean {
    return bytes <= limits.maxMessageBytes;
  }

  /** Remove counters for accounts not seen in 10 minutes */
  prune(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [accountId, counters] of this.counters) {
      if (counters.perMinute.windowStart < cutoff && counters.perHour.windowStart < cutoff) {
        this.counters.delete(accountId);
      }
    }
  }

  shutdown(): void {
    clearInterval(this.pruneTimer);
  }

  // --- Internal ---

  private getOrCreate(accountId: string): AccountCounters {
    let counters = this.counters.get(accountId);
    if (!counters) {
      const now = Date.now();
      counters = {
        perMinute: { windowStart: this.floorToWindow(now, 60_000), currentCount: 0, previousCount: 0 },
        perHour: { windowStart: this.floorToWindow(now, 3_600_000), currentCount: 0, previousCount: 0 },
      };
      this.counters.set(accountId, counters);
    }
    return counters;
  }

  private checkWindow(window: WindowCounter, now: number, intervalMs: number, limit: number): RateLimitResult {
    this.advanceWindow(window, now, intervalMs);

    // Sliding window estimate: previous * (1 - elapsed_fraction) + current
    const elapsed = now - window.windowStart;
    const fraction = elapsed / intervalMs;
    const estimate = window.previousCount * (1 - fraction) + window.currentCount;

    if (estimate >= limit) {
      const retryAfter = (intervalMs - elapsed) / 1000;
      return { allowed: false, retryAfter: Math.max(1, Math.ceil(retryAfter)) };
    }

    return { allowed: true };
  }

  private recordWindow(window: WindowCounter, now: number, intervalMs: number): void {
    this.advanceWindow(window, now, intervalMs);
    window.currentCount++;
  }

  private advanceWindow(window: WindowCounter, now: number, intervalMs: number): void {
    const currentWindowStart = this.floorToWindow(now, intervalMs);
    if (currentWindowStart !== window.windowStart) {
      if (currentWindowStart - window.windowStart === intervalMs) {
        // Moved to next window — shift current to previous
        window.previousCount = window.currentCount;
      } else {
        // Skipped a window — both are stale
        window.previousCount = 0;
      }
      window.currentCount = 0;
      window.windowStart = currentWindowStart;
    }
  }

  private floorToWindow(ts: number, intervalMs: number): number {
    return Math.floor(ts / intervalMs) * intervalMs;
  }
}

// --- Global Rate Limiter ---

/** Global relay-wide rate limiter (safety valve) */
export class GlobalRateLimiter {
  private windowStart: number;
  private count: number = 0;
  private readonly maxPerSecond: number;

  constructor(maxPerSecond: number) {
    this.maxPerSecond = maxPerSecond;
    this.windowStart = Math.floor(Date.now() / 1000) * 1000;
  }

  check(): boolean {
    const now = Date.now();
    const currentWindow = Math.floor(now / 1000) * 1000;
    if (currentWindow !== this.windowStart) {
      this.count = 0;
      this.windowStart = currentWindow;
    }
    if (this.count >= this.maxPerSecond) return false;
    this.count++;
    return true;
  }
}
