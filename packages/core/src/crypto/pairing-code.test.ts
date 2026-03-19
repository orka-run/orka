import { describe, test, expect } from "bun:test";
import {
  generatePairingCode,
  parsePairingCode,
  formatPairingCode,
  crockfordEncode,
  crockfordDecode,
  crc16ccitt,
} from "./pairing-code";

describe("CRC-16/CCITT-FALSE", () => {
  test("known vector: '123456789' = 0x29B1", () => {
    const data = new TextEncoder().encode("123456789");
    expect(crc16ccitt(data)).toBe(0x29B1);
  });

  test("empty data returns 0xFFFF", () => {
    expect(crc16ccitt(new Uint8Array(0))).toBe(0xFFFF);
  });
});

describe("Crockford Base32", () => {
  test("encode and decode round-trip", () => {
    const original = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0x42]);
    const encoded = crockfordEncode(original);
    const decoded = crockfordDecode(encoded, original.length);
    expect(decoded).toEqual(original);
  });

  test("encode empty data", () => {
    expect(crockfordEncode(new Uint8Array(0))).toBe("");
  });

  test("decode empty string", () => {
    expect(crockfordDecode("")).toEqual(new Uint8Array(0));
  });

  test("decode strips dashes and spaces", () => {
    const data = new Uint8Array([0xFF, 0x00, 0xAB]);
    const encoded = crockfordEncode(data);
    // Add dashes and spaces
    const withDashes = encoded.slice(0, 2) + "-" + encoded.slice(2);
    const withSpaces = encoded.slice(0, 2) + " " + encoded.slice(2);
    expect(crockfordDecode(withDashes, data.length)).toEqual(data);
    expect(crockfordDecode(withSpaces, data.length)).toEqual(data);
  });

  test("decode applies I/L -> 1, O -> 0 correction", () => {
    // Encode a byte that has known Crockford chars
    // '1' in Crockford = value 1, so I, i, L, l should all map to 1
    // '0' in Crockford = value 0, so O, o should all map to 0
    expect(crockfordDecode("I")).toEqual(crockfordDecode("1"));
    expect(crockfordDecode("i")).toEqual(crockfordDecode("1"));
    expect(crockfordDecode("L")).toEqual(crockfordDecode("1"));
    expect(crockfordDecode("l")).toEqual(crockfordDecode("1"));
    expect(crockfordDecode("O")).toEqual(crockfordDecode("0"));
    expect(crockfordDecode("o")).toEqual(crockfordDecode("0"));
  });

  test("decode is case-insensitive", () => {
    const data = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    const encoded = crockfordEncode(data);
    expect(crockfordDecode(encoded.toLowerCase(), data.length)).toEqual(data);
    expect(crockfordDecode(encoded.toUpperCase(), data.length)).toEqual(data);
  });

  test("decode throws on invalid character U", () => {
    expect(() => crockfordDecode("U")).toThrow("Invalid Crockford Base32 character: 'U'");
  });

  test("decode throws on invalid character u", () => {
    expect(() => crockfordDecode("u")).toThrow("Invalid Crockford Base32 character: 'u'");
  });
});

