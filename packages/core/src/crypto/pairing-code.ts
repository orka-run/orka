/**
 * Pairing code codec — Crockford Base32 encoding of a versioned secret with CRC-16 checksum.
 *
 * Code format (human-readable): XXXX-XXXX-XXXX-XXXX-XXXXX
 *
 * Binary structure (13 bytes):
 *   version:  1 byte  (0x01 for v1)
 *   secret:  10 bytes (80 random bits)
 *   checksum: 2 bytes (CRC-16/CCITT-FALSE over version||secret, big-endian)
 *
 * 13 bytes = 104 bits -> 21 Crockford Base32 characters (with 1 bit padding)
 * Displayed as 4-4-4-4-5 groups separated by dashes.
 */

import { randomBytes } from "node:crypto";

// --- Crockford Base32 ---

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Reverse lookup table built at module load time. */
const DECODE_MAP = new Map<string, number>();
for (let i = 0; i < CROCKFORD_ALPHABET.length; i++) {
  DECODE_MAP.set(CROCKFORD_ALPHABET[i], i);
}
// Lowercase equivalents
for (let i = 0; i < CROCKFORD_ALPHABET.length; i++) {
  DECODE_MAP.set(CROCKFORD_ALPHABET[i].toLowerCase(), i);
}
// Error-correcting aliases
DECODE_MAP.set("I", 1);
DECODE_MAP.set("i", 1);
DECODE_MAP.set("L", 1);
DECODE_MAP.set("l", 1);
DECODE_MAP.set("O", 0);
DECODE_MAP.set("o", 0);

/**
 * Encode a Uint8Array as a Crockford Base32 string (no padding chars).
 */
export function crockfordEncode(data: Uint8Array): string {
  if (data.length === 0) return "";

  // Collect all bits into a single buffer of 0/1 values
  const bits: number[] = [];
  for (const byte of data) {
    for (let bit = 7; bit >= 0; bit--) {
      bits.push((byte >> bit) & 1);
    }
  }

  // Take 5 bits at a time
  let result = "";
  for (let i = 0; i < bits.length; i += 5) {
    let value = 0;
    for (let j = 0; j < 5; j++) {
      value <<= 1;
      if (i + j < bits.length) {
        value |= bits[i + j];
      }
      // Implicit zero-padding if bits run out
    }
    result += CROCKFORD_ALPHABET[value];
  }

  return result;
}

/**
 * Decode a Crockford Base32 string to bytes.
 * Strips dashes and spaces before decoding.
 * Applies error-correcting aliases (I/L -> 1, O -> 0).
 *
 * @param expectedBytes If provided, the result is truncated to exactly this many bytes
 *   (discarding padding bits). If not provided, the raw decoded bytes are returned.
 */
export function crockfordDecode(input: string, expectedBytes?: number): Uint8Array {
  // Strip dashes and spaces
  const cleaned = input.replace(/[-\s]/g, "");

  if (cleaned.length === 0) return new Uint8Array(0);

  // Validate and collect 5-bit values
  const bits: number[] = [];
  for (const ch of cleaned) {
    const value = DECODE_MAP.get(ch);
    if (value === undefined) {
      throw new Error(`Invalid Crockford Base32 character: '${ch}'`);
    }
    // Push 5 bits (MSB first)
    for (let bit = 4; bit >= 0; bit--) {
      bits.push((value >> bit) & 1);
    }
  }

  // Determine how many bytes to produce
  const byteCount = expectedBytes ?? Math.floor(bits.length / 8);

  const result = new Uint8Array(byteCount);
  for (let i = 0; i < byteCount; i++) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit++) {
      byte <<= 1;
      const idx = i * 8 + bit;
      if (idx < bits.length) {
        byte |= bits[idx];
      }
    }
    result[i] = byte;
  }

  return result;
}

// --- CRC-16/CCITT-FALSE ---

/**
 * Compute CRC-16/CCITT-FALSE over the given data.
 *
 * Parameters:
 *   Polynomial: 0x1021
 *   Initial value: 0xFFFF
 *   Input reflected: No
 *   Output reflected: No
 *   Final XOR: 0x0000
 */
export function crc16ccitt(data: Uint8Array): number {
  let crc = 0xFFFF;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return crc;
}

// --- Pairing Code API ---

const PAIRING_CODE_VERSION = 1;
const SECRET_LENGTH = 10; // bytes
const TOTAL_BINARY_LENGTH = 1 + SECRET_LENGTH + 2; // 13 bytes
const ENCODED_CHAR_COUNT = 21; // ceil(13 * 8 / 5) = ceil(104/5) = 21

export interface PairingCode {
  version: number;
  secret: Uint8Array; // 10 bytes
}

/**
 * Generate a new pairing code with a random secret.
 */
export function generatePairingCode(): { code: string; parsed: PairingCode } {
  const secret = new Uint8Array(randomBytes(SECRET_LENGTH));
  const parsed: PairingCode = { version: PAIRING_CODE_VERSION, secret };

  // Build binary payload: version || secret
  const payload = new Uint8Array(1 + SECRET_LENGTH);
  payload[0] = PAIRING_CODE_VERSION;
  payload.set(secret, 1);

  // Compute checksum over version || secret
  const checksum = crc16ccitt(payload);

  // Full binary: version || secret || checksum (big-endian)
  const full = new Uint8Array(TOTAL_BINARY_LENGTH);
  full.set(payload, 0);
  full[11] = (checksum >> 8) & 0xFF;
  full[12] = checksum & 0xFF;

  const code = formatPairingCode(full);
  return { code, parsed };
}

/**
 * Format binary data (13 bytes) as a human-readable pairing code with dashes.
 * Output format: XXXX-XXXX-XXXX-XXXX-XXXXX (4-4-4-4-5)
 */
export function formatPairingCode(data: Uint8Array): string {
  const encoded = crockfordEncode(data);
  // Group as 4-4-4-4-5
  const groups = [
    encoded.slice(0, 4),
    encoded.slice(4, 8),
    encoded.slice(8, 12),
    encoded.slice(12, 16),
    encoded.slice(16, 21),
  ];
  return groups.join("-");
}

/**
 * Parse a human-entered pairing code string.
 *
 * Strips dashes/spaces, applies Crockford error correction (I/L -> 1, O -> 0),
 * validates length, checksum, and version.
 *
 * @throws Error on invalid characters, wrong length, bad checksum, or unsupported version
 */
export function parsePairingCode(code: string): PairingCode {
  // Strip dashes and spaces for length validation
  const cleaned = code.replace(/[-\s]/g, "");

  if (cleaned.length !== ENCODED_CHAR_COUNT) {
    throw new Error(
      `Invalid pairing code length: expected ${ENCODED_CHAR_COUNT} characters, got ${cleaned.length}`
    );
  }

  // Decode (will throw on invalid characters)
  const data = crockfordDecode(cleaned, TOTAL_BINARY_LENGTH);

  // Extract fields
  const version = data[0];
  const secret = data.slice(1, 1 + SECRET_LENGTH);
  const checksumReceived = (data[11] << 8) | data[12];

  // Verify checksum over version || secret
  const payload = data.slice(0, 1 + SECRET_LENGTH);
  const checksumComputed = crc16ccitt(payload);

  if (checksumReceived !== checksumComputed) {
    throw new Error("Invalid pairing code: checksum mismatch");
  }

  // Verify version
  if (version !== PAIRING_CODE_VERSION) {
    throw new Error(`Unsupported pairing code version: ${version}`);
  }

  return { version, secret };
}
