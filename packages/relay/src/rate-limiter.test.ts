import { describe, test, expect, beforeEach, setSystemTime } from "bun:test";
import { RateLimiter, GlobalRateLimiter } from "./rate-limiter";
import type { RateLimitConfig } from "./db";

const defaultLimits: RateLimitConfig = {
  accountId: "acc-1",
  requestsPerMinute: 10,
  requestsPerHour: 100,
  concurrentConnections: 5,
  maxMessageBytes: 1024,
};

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  test("allows requests within limit", () => {
    for (let i = 0; i < 5; i++) {
      const result = limiter.check("acc-1", defaultLimits);
      expect(result.allowed).toBe(true);
    }
  });

  test("denies requests exceeding per-minute limit", () => {
    const limits = { ...defaultLimits, requestsPerMinute: 3 };
    // Sliding window uses estimate, so exact threshold varies
    // Fill up the limit
    for (let i = 0; i < 3; i++) {
      limiter.check("acc-1", limits);
    }
    const result = limiter.check("acc-1", limits);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  test("returns retryAfter in seconds", () => {
    const limits = { ...defaultLimits, requestsPerMinute: 2 };
    limiter.check("acc-1", limits);
    limiter.check("acc-1", limits);
    const result = limiter.check("acc-1", limits);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThanOrEqual(1);
    expect(result.retryAfter).toBeLessThanOrEqual(60);
  });

  test("tracks accounts independently", () => {
    const limits = { ...defaultLimits, requestsPerMinute: 2 };
    limiter.check("acc-1", limits);
    limiter.check("acc-1", limits);

    // acc-2 should still be allowed
    const result = limiter.check("acc-2", limits);
    expect(result.allowed).toBe(true);
  });

  test("checkConnection respects concurrent limit", () => {
    expect(limiter.checkConnection(defaultLimits, 3)).toBe(true);
    expect(limiter.checkConnection(defaultLimits, 5)).toBe(false);
    expect(limiter.checkConnection(defaultLimits, 10)).toBe(false);
  });

  test("checkMessageSize respects byte limit", () => {
    expect(limiter.checkMessageSize(defaultLimits, 512)).toBe(true);
    expect(limiter.checkMessageSize(defaultLimits, 1024)).toBe(true);
    expect(limiter.checkMessageSize(defaultLimits, 1025)).toBe(false);
  });

  test("prune removes stale counters", () => {
    limiter.check("acc-1", defaultLimits);
    // prune shouldn't crash even on fresh counters
    limiter.prune();
  });

  test("shutdown clears timer", () => {
    limiter.shutdown();
    // Should not throw
  });
});

describe("GlobalRateLimiter", () => {
  test("allows requests within per-second limit", () => {
    const gl = new GlobalRateLimiter(5);
    for (let i = 0; i < 5; i++) {
      expect(gl.check()).toBe(true);
    }
  });

  test("denies requests exceeding per-second limit", () => {
    const gl = new GlobalRateLimiter(3);
    expect(gl.check()).toBe(true);
    expect(gl.check()).toBe(true);
    expect(gl.check()).toBe(true);
    expect(gl.check()).toBe(false);
  });

  test("resets on new second boundary", () => {
    const now = Date.now();
    setSystemTime(new Date(now));
    try {
      const gl = new GlobalRateLimiter(2);
      expect(gl.check()).toBe(true);
      expect(gl.check()).toBe(true);
      expect(gl.check()).toBe(false);

      // Advance past the second boundary
      setSystemTime(new Date(now + 1100));
      expect(gl.check()).toBe(true);
    } finally {
      setSystemTime();
    }
  });
});
