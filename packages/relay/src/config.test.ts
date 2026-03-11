import { describe, test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RelayConfigSchema, resetRelayConfig, getRelayConfig } from "./config";

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
    const tmpDir = mkdtempSync(join(tmpdir(), "orka-test-config-reset-"));
    const origData = process.env.ORKA_RELAY_DATA;
    process.env.ORKA_RELAY_DATA = tmpDir;

    resetRelayConfig();
    const config1 = getRelayConfig();
    resetRelayConfig();
    const config2 = getRelayConfig();

    // After reset, getRelayConfig should return a new object (different reference)
    expect(config1).not.toBe(config2);

    // Restore
    if (origData !== undefined) {
      process.env.ORKA_RELAY_DATA = origData;
    } else {
      delete process.env.ORKA_RELAY_DATA;
    }
    rmSync(tmpDir, { recursive: true, force: true });
    resetRelayConfig();
  });
});
