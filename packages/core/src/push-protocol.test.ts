import { describe, expect, test } from "bun:test";
import {
  PushChannelSchema,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_RANGE,
  isProtocolCompatible,
  ServerCapabilitiesSchema,
  ServerWelcomeDataSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  PushControlRequestSchema,
} from "./push-protocol";

describe("PushChannelSchema", () => {
  test("accepts all known channels", () => {
    const channels = [
      "server.welcome",
      "server.shutdown",
      "orchestration.sessionUpdated",
      "orchestration.sessionDeleted",
      "orchestration.event",
      "session.logLine",
      "fleet.nodeUpdated",
    ];
    for (const ch of channels) {
      expect(PushChannelSchema.safeParse(ch).success).toBe(true);
    }
  });

  test("rejects unknown channels", () => {
    expect(PushChannelSchema.safeParse("unknown.channel").success).toBe(false);
    expect(PushChannelSchema.safeParse("").success).toBe(false);
  });
});

describe("PROTOCOL_VERSION", () => {
  test("is a positive integer", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
  });

  test("falls within PROTOCOL_VERSION_RANGE", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(PROTOCOL_VERSION_RANGE.min);
    expect(PROTOCOL_VERSION).toBeLessThanOrEqual(PROTOCOL_VERSION_RANGE.max);
  });
});

describe("isProtocolCompatible", () => {
  test("returns 'compatible' when server version is within range", () => {
    expect(isProtocolCompatible(1, { min: 1, max: 3 })).toBe("compatible");
    expect(isProtocolCompatible(2, { min: 1, max: 3 })).toBe("compatible");
    expect(isProtocolCompatible(3, { min: 1, max: 3 })).toBe("compatible");
  });

  test("returns 'outdated_server' when server version is below min", () => {
    expect(isProtocolCompatible(0, { min: 1, max: 3 })).toBe("outdated_server");
    expect(isProtocolCompatible(-1, { min: 1, max: 3 })).toBe("outdated_server");
  });

  test("returns 'outdated_client' when server version is above max", () => {
    expect(isProtocolCompatible(4, { min: 1, max: 3 })).toBe("outdated_client");
    expect(isProtocolCompatible(100, { min: 1, max: 3 })).toBe("outdated_client");
  });

  test("uses default PROTOCOL_VERSION_RANGE when range not provided", () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION)).toBe("compatible");
  });

  test("handles single-version range (min === max)", () => {
    expect(isProtocolCompatible(5, { min: 5, max: 5 })).toBe("compatible");
    expect(isProtocolCompatible(4, { min: 5, max: 5 })).toBe("outdated_server");
    expect(isProtocolCompatible(6, { min: 5, max: 5 })).toBe("outdated_client");
  });
});

describe("ServerCapabilitiesSchema", () => {
  test("validates a complete capabilities object", () => {
    const result = ServerCapabilitiesSchema.safeParse({
      resume: true,
      encryption: "noise",
      multiTurn: true,
      adapters: ["claude-code", "codex"],
      maxConcurrent: 5,
      terminal: false,
    });
    expect(result.success).toBe(true);
  });

  test("accepts encryption: false", () => {
    const result = ServerCapabilitiesSchema.safeParse({
      resume: false,
      encryption: false,
      multiTurn: false,
      adapters: [],
      maxConcurrent: 0,
      terminal: false,
    });
    expect(result.success).toBe(true);
  });

  test("rejects negative maxConcurrent", () => {
    const result = ServerCapabilitiesSchema.safeParse({
      resume: true,
      encryption: false,
      multiTurn: true,
      adapters: [],
      maxConcurrent: -1,
      terminal: false,
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing required fields", () => {
    expect(ServerCapabilitiesSchema.safeParse({}).success).toBe(false);
    expect(ServerCapabilitiesSchema.safeParse({ resume: true }).success).toBe(false);
  });
});

describe("ServerWelcomeDataSchema", () => {
  test("validates a complete welcome payload", () => {
    const result = ServerWelcomeDataSchema.safeParse({
      serverVersion: "1.2.3",
      sessionCount: 0,
      protocolVersion: 1,
      capabilities: {
        resume: true,
        encryption: false,
        multiTurn: true,
        adapters: ["claude-code"],
        maxConcurrent: 10,
        terminal: true,
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects negative sessionCount", () => {
    const result = ServerWelcomeDataSchema.safeParse({
      serverVersion: "1.0.0",
      sessionCount: -1,
      protocolVersion: 1,
      capabilities: {
        resume: false,
        encryption: false,
        multiTurn: false,
        adapters: [],
        maxConcurrent: 0,
        terminal: false,
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("PushControlRequestSchema", () => {
  test("validates subscribe request", () => {
    const result = SubscribeRequestSchema.safeParse({
      type: "subscribe",
      channels: ["server.welcome", "orchestration.event"],
    });
    expect(result.success).toBe(true);
  });

  test("validates unsubscribe request", () => {
    const result = UnsubscribeRequestSchema.safeParse({
      type: "unsubscribe",
      channels: ["session.logLine"],
    });
    expect(result.success).toBe(true);
  });

  test("discriminated union resolves subscribe", () => {
    const result = PushControlRequestSchema.safeParse({
      type: "subscribe",
      channels: ["server.welcome"],
    });
    expect(result.success).toBe(true);
    expect(result.data!.type).toBe("subscribe");
  });

  test("discriminated union resolves unsubscribe", () => {
    const result = PushControlRequestSchema.safeParse({
      type: "unsubscribe",
      channels: [],
    });
    expect(result.success).toBe(true);
    expect(result.data!.type).toBe("unsubscribe");
  });

  test("rejects unknown type", () => {
    const result = PushControlRequestSchema.safeParse({
      type: "unknown",
      channels: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing channels field", () => {
    expect(PushControlRequestSchema.safeParse({ type: "subscribe" }).success).toBe(false);
  });

  test("accepts empty channels array", () => {
    const result = SubscribeRequestSchema.safeParse({
      type: "subscribe",
      channels: [],
    });
    expect(result.success).toBe(true);
  });
});
