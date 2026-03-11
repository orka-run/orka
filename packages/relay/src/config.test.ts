import { describe, test, expect, beforeEach } from "bun:test";
import { RelayConfigSchema, resetRelayConfig } from "./config";

describe("RelayConfigSchema", () => {
  beforeEach(() => {
    resetRelayConfig();
  });

  test("parse({}) returns all defaults", () => {
    const config = RelayConfigSchema.parse({});
    expect(config.server).toBeDefined();
    expect(config.auth).toBeDefined();
    expect(config.rateLimits).toBeDefined();
    expect(config.abuse).toBeDefined();
    expect(config.observability).toBeDefined();
  });

  test("default port is 7390", () => {
    const config = RelayConfigSchema.parse({});
    expect(config.server.port).toBe(7390);
  });

  test("default hostname is 0.0.0.0", () => {
    const config = RelayConfigSchema.parse({});
    expect(config.server.hostname).toBe("0.0.0.0");
  });

  test("default rate limits are populated", () => {
    const config = RelayConfigSchema.parse({});
    expect(config.rateLimits.defaultRequestsPerMinute).toBe(60);
    expect(config.rateLimits.defaultRequestsPerHour).toBe(1000);
    expect(config.rateLimits.defaultConcurrentConnections).toBe(10);
    expect(config.rateLimits.defaultMaxMessageBytes).toBe(1_048_576);
  });

  test("default abuse limits are populated", () => {
    const config = RelayConfigSchema.parse({});
    expect(config.abuse.maxNodesPerAccount).toBe(20);
    expect(config.abuse.maxKeysPerAccount).toBe(10);
  });

  test("resetRelayConfig() clears cached config", () => {
    resetRelayConfig();
    resetRelayConfig();
  });
});
