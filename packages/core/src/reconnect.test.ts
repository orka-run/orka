import { describe, test, expect } from "bun:test";
import { ReconnectStrategy } from "./reconnect";

describe("ReconnectStrategy", () => {
  test("uses default options when none provided", () => {
    const s = new ReconnectStrategy();
    expect(s.attempts).toBe(0);
  });

  test("attempts increments on each nextDelay call", () => {
    const s = new ReconnectStrategy();
    expect(s.attempts).toBe(0);
    s.nextDelay();
    expect(s.attempts).toBe(1);
    s.nextDelay();
    expect(s.attempts).toBe(2);
  });

  test("reset sets attempts back to 0", () => {
    const s = new ReconnectStrategy();
    s.nextDelay();
    s.nextDelay();
    expect(s.attempts).toBe(2);
    s.reset();
    expect(s.attempts).toBe(0);
  });

  test("delay increases exponentially", () => {
    // Use jitterFactor=0 to get deterministic results
    const s = new ReconnectStrategy({ baseDelay: 100, maxDelay: 100_000, jitterFactor: 0 });
    expect(s.nextDelay()).toBe(100);   // 100 * 2^0
    expect(s.nextDelay()).toBe(200);   // 100 * 2^1
    expect(s.nextDelay()).toBe(400);   // 100 * 2^2
    expect(s.nextDelay()).toBe(800);   // 100 * 2^3
    expect(s.nextDelay()).toBe(1600);  // 100 * 2^4
  });

  test("delay is capped at maxDelay", () => {
    const s = new ReconnectStrategy({ baseDelay: 1000, maxDelay: 5000, jitterFactor: 0 });
    s.nextDelay(); // 1000
    s.nextDelay(); // 2000
    s.nextDelay(); // 4000
    expect(s.nextDelay()).toBe(5000); // would be 8000, capped to 5000
    expect(s.nextDelay()).toBe(5000); // stays capped
  });

  test("delay never goes below 100ms", () => {
    const s = new ReconnectStrategy({ baseDelay: 50, maxDelay: 60_000, jitterFactor: 1 });
    // Even with extreme jitter on a small base, floor is 100
    for (let i = 0; i < 20; i++) {
      expect(s.nextDelay()).toBeGreaterThanOrEqual(100);
    }
  });

  test("jitter stays within expected bounds", () => {
    const base = 1000;
    const jitter = 0.3;
    const s = new ReconnectStrategy({ baseDelay: base, maxDelay: 100_000, jitterFactor: jitter });
    // First call: delay = base * 2^0 = 1000, jitter range = ±300
    // So result should be in [700, 1300]
    for (let i = 0; i < 50; i++) {
      s.reset();
      const d = s.nextDelay();
      expect(d).toBeGreaterThanOrEqual(700);
      expect(d).toBeLessThanOrEqual(1300);
    }
  });

  test("reset allows delays to restart from base", () => {
    const s = new ReconnectStrategy({ baseDelay: 100, maxDelay: 100_000, jitterFactor: 0 });
    s.nextDelay(); // 100
    s.nextDelay(); // 200
    s.nextDelay(); // 400
    s.reset();
    expect(s.attempts).toBe(0);
    expect(s.nextDelay()).toBe(100); // back to base
  });

  test("custom options are respected", () => {
    const s = new ReconnectStrategy({ baseDelay: 500, maxDelay: 2000, jitterFactor: 0 });
    expect(s.nextDelay()).toBe(500);
    expect(s.nextDelay()).toBe(1000);
    expect(s.nextDelay()).toBe(2000); // capped
    expect(s.nextDelay()).toBe(2000); // stays capped
  });
});