describe("Pairing Code", () => {
  test("round-trip: generate -> parse -> verify", () => {
    const { code, parsed } = generatePairingCode();
    const reparsed = parsePairingCode(code);

    expect(reparsed.version).toBe(1);
    expect(reparsed.version).toBe(parsed.version);
    expect(reparsed.secret).toEqual(parsed.secret);
    expect(reparsed.secret.length).toBe(10);
  });

  test("format: output matches XXXX-XXXX-XXXX-XXXX-XXXXX pattern", () => {
    const { code } = generatePairingCode();
    const parts = code.split("-");
    expect(parts.length).toBe(5);
    expect(parts[0]!.length).toBe(4);
    expect(parts[1]!.length).toBe(4);
    expect(parts[2]!.length).toBe(4);
    expect(parts[3]!.length).toBe(4);
    expect(parts[4]!.length).toBe(5);
    // Total chars (without dashes) = 21
    expect(code.replace(/-/g, "").length).toBe(21);
  });

  test("case-insensitive: lowercase parses the same", () => {
    const { code, parsed } = generatePairingCode();
    const reparsed = parsePairingCode(code.toLowerCase());
    expect(reparsed.version).toBe(parsed.version);
    expect(reparsed.secret).toEqual(parsed.secret);
  });

  test("I/L/O correction: substituted characters still parse", () => {
    // Generate and get a code, then replace valid chars with confusable ones
    // We need to be careful: only replace chars that actually map to 1 or 0
    const { code, parsed } = generatePairingCode();
    const stripped = code.replace(/-/g, "");

    // Replace '1' with 'I', 'L' and '0' with 'O' where they appear
    let modified = stripped.replace(/1/g, "I");
    modified = modified.replace(/0/g, "O");

    // Add dashes back in the proper positions
    const formatted = [
      modified.slice(0, 4),
      modified.slice(4, 8),
      modified.slice(8, 12),
      modified.slice(12, 16),
      modified.slice(16, 21),
    ].join("-");

    const reparsed = parsePairingCode(formatted);
    expect(reparsed.version).toBe(parsed.version);
    expect(reparsed.secret).toEqual(parsed.secret);
  });

  test("spaces and dashes stripped: various formats parse the same", () => {
    const { code } = generatePairingCode();
    const stripped = code.replace(/-/g, "");

    // With spaces instead of dashes
    const withSpaces = [
      stripped.slice(0, 4),
      stripped.slice(4, 8),
      stripped.slice(8, 12),
      stripped.slice(12, 16),
      stripped.slice(16, 21),
    ].join(" ");

    // No separators at all
    const noSeps = stripped;

    const fromDashes = parsePairingCode(code);
    const fromSpaces = parsePairingCode(withSpaces);
    const fromNone = parsePairingCode(noSeps);

    expect(fromSpaces.secret).toEqual(fromDashes.secret);
    expect(fromNone.secret).toEqual(fromDashes.secret);
  });

  test("bad checksum: flipped character throws", () => {
    const { code } = generatePairingCode();
    const stripped = code.replace(/-/g, "");

    // Flip the last character to a different valid Crockford char
    const lastChar = stripped[stripped.length - 1];
    const altChar = lastChar === "0" ? "1" : "0";

    const tampered = stripped.slice(0, -1) + altChar;
    // Reformat with dashes
    const formatted = [
      tampered.slice(0, 4),
      tampered.slice(4, 8),
      tampered.slice(8, 12),
      tampered.slice(12, 16),
      tampered.slice(16, 21),
    ].join("-");

    expect(() => parsePairingCode(formatted)).toThrow();
  });

  test("invalid character U throws", () => {
    const { code } = generatePairingCode();
    // Replace first char with U (not in Crockford alphabet)
    const tampered = "U" + code.slice(1);
    expect(() => parsePairingCode(tampered)).toThrow("Invalid Crockford Base32 character");
  });

  test("wrong length: too short throws", () => {
    expect(() => parsePairingCode("ABCD-EFGH")).toThrow("Invalid pairing code length");
  });

  test("wrong length: too long throws", () => {
    const { code } = generatePairingCode();
    expect(() => parsePairingCode(code + "A")).toThrow("Invalid pairing code length");
  });

  test("unsupported version throws", () => {
    // Build a valid binary with version 255
    const payload = new Uint8Array(11);
    payload[0] = 255; // unsupported version
    // Fill secret with zeros
    const checksum = crc16ccitt(payload);
    const full = new Uint8Array(13);
    full.set(payload, 0);
    full[11] = (checksum >> 8) & 0xFF;
    full[12] = checksum & 0xFF;

    const code = formatPairingCode(full);
    expect(() => parsePairingCode(code)).toThrow("Unsupported pairing code version: 255");
  });

  test("multiple generations produce different codes", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 10; i++) {
      codes.add(generatePairingCode().code);
    }
    // All 10 should be unique (probability of collision with 80 bits of randomness is negligible)
    expect(codes.size).toBe(10);
  });

  test("all characters in output are valid Crockford + dashes", () => {
    const validChars = new Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ-");
    for (let i = 0; i < 20; i++) {
      const { code } = generatePairingCode();
      for (const ch of code) {
        expect(validChars.has(ch)).toBe(true);
      }
    }
  });
});
