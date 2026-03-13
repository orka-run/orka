import { describe, test, expect, afterEach } from "bun:test";
import { blake3, blake3Truncated, concatBytes } from "@orka/core/crypto/protocol";
import { EnrollmentStore } from "./enrollment-store";

function makeSecret(n: number = 0): Uint8Array {
  // 80-bit (10-byte) secret, as specified in the protocol
  const secret = new Uint8Array(10);
  secret[0] = n;
  for (let i = 1; i < 10; i++) secret[i] = i + n;
  return secret;
}

function makeOpts(overrides: Record<string, unknown> = {}) {
  return {
    secret: makeSecret(),
    nodeId: "node-1",
    nodeName: "test-node",
    nodeTransportStaticPubkey: new Uint8Array(32).fill(0xaa),
    relayPaths: ["wss://relay.example.com/v1/node/node-1"],
    ...overrides,
  };
}

const textEncoder = new TextEncoder();

describe("EnrollmentStore", () => {
  let store: EnrollmentStore;

  afterEach(() => {
    store?.shutdown();
  });

  test("create + get: creates enrollment and returns correct fields", () => {
    store = new EnrollmentStore();
    const opts = makeOpts();
    const enrollId = store.create(opts);

    const enrollment = store.get(enrollId);
    expect(enrollment).not.toBeNull();
    expect(enrollment!.enrollId).toBe(enrollId);
    expect(enrollment!.nodeId).toBe("node-1");
    expect(enrollment!.nodeName).toBe("test-node");
    expect(enrollment!.nodeTransportStaticPubkey).toEqual(new Uint8Array(32).fill(0xaa));
    expect(enrollment!.relayPaths).toEqual(["wss://relay.example.com/v1/node/node-1"]);
    expect(enrollment!.attemptsLeft).toBe(8);
    expect(enrollment!.used).toBe(false);
    expect(enrollment!.expiresAt).toBeGreaterThan(Date.now());

    // Verify enrollId derivation matches expected computation
    const expectedInput = concatBytes(
      textEncoder.encode("orka/pair/v1/enroll-id"),
      opts.secret,
    );
    const expectedHash = blake3Truncated(expectedInput, 8);
    const expectedEnrollId = Buffer.from(expectedHash).toString("hex");
    expect(enrollId).toBe(expectedEnrollId);
  });

  test("TTL expiry: expired enrollment is removed on get", async () => {
    store = new EnrollmentStore();
    const enrollId = store.create(makeOpts({ ttlMs: 50 }));

    // Enrollment exists before expiry
    expect(store.get(enrollId)).not.toBeNull();

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Enrollment is gone after expiry
    expect(store.get(enrollId)).toBeNull();
  });

  test("attempts exhaustion: 8 failed attempts destroys enrollment", () => {
    store = new EnrollmentStore();
    const enrollId = store.create(makeOpts());

    for (let i = 7; i >= 1; i--) {
      const remaining = store.recordFailedAttempt(enrollId);
      expect(remaining).toBe(i);
      expect(store.get(enrollId)).not.toBeNull();
    }

    // 8th failed attempt destroys the enrollment
    const remaining = store.recordFailedAttempt(enrollId);
    expect(remaining).toBe(0);
    expect(store.get(enrollId)).toBeNull();
  });

  test("mark used: marks enrollment as used", () => {
    store = new EnrollmentStore();
    const enrollId = store.create(makeOpts());

    expect(store.get(enrollId)!.used).toBe(false);

    store.markUsed(enrollId);

    expect(store.get(enrollId)!.used).toBe(true);
  });

  test("multiple concurrent enrollments: all accessible", () => {
    store = new EnrollmentStore();
    const id1 = store.create(makeOpts({ secret: makeSecret(1) }));
    const id2 = store.create(makeOpts({ secret: makeSecret(2) }));
    const id3 = store.create(makeOpts({ secret: makeSecret(3) }));

    expect(store.get(id1)).not.toBeNull();
    expect(store.get(id2)).not.toBeNull();
    expect(store.get(id3)).not.toBeNull();

    // Verify they are distinct enrollments
    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
    expect(id1).not.toBe(id3);
  });

  test("remove: removes enrollment", () => {
    store = new EnrollmentStore();
    const enrollId = store.create(makeOpts());

    expect(store.get(enrollId)).not.toBeNull();

    store.remove(enrollId);

    expect(store.get(enrollId)).toBeNull();
  });

  test("activeCount: tracks active enrollments correctly", () => {
    store = new EnrollmentStore();
    expect(store.activeCount).toBe(0);

    const id1 = store.create(makeOpts({ secret: makeSecret(1) }));
    expect(store.activeCount).toBe(1);

    store.create(makeOpts({ secret: makeSecret(2) }));
    expect(store.activeCount).toBe(2);

    store.remove(id1);
    expect(store.activeCount).toBe(1);
  });

  test("cleanup removes expired only", async () => {
    store = new EnrollmentStore();

    // One enrollment with short TTL
    const shortId = store.create(makeOpts({ secret: makeSecret(1), ttlMs: 50 }));
    // One enrollment with long TTL
    const longId = store.create(makeOpts({ secret: makeSecret(2), ttlMs: 600_000 }));

    expect(store.activeCount).toBe(2);

    // Wait for short TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    store.cleanup();

    // Short-lived enrollment gone, long-lived still exists
    expect(store.get(shortId)).toBeNull();
    expect(store.get(longId)).not.toBeNull();
    expect(store.activeCount).toBe(1);
  });

  test("enrollId format: hex string of correct length", () => {
    store = new EnrollmentStore();
    const enrollId = store.create(makeOpts());

    // 8 bytes = 16 hex characters
    expect(enrollId.length).toBe(16);
    // Verify it's valid hex
    expect(/^[0-9a-f]{16}$/.test(enrollId)).toBe(true);
  });

  test("secretHash stored correctly: matches blake3(secret)", () => {
    store = new EnrollmentStore();
    const secret = makeSecret();
    const enrollId = store.create(makeOpts({ secret }));

    const enrollment = store.get(enrollId);
    expect(enrollment).not.toBeNull();

    const expectedHash = blake3(secret);
    expect(enrollment!.secretHash).toEqual(expectedHash);
  });

  test("shutdown: clears all enrollments", () => {
    store = new EnrollmentStore();
    store.create(makeOpts({ secret: makeSecret(1) }));
    store.create(makeOpts({ secret: makeSecret(2) }));
    store.create(makeOpts({ secret: makeSecret(3) }));

    expect(store.activeCount).toBe(3);

    store.shutdown();

    expect(store.activeCount).toBe(0);
  });

  test("recordFailedAttempt on nonexistent enrollment returns 0", () => {
    store = new EnrollmentStore();
    const remaining = store.recordFailedAttempt("nonexistent");
    expect(remaining).toBe(0);
  });

  test("markUsed on nonexistent enrollment is a no-op", () => {
    store = new EnrollmentStore();
    // Should not throw
    store.markUsed("nonexistent");
  });

  test("custom maxAttempts", () => {
    store = new EnrollmentStore();
    const enrollId = store.create(makeOpts({ maxAttempts: 3 }));

    expect(store.get(enrollId)!.attemptsLeft).toBe(3);

    expect(store.recordFailedAttempt(enrollId)).toBe(2);
    expect(store.recordFailedAttempt(enrollId)).toBe(1);
    expect(store.recordFailedAttempt(enrollId)).toBe(0);
    expect(store.get(enrollId)).toBeNull();
  });

  test("raw secret: stored and accessible via get()", () => {
    store = new EnrollmentStore();
    const secret = makeSecret(42);
    const enrollId = store.create(makeOpts({ secret }));

    const enrollment = store.get(enrollId);
    expect(enrollment).not.toBeNull();
    // The stored secret should match the original value
    expect(enrollment!.secret).toEqual(secret);
  });

  test("raw secret: defensive copy (not same reference as input)", () => {
    store = new EnrollmentStore();
    const secret = makeSecret(42);
    const enrollId = store.create(makeOpts({ secret }));

    const enrollment = store.get(enrollId);
    expect(enrollment).not.toBeNull();
    // Mutating the original should not affect the stored copy
    const originalValue = secret[0];
    secret[0] = 0xff;
    expect(enrollment!.secret[0]).toBe(originalValue);
  });

  test("raw secret: zeroed on markUsed", () => {
    store = new EnrollmentStore();
    const secret = makeSecret(7);
    const enrollId = store.create(makeOpts({ secret }));

    const enrollment = store.get(enrollId)!;
    // Secret should be non-zero before markUsed
    expect(enrollment.secret.some((b) => b !== 0)).toBe(true);

    store.markUsed(enrollId);

    // Secret should be zeroed after markUsed
    expect(enrollment.secret.every((b) => b === 0)).toBe(true);
  });

  test("raw secret: zeroed on remove", () => {
    store = new EnrollmentStore();
    const secret = makeSecret(9);
    const enrollId = store.create(makeOpts({ secret }));

    const enrollment = store.get(enrollId)!;
    expect(enrollment.secret.some((b) => b !== 0)).toBe(true);

    store.remove(enrollId);

    expect(enrollment.secret.every((b) => b === 0)).toBe(true);
  });

  test("raw secret: zeroed on attempts exhausted", () => {
    store = new EnrollmentStore();
    const secret = makeSecret(11);
    const enrollId = store.create(makeOpts({ secret, maxAttempts: 1 }));

    const enrollment = store.get(enrollId)!;
    expect(enrollment.secret.some((b) => b !== 0)).toBe(true);

    store.recordFailedAttempt(enrollId);

    expect(enrollment.secret.every((b) => b === 0)).toBe(true);
  });

  test("raw secret: zeroed on TTL expiry via get()", async () => {
    store = new EnrollmentStore();
    const secret = makeSecret(13);
    const enrollId = store.create(makeOpts({ secret, ttlMs: 50 }));

    const enrollment = store.get(enrollId)!;
    expect(enrollment.secret.some((b) => b !== 0)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 60));

    // Accessing via get() should trigger expiry cleanup
    expect(store.get(enrollId)).toBeNull();
    expect(enrollment.secret.every((b) => b === 0)).toBe(true);
  });
});
