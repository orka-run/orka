import { describe, expect, test } from "bun:test";
import {
  generatePairingCode,
  parsePairingCode,
  blake3Truncated,
  concatBytes,
} from "../crypto/index";

const encoder = new TextEncoder();

describe("pairing code to enroll ID derivation", () => {
  test("derives consistent enroll ID from generated pairing code", () => {
    const { code, parsed } = generatePairingCode();

    // Parse the code back to get the secret
    const reparsed = parsePairingCode(code);
    expect(Buffer.from(reparsed.secret).toString("hex")).toBe(
      Buffer.from(parsed.secret).toString("hex"),
    );

    // Derive enroll_id from the secret (same algorithm as PairingClient and EnrollmentStore)
    const prefix = encoder.encode("orka/pair/v1/enroll-id");
    const input = concatBytes(prefix, parsed.secret);
    const enrollIdBytes = blake3Truncated(input, 8);
    const enrollId = Buffer.from(enrollIdBytes).toString("hex");

    // Should be 16 hex chars (8 bytes)
    expect(enrollId).toHaveLength(16);
    expect(enrollId).toMatch(/^[0-9a-f]{16}$/);

    // Deriving again from reparsed secret should give the same result
    const input2 = concatBytes(prefix, reparsed.secret);
    const enrollIdBytes2 = blake3Truncated(input2, 8);
    const enrollId2 = Buffer.from(enrollIdBytes2).toString("hex");

    expect(enrollId2).toBe(enrollId);
  });

  test("different pairing codes yield different enroll IDs", () => {
    const { parsed: parsed1 } = generatePairingCode();
    const { parsed: parsed2 } = generatePairingCode();

    const prefix = encoder.encode("orka/pair/v1/enroll-id");

    const enrollId1 = Buffer.from(
      blake3Truncated(concatBytes(prefix, parsed1.secret), 8),
    ).toString("hex");

    const enrollId2 = Buffer.from(
      blake3Truncated(concatBytes(prefix, parsed2.secret), 8),
    ).toString("hex");

    expect(enrollId1).not.toBe(enrollId2);
  });

  test("pairing code round-trip preserves version and secret", () => {
    const { code, parsed } = generatePairingCode();
    const reparsed = parsePairingCode(code);

    expect(reparsed.version).toBe(1);
    expect(reparsed.secret).toHaveLength(10);
    expect(Buffer.from(reparsed.secret).toString("hex")).toBe(
      Buffer.from(parsed.secret).toString("hex"),
    );
  });

  test("invalid pairing code throws", () => {
    expect(() => parsePairingCode("AAAA-BBBB")).toThrow();
    expect(() => parsePairingCode("")).toThrow();
    expect(() => parsePairingCode("0000-0000-0000-0000-00000")).toThrow(
      "checksum",
    );
  });
});
