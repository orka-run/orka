import { describe, test, expect } from "bun:test";
import { RelayConfigSchema } from "./config";

describe("RelayConfigSchema", () => {
  test("parses empty object with all defaults", () => {
    const config = RelayConfigSchema.parse({});
    expect(config.server.port).toBe(7390);
    expect(config.server.hostname).toBe("0.0.0.0");
    expect(config.auth.signupEnabled).toBe(true);
    expect(config.auth.requireEmailVerification).toBe(false);
    expect(config.rateLimits.defaultRequestsPerMinute).toBe(60);
    expect(config.rateLimits.defaultRequestsPerHour).toBe(1000);
    expect(config.rateLimits.defaultConcurrentConnections).toBe(10);
    expect(config.rateLimits.defaultMaxMessageBytes).toBe(1_048_576);
    expect(config.rateLimits.globalRequestsPerSecond).toBe(10_000);
    expect(config.abuse.maxNodesPerAccount).toBe(20);
    expect(config.abuse.maxKeysPerAccount).toBe(10);
    expect(config.abuse.connectionRatePerMinute).toBe(30);
    expect(config.observability.metricsInterval).toBe(60);
  });

  test("overrides specific fields while keeping defaults", () => {
    const config = RelayConfigSchema.parse({
      server: { port: 8080 },
    });
    expect(config.server.port).toBe(8080);
    expect(config.server.hostname).toBe("0.0.0.0");
    expect(config.auth.signupEnabled).toBe(true);
  });

  test("auth section overrides", () => {
    const config = RelayConfigSchema.parse({
      auth: {
        signupEnabled: false,
        adminToken: "secret-admin-token",
      },
    });
    expect(config.auth.signupEnabled).toBe(false);
    expect(config.auth.adminToken).toBe("secret-admin-token");
    expect(config.auth.requireEmailVerification).toBe(false);
  });

  test("rate limits section overrides", () => {
    const config = RelayConfigSchema.parse({
      rateLimits: {
        defaultRequestsPerMinute: 120,
        globalRequestsPerSecond: 50_000,
      },
    });
    expect(config.rateLimits.defaultRequestsPerMinute).toBe(120);
    expect(config.rateLimits.globalRequestsPerSecond).toBe(50_000);
    expect(config.rateLimits.defaultRequestsPerHour).toBe(1000);
  });

  test("abuse section overrides", () => {
    const config = RelayConfigSchema.parse({
      abuse: { maxNodesPerAccount: 50 },
    });
    expect(config.abuse.maxNodesPerAccount).toBe(50);
    expect(config.abuse.maxKeysPerAccount).toBe(10);
  });

  test("observability section with optional otlp", () => {
    const config = RelayConfigSchema.parse({
      observability: { otlpEndpoint: "http://localhost:4318" },
    });
    expect(config.observability.otlpEndpoint).toBe("http://localhost:4318");
    expect(config.observability.metricsInterval).toBe(60);
  });

  test("full config round-trip", () => {
    const input = {
      server: { port: 9000, hostname: "127.0.0.1" },
      auth: { signupEnabled: false, requireEmailVerification: true, legacyToken: "tok" },
      rateLimits: { defaultRequestsPerMinute: 30 },
      abuse: { maxNodesPerAccount: 5 },
      observability: { traceFile: "/tmp/traces.jsonl" },
    };
    const config = RelayConfigSchema.parse(input);
    expect(config.server.port).toBe(9000);
    expect(config.auth.legacyToken).toBe("tok");
    expect(config.observability.traceFile).toBe("/tmp/traces.jsonl");
  });
});
