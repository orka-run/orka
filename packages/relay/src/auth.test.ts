import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;
let auth: typeof import("./auth");
let config: typeof import("./config");
let db: typeof import("./db");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "orka-test-auth-"));
  process.env.ORKA_RELAY_DATA = tmpDir;
  auth = await import("./auth");
  config = await import("./config");
  db = await import("./db");
});

beforeEach(() => {
  config.resetRelayConfig();
});

afterAll(() => {
  db.closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORKA_RELAY_DATA;
});

describe("generateApiKey", () => {
  test("returns key starting with ork_live_ and a record with keyHash", () => {
    const account = db.createAccount("test-gen@example.com", "Test User");
    const generated = auth.generateApiKey(account.id);

    expect(generated.key).toMatch(/^ork_live_/);
    expect(generated.record.keyHash).toBeDefined();
    expect(typeof generated.record.keyHash).toBe("string");
    expect(generated.record.keyHash.length).toBe(64); // SHA-256 hex
  });
});

describe("hashKey", () => {
  test("is deterministic (same input = same output)", () => {
    const hash1 = auth.hashKey("test-key-value");
    const hash2 = auth.hashKey("test-key-value");
    expect(hash1).toBe(hash2);

    const hash3 = auth.hashKey("different-key");
    expect(hash3).not.toBe(hash1);
  });
});

describe("signup", () => {
  test("creates account and returns apiKey", () => {
    const result = auth.signup("signup-test@example.com", "Signup User");
    expect(result.account).toBeDefined();
    expect(result.account.email).toBe("signup-test@example.com");
    expect(result.apiKey).toMatch(/^ork_live_/);
  });
});

describe("authenticate", () => {
  test("with valid key returns success", () => {
    const { account, apiKey } = auth.signup("auth-valid@example.com", "Auth User");
    const result = auth.authenticate(apiKey);

    expect(result.success).toBe(true);
    expect(result.ctx).toBeDefined();
    expect(result.ctx!.accountId).toBe(account.id);
  });

  test("with invalid key returns failure", () => {
    const result = auth.authenticate("ork_live_invalidkey12345678901234");

    expect(result.success).toBe(false);
    expect(result.code).toBeGreaterThanOrEqual(400);
  });

  test("with revoked key returns failure", () => {
    const { account, apiKey } = auth.signup("auth-revoked@example.com", "Revoked User");
    // Find the key and revoke it
    const keys = db.listApiKeys(account.id);
    expect(keys.length).toBeGreaterThan(0);
    db.revokeApiKey(keys[0].id, account.id);
    config.resetRelayConfig(); // clear auth cache side-effects

    const result = auth.authenticate(apiKey);
    expect(result.success).toBe(false);
  });

  test("with empty key returns failure with missing message", () => {
    const result = auth.authenticate("");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Missing API key");
  });
});

describe("legacy token fallback", () => {
  test("authenticates with legacy_token from config", () => {
    const configPath = join(tmpDir, "config.toml");
    writeFileSync(configPath, '[auth]\nlegacy_token = "my-legacy-token"\n');
    config.resetRelayConfig();

    const result = auth.authenticate("my-legacy-token");
    expect(result.success).toBe(true);
    expect(result.ctx).toBeDefined();
    expect(result.ctx!.accountId).toBe("__legacy__");

    unlinkSync(configPath);
    config.resetRelayConfig();
  });
});
