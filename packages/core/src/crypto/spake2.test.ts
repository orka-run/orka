import { describe, test, expect } from "bun:test";
import { createSpake2A, createSpake2B, type Spake2Options } from "./spake2";

const enc = new TextEncoder();

function makeOpts(overrides?: Partial<Spake2Options>): Spake2Options {
  return {
    password: enc.encode("shared-secret-password"),
    idA: enc.encode("client"),
    idB: enc.encode("server"),
    ...overrides,
  };
}

describe("SPAKE2", () => {
  test("round-trip: same password produces matching Ke and valid confirmations", () => {
    const opts = makeOpts();
    const sideA = createSpake2A(opts);
    const sideB = createSpake2B(opts);

    // Exchange public values
    const resultA = sideA.finish(sideB.pB);
    const resultB = sideB.finish(sideA.pA);

    // Both sides derive the same session key
    expect(resultA.Ke).toEqual(resultB.Ke);
    expect(resultA.Ke.length).toBe(16);

    // Confirmation MACs match
    expect(resultA.confirmA).toEqual(resultB.confirmA);
    expect(resultA.confirmB).toEqual(resultB.confirmB);

    // B verifies A's confirmation
    expect(resultB.verifyConfirmA(resultA.confirmA)).toBe(true);

    // A verifies B's confirmation
    expect(resultA.verifyConfirmB(resultB.confirmB)).toBe(true);
  });

  test("wrong password: key confirmation fails", () => {
    const sideA = createSpake2A(makeOpts({ password: enc.encode("password-A") }));
    const sideB = createSpake2B(makeOpts({ password: enc.encode("password-B") }));

    const resultA = sideA.finish(sideB.pB);
    const resultB = sideB.finish(sideA.pA);

    // Session keys differ
    expect(resultA.Ke).not.toEqual(resultB.Ke);

    // Confirmation fails
    expect(resultB.verifyConfirmA(resultA.confirmA)).toBe(false);
    expect(resultA.verifyConfirmB(resultB.confirmB)).toBe(false);
  });

  test("identity binding: different idA causes confirmation failure", () => {
    const optsA = makeOpts({ idA: enc.encode("alice") });
    const optsB = makeOpts({ idA: enc.encode("mallory") });

    const sideA = createSpake2A(optsA);
    const sideB = createSpake2B(optsB);

    const resultA = sideA.finish(sideB.pB);
    const resultB = sideB.finish(sideA.pA);

    // Same password, same w, same K, but different TT due to identity mismatch
    // So Ke and confirmations will differ
    expect(resultA.Ke).not.toEqual(resultB.Ke);
    expect(resultB.verifyConfirmA(resultA.confirmA)).toBe(false);
    expect(resultA.verifyConfirmB(resultB.confirmB)).toBe(false);
  });

  test("identity binding: different idB causes confirmation failure", () => {
    const optsA = makeOpts({ idB: enc.encode("server-1") });
    const optsB = makeOpts({ idB: enc.encode("server-2") });

    const sideA = createSpake2A(optsA);
    const sideB = createSpake2B(optsB);

    const resultA = sideA.finish(sideB.pB);
    const resultB = sideB.finish(sideA.pA);

    expect(resultA.Ke).not.toEqual(resultB.Ke);
    expect(resultB.verifyConfirmA(resultA.confirmA)).toBe(false);
    expect(resultA.verifyConfirmB(resultB.confirmB)).toBe(false);
  });

  test("AAD binding: different AAD causes confirmation failure", () => {
    const optsA = makeOpts({ aad: enc.encode("context-1") });
    const optsB = makeOpts({ aad: enc.encode("context-2") });

    const sideA = createSpake2A(optsA);
    const sideB = createSpake2B(optsB);

    const resultA = sideA.finish(sideB.pB);
    const resultB = sideB.finish(sideA.pA);

    expect(resultA.Ke).not.toEqual(resultB.Ke);
    expect(resultB.verifyConfirmA(resultA.confirmA)).toBe(false);
    expect(resultA.verifyConfirmB(resultB.confirmB)).toBe(false);
  });

  test("AAD binding: same AAD succeeds", () => {
    const opts = makeOpts({ aad: enc.encode("shared-context") });

    const sideA = createSpake2A(opts);
    const sideB = createSpake2B(opts);

    const resultA = sideA.finish(sideB.pB);
    const resultB = sideB.finish(sideA.pA);

    expect(resultA.Ke).toEqual(resultB.Ke);
    expect(resultB.verifyConfirmA(resultA.confirmA)).toBe(true);
    expect(resultA.verifyConfirmB(resultB.confirmB)).toBe(true);
  });

  test("determinism check: different sessions produce different pA/pB but same Ke after exchange", () => {
    const opts = makeOpts();

    const session1A = createSpake2A(opts);
    const session1B = createSpake2B(opts);

    const session2A = createSpake2A(opts);
    const session2B = createSpake2B(opts);

    // Public values should differ due to different random scalars
    expect(session1A.pA).not.toEqual(session2A.pA);
    expect(session1B.pB).not.toEqual(session2B.pB);

    // But within each session, both sides agree on Ke
    const result1A = session1A.finish(session1B.pB);
    const result1B = session1B.finish(session1A.pA);
    expect(result1A.Ke).toEqual(result1B.Ke);

    const result2A = session2A.finish(session2B.pB);
    const result2B = session2B.finish(session2A.pA);
    expect(result2A.Ke).toEqual(result2B.Ke);
  });

  test("multiple sessions: same password produces different Ke each time (ephemeral randomness)", () => {
    const opts = makeOpts();

    const session1A = createSpake2A(opts);
    const session1B = createSpake2B(opts);
    const result1A = session1A.finish(session1B.pB);
    const result1B = session1B.finish(session1A.pA);

    const session2A = createSpake2A(opts);
    const session2B = createSpake2B(opts);
    const result2A = session2A.finish(session2B.pB);
    const result2B = session2B.finish(session2A.pA);

    // Both sessions succeed
    expect(result1A.Ke).toEqual(result1B.Ke);
    expect(result2A.Ke).toEqual(result2B.Ke);

    // But they produce different keys
    expect(result1A.Ke).not.toEqual(result2A.Ke);
  });

  test("pA and pB are 32-byte compressed edwards25519 points", () => {
    const opts = makeOpts();
    const sideA = createSpake2A(opts);
    const sideB = createSpake2B(opts);

    expect(sideA.pA.length).toBe(32);
    expect(sideB.pB.length).toBe(32);
  });

  test("confirmation MACs are 32-byte HMAC-SHA256 values", () => {
    const opts = makeOpts();
    const sideA = createSpake2A(opts);
    const sideB = createSpake2B(opts);

    const resultA = sideA.finish(sideB.pB);

    expect(resultA.confirmA.length).toBe(32);
    expect(resultA.confirmB.length).toBe(32);
  });

  test("verifyConfirmA rejects tampered MAC", () => {
    const opts = makeOpts();
    const sideA = createSpake2A(opts);
    const sideB = createSpake2B(opts);

    const resultA = sideA.finish(sideB.pB);
    const resultB = sideB.finish(sideA.pA);

    // Tamper with a byte
    const tampered = new Uint8Array(resultA.confirmA);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;

    expect(resultB.verifyConfirmA(tampered)).toBe(false);
  });

  test("verifyConfirmB rejects tampered MAC", () => {
    const opts = makeOpts();
    const sideA = createSpake2A(opts);
    const sideB = createSpake2B(opts);

    const resultA = sideA.finish(sideB.pB);
    const resultB = sideB.finish(sideA.pA);

    const tampered = new Uint8Array(resultB.confirmB);
    tampered[15] = (tampered[15] ?? 0) ^ 0x01;

    expect(resultA.verifyConfirmB(tampered)).toBe(false);
  });

  test("verify rejects MAC of wrong length", () => {
    const opts = makeOpts();
    const sideA = createSpake2A(opts);
    const sideB = createSpake2B(opts);

    const resultA = sideA.finish(sideB.pB);
    const resultB = sideB.finish(sideA.pA);

    // Too short
    expect(resultB.verifyConfirmA(resultA.confirmA.slice(0, 16))).toBe(false);
    // Too long
    const extended = new Uint8Array(64);
    extended.set(resultB.confirmB);
    expect(resultA.verifyConfirmB(extended)).toBe(false);
  });

  test("empty password works", () => {
    const opts = makeOpts({ password: new Uint8Array(0) });
    const sideA = createSpake2A(opts);
    const sideB = createSpake2B(opts);

    const resultA = sideA.finish(sideB.pB);
    const resultB = sideB.finish(sideA.pA);

    expect(resultA.Ke).toEqual(resultB.Ke);
    expect(resultB.verifyConfirmA(resultA.confirmA)).toBe(true);
    expect(resultA.verifyConfirmB(resultB.confirmB)).toBe(true);
  });

  test("empty identities work", () => {
    const opts = makeOpts({
      idA: new Uint8Array(0),
      idB: new Uint8Array(0),
    });
    const sideA = createSpake2A(opts);
    const sideB = createSpake2B(opts);

    const resultA = sideA.finish(sideB.pB);
    const resultB = sideB.finish(sideA.pA);

    expect(resultA.Ke).toEqual(resultB.Ke);
    expect(resultB.verifyConfirmA(resultA.confirmA)).toBe(true);
    expect(resultA.verifyConfirmB(resultB.confirmB)).toBe(true);
  });
});
