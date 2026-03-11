import { describe, test, expect, beforeEach } from "bun:test";
import { AbuseDetector } from "./abuse";

describe("AbuseDetector", () => {
  let detector: AbuseDetector;

  beforeEach(() => {
    detector = new AbuseDetector();
  });

  test("checkMessage returns none for normal traffic", () => {
    const result = detector.checkMessage("acc-1", 100, 60);
    expect(result).toBe("none");
  });

  test("checkMessage detects burst", () => {
    // burstThreshold = (rateLimit / 6) * 10
    // For rateLimit=6: threshold = (6/6)*10 = 10
    const rateLimit = 6;

    for (let i = 0; i < 10; i++) {
      detector.checkMessage("acc-1", 100, rateLimit);
    }
    // 11th should trigger burst detection
    const result = detector.checkMessage("acc-1", 100, rateLimit);
    expect(result).not.toBe("none");
  });

  test("checkConnection returns none within limit", () => {
    const result = detector.checkConnection("acc-1", 30);
    expect(result).toBe("none");
  });

  test("checkConnection detects connection churn", () => {
    for (let i = 0; i < 30; i++) {
      detector.checkConnection("acc-1", 30);
    }
    const result = detector.checkConnection("acc-1", 30);
    expect(result).not.toBe("none");
  });

  test("checkNodeRegistration returns none within limit", () => {
    expect(detector.checkNodeRegistration("acc-1", 20, 5)).toBe("none");
  });

  test("checkNodeRegistration detects abuse at limit", () => {
    const result = detector.checkNodeRegistration("acc-1", 20, 20);
    expect(result).toBe("suspend");
  });

  test("escalation: warn → throttle → suspend", () => {
    // With connection limit=5, each call after 5th triggers a signal
    // Call 1-5: "none" (within limit)
    for (let i = 0; i < 5; i++) {
      expect(detector.checkConnection("acc-1", 5)).toBe("none");
    }
    // Call 6: signal 1 → warn
    expect(detector.checkConnection("acc-1", 5)).toBe("warn");
    // Call 7: signal 2 → warn
    expect(detector.checkConnection("acc-1", 5)).toBe("warn");
    // Call 8: signal 3 → throttle
    expect(detector.checkConnection("acc-1", 5)).toBe("throttle");
    // Call 9: signal 4 → throttle
    expect(detector.checkConnection("acc-1", 5)).toBe("throttle");
    // Call 10: signal 5 → suspend
    expect(detector.checkConnection("acc-1", 5)).toBe("suspend");
  });

  test("accounts are tracked independently", () => {
    const result1 = detector.checkNodeRegistration("acc-1", 10, 10);
    expect(result1).toBe("suspend");

    const result2 = detector.checkMessage("acc-2", 100, 60);
    expect(result2).toBe("none");
  });

  test("shutdown clears timer", () => {
    detector.shutdown();
  });
});
