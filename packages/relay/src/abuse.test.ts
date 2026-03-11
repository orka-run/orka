import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;
let detector: any;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "orka-test-abuse-"));
  process.env.ORKA_RELAY_DATA = tmpDir;
});

afterAll(() => {
  if (detector) detector.shutdown();
  const { closeDb } = require("./db");
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORKA_RELAY_DATA;
});

describe("AbuseDetector", () => {
  test("checkMessage returns 'none' under normal conditions", async () => {
    const { AbuseDetector } = await import("./abuse");
    detector = new AbuseDetector();

    // rateLimit=60 → burst threshold = (60/6)*10 = 100
    const action = detector.checkMessage("acct-normal", 100, 60);
    expect(action).toBe("none");
  });

  test("checkMessage returns escalated action on burst", async () => {
    const { AbuseDetector } = await import("./abuse");
    detector = new AbuseDetector();

    // rateLimit=60 → burst threshold = (60/6)*10 = 100
    // Send over 100 messages to exceed threshold
    let lastAction = "none";
    for (let i = 0; i < 110; i++) {
      lastAction = detector.checkMessage("acct-burst", 100, 60);
    }
    expect(lastAction).not.toBe("none");
  });

  test("checkConnection returns 'none' under normal conditions", async () => {
    const { AbuseDetector } = await import("./abuse");
    detector = new AbuseDetector();

    const action = detector.checkConnection("acct-conn-normal", 30);
    expect(action).toBe("none");
  });

  test("checkNodeRegistration detects over-limit", async () => {
    const { AbuseDetector } = await import("./abuse");
    detector = new AbuseDetector();

    // currentCount >= maxNodes → "suspend" (high severity)
    const action = detector.checkNodeRegistration("acct-nodes", 5, 5);
    expect(action).toBe("suspend");
  });

  test("checkConnection detects churn when exceeding limit", async () => {
    const { AbuseDetector } = await import("./abuse");
    detector = new AbuseDetector();

    // connectionRatePerMinute = 5 → more than 5 connections in 1 minute triggers action
    let lastAction = "none";
    for (let i = 0; i < 10; i++) {
      lastAction = detector.checkConnection("acct-conn-churn", 5);
    }
    expect(lastAction).not.toBe("none");
  });

  test("checkNodeRegistration returns 'none' under limit", async () => {
    const { AbuseDetector } = await import("./abuse");
    detector = new AbuseDetector();

    // currentCount < maxNodes → "none"
    const action = detector.checkNodeRegistration("acct-nodes-ok", 10, 3);
    expect(action).toBe("none");
  });

  test("escalation: repeated signals escalate from warn to throttle to suspend", async () => {
    const { AbuseDetector } = await import("./abuse");
    detector = new AbuseDetector();

    // rateLimit=6 → burst threshold = (6/6)*10 = 10
    // Each burst beyond 10 messages raises a signal
    const actions: string[] = [];
    for (let i = 0; i < 50; i++) {
      const action = detector.checkMessage("acct-escalation", 100, 6);
      if (action !== "none") {
        actions.push(action);
      }
    }

    expect(actions.length).toBeGreaterThan(0);
    // Signal escalation: 1st=warn, 2nd=warn, 3rd=throttle, 5th+=suspend
    expect(actions[0]).toBe("warn");
    const hasThrottleOrSuspend = actions.some((a) => a === "throttle" || a === "suspend");
    expect(hasThrottleOrSuspend).toBe(true);
  });
});
