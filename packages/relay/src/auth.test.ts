import { describe, test, expect } from "bun:test";
import { hashKey, generateApiKey, extractApiKey } from "./auth";

describe("hashKey", () => {
  test("returns consistent sha256 hex digest", () => {
    const hash1 = hashKey("test-key");
    const hash2 = hashKey("test-key");
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64);
  });

  test("different keys produce different hashes", () => {
    const hash1 = hashKey("key-a");
    const hash2 = hashKey("key-b");
    expect(hash1).not.toBe(hash2);
  });
});

describe("generateApiKey", () => {
  test("generates key with ork_live_ prefix", () => {
    const { key } = generateApiKey("acc-1");
    expect(key.startsWith("ork_live_")).toBe(true);
  });

  test("key length is consistent (ork_live_ + 32 base62)", () => {
    const { key } = generateApiKey("acc-1");
    expect(key.length).toBe("ork_live_".length + 32);
  });

  test("record has correct structure", () => {
    const { record } = generateApiKey("acc-1", { label: "my-key", permissions: "node" });
    expect(record.accountId).toBe("acc-1");
    expect(record.label).toBe("my-key");
    expect(record.permissions).toBe("node");
    expect(record.status).toBe("active");
    expect(record.lastUsedAt).toBeNull();
    expect(record.id.startsWith("key-")).toBe(true);
    expect(record.keyPrefix.length).toBe(16);
    expect(record.keyHash.length).toBe(64);
  });

  test("default label and permissions", () => {
    const { record } = generateApiKey("acc-1");
    expect(record.label).toBe("default");
    expect(record.permissions).toBe("client");
  });

  test("keyHash matches hashKey of the generated key", () => {
    const { key, record } = generateApiKey("acc-1");
    expect(record.keyHash).toBe(hashKey(key));
  });

  test("each call generates unique keys", () => {
    const a = generateApiKey("acc-1");
    const b = generateApiKey("acc-1");
    expect(a.key).not.toBe(b.key);
    expect(a.record.id).not.toBe(b.record.id);
  });
});

describe("extractApiKey", () => {
  test("extracts from Authorization: Bearer header", () => {
    const req = new Request("http://localhost/", {
      headers: { Authorization: "Bearer my-secret-key" },
    });
    expect(extractApiKey(req)).toBe("my-secret-key");
  });

  test("extracts from ?token= query param", () => {
    const req = new Request("http://localhost/?token=query-key");
    expect(extractApiKey(req)).toBe("query-key");
  });

  test("prefers Authorization header over query param", () => {
    const req = new Request("http://localhost/?token=query-key", {
      headers: { Authorization: "Bearer header-key" },
    });
    expect(extractApiKey(req)).toBe("header-key");
  });

  test("returns null when no key present", () => {
    const req = new Request("http://localhost/");
    expect(extractApiKey(req)).toBeNull();
  });

  test("returns null for non-Bearer auth header", () => {
    const req = new Request("http://localhost/", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(extractApiKey(req)).toBeNull();
  });
});
