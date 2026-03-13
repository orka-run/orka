/**
 * Cryptographic hash wrappers using @noble/hashes.
 *
 * Provides BLAKE3 (full and truncated) and SHA-256 as pure functions
 * operating on Uint8Array inputs and outputs.
 */

import { blake3 as nobleBlake3 } from "@noble/hashes/blake3.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

/**
 * Compute a full 32-byte BLAKE3 hash.
 */
export function blake3(data: Uint8Array): Uint8Array {
  return nobleBlake3(data);
}

/**
 * Compute a BLAKE3 hash truncated to the specified number of bytes.
 *
 * Key use case:
 *   enroll_id = blake3Truncated(concat("orka/pair/v1/enroll-id", secret), 8)
 *   → 8 bytes (64 bits)
 */
export function blake3Truncated(data: Uint8Array, bytes: number): Uint8Array {
  const full = nobleBlake3(data);
  return full.slice(0, bytes);
}

/**
 * Compute a 32-byte SHA-256 hash.
 *
 * Used for SHA256(pair_context) as AAD for the bootstrap channel.
 */
export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

/**
 * Concatenate multiple Uint8Arrays into one.
 * Utility for building hash inputs like `prefix || secret`.
 */
export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const arr of arrays) {
    totalLength += arr.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
