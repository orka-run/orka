/**
 * SPAKE2 password-authenticated key exchange (RFC 9382).
 *
 * Ciphersuite: SPAKE2-edwards25519-SHA256-HKDF-HMAC (orka-xtz1)
 *
 * Both sides share the same password. The protocol produces a shared session
 * key (Ke) plus confirmation MACs that each side can verify.
 *
 * Implementation follows RFC 9382 with:
 * - edwards25519 group operations via @noble/curves
 * - SHA-256 for transcript hashing
 * - HKDF-SHA256 for key derivation
 * - HMAC-SHA256 for key confirmation
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { extract, expand } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { randomBytes } from "@noble/hashes/utils.js";

// --- Types ---

const Point = ed25519.Point;
type EdPoint = InstanceType<typeof Point>;

export interface Spake2Options {
  password: Uint8Array;
  idA: Uint8Array; // identity of side A (client)
  idB: Uint8Array; // identity of side B (server)
  aad?: Uint8Array; // additional authenticated data
}

export interface Spake2Result {
  Ke: Uint8Array; // shared secret (session key)
  confirmA: Uint8Array; // MAC for A to send (confirmation)
  confirmB: Uint8Array; // MAC for B to send (confirmation)
  verifyConfirmA: (mac: Uint8Array) => boolean; // B verifies A's confirmation
  verifyConfirmB: (mac: Uint8Array) => boolean; // A verifies B's confirmation
}

// --- RFC 9382 Section 4: M and N points for edwards25519 ---

const M = Point.fromHex(
  "d048032c6ea0b6d697ddc2e86bda85a33adac920f1bf18e1b0c6d166a37004d5",
);
const N = Point.fromHex(
  "d3bfb518f44f3430f29d0c92af503865a1ed3281dc69b35dd868ba85f886c4ab",
);

// The group order for ed25519
const GROUP_ORDER = Point.Fn.ORDER;

// --- Helpers ---

/** Encode a 64-bit little-endian length prefix. */
function encodeLE64(len: number): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  // Write as two 32-bit LE values (safe for lengths up to 2^53)
  view.setUint32(0, len & 0xffffffff, true);
  view.setUint32(4, Math.floor(len / 0x100000000) & 0xffffffff, true);
  return buf;
}

/** Concatenate multiple Uint8Arrays. */
function concat(...arrays: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const a of arrays) totalLen += a.length;
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

/** Length-prefixed encoding: 8-byte LE length || data. */
function lengthPrefixed(data: Uint8Array): Uint8Array {
  return concat(encodeLE64(data.length), data);
}

/**
 * Derive the password scalar `w` from the shared secret.
 *
 * Uses HKDF-SHA256 to derive a scalar from the password, then reduces
 * modulo the group order to get a valid scalar.
 */
function derivePasswordScalar(password: Uint8Array): bigint {
  // HKDF-Extract then Expand with a context string
  // We extract 64 bytes (double the scalar size) for uniform distribution
  // before reducing modulo the group order.
  const prk = extract(sha256, password, new Uint8Array(0));
  const okm = expand(sha256, prk, new TextEncoder().encode("SPAKE2 w"), 64);

  // Convert to bigint (little-endian) and reduce modulo group order
  let w = BigInt(0);
  for (let i = okm.length - 1; i >= 0; i--) {
    w = (w << BigInt(8)) | BigInt(okm[i]);
  }
  // Reduce modulo group order, ensuring w is non-zero
  w = w % GROUP_ORDER;
  if (w === BigInt(0)) {
    w = BigInt(1); // Extremely unlikely but handle the edge case
  }
  return w;
}

/**
 * Generate a random scalar in [1, GROUP_ORDER - 1].
 */
function randomScalar(): bigint {
  // Generate 64 random bytes for uniform distribution after modular reduction
  const buf = randomBytes(64);
  let s = BigInt(0);
  for (let i = buf.length - 1; i >= 0; i--) {
    s = (s << BigInt(8)) | BigInt(buf[i]);
  }
  s = s % (GROUP_ORDER - BigInt(1));
  return s + BigInt(1); // Ensure non-zero
}

/**
 * Build the transcript hash TT per RFC 9382.
 *
 * TT = len(A) || A || len(B) || B || len(pA) || pA || len(pB) || pB
 *    || len(K) || K || len(w) || w
 *
 * If AAD is provided, it is appended: || len(AAD) || AAD
 */
function buildTranscript(
  idA: Uint8Array,
  idB: Uint8Array,
  pA: Uint8Array,
  pB: Uint8Array,
  K: Uint8Array,
  w: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  const parts: Uint8Array[] = [
    lengthPrefixed(idA),
    lengthPrefixed(idB),
    lengthPrefixed(pA),
    lengthPrefixed(pB),
    lengthPrefixed(K),
    lengthPrefixed(w),
  ];
  if (aad && aad.length > 0) {
    parts.push(lengthPrefixed(aad));
  }
  return concat(...parts);
}

/**
 * Encode a bigint scalar as a 32-byte little-endian Uint8Array.
 */
function scalarToBytes(s: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let val = s;
  for (let i = 0; i < 32; i++) {
    buf[i] = Number(val & BigInt(0xff));
    val >>= BigInt(8);
  }
  return buf;
}

/**
 * Derive key confirmation values and build the Spake2Result.
 *
 * Per RFC 9382 Section 3.4:
 *   Hash(TT) -> Ka || Ke
 *   KcA || KcB = HKDF-Expand(HKDF-Extract(Ka), "ConfirmationKeys", hash_len * 2)
 *   MAC_A = HMAC(KcA, pB)
 *   MAC_B = HMAC(KcB, pA)
 */
function deriveResult(
  idA: Uint8Array,
  idB: Uint8Array,
  pABytes: Uint8Array,
  pBBytes: Uint8Array,
  K: EdPoint,
  w: bigint,
  aad?: Uint8Array,
): Spake2Result {
  const KBytes = K.toBytes();
  const wBytes = scalarToBytes(w);

  const TT = buildTranscript(idA, idB, pABytes, pBBytes, KBytes, wBytes, aad);
  const hash = sha256(TT); // 32 bytes

  // Split into Ka (first 16 bytes) and Ke (last 16 bytes)
  const Ka = hash.slice(0, 16);
  const Ke = hash.slice(16, 32);

  // Derive confirmation keys via HKDF
  const confirmInfo = new TextEncoder().encode("ConfirmationKeys");
  const confirmPrk = extract(sha256, Ka, new Uint8Array(0));
  const confirmKeys = expand(sha256, confirmPrk, confirmInfo, 64);
  const KcA = confirmKeys.slice(0, 32);
  const KcB = confirmKeys.slice(32, 64);

  // Compute MACs
  const confirmA = hmac(sha256, KcA, pBBytes);
  const confirmB = hmac(sha256, KcB, pABytes);

  return {
    Ke,
    confirmA,
    confirmB,
    verifyConfirmA: (mac: Uint8Array) => constantTimeEqual(mac, confirmA),
    verifyConfirmB: (mac: Uint8Array) => constantTimeEqual(mac, confirmB),
  };
}

/**
 * Constant-time comparison of two byte arrays.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

// --- Public API ---

/**
 * Create Side A (client) of the SPAKE2 protocol.
 *
 * Side A generates a random scalar x, computes pA = x*G + w*M, and returns
 * the public value pA along with a finish function that completes the exchange.
 */
export function createSpake2A(opts: Spake2Options): {
  pA: Uint8Array;
  finish: (pB: Uint8Array) => Spake2Result;
} {
  const { password, idA, idB, aad } = opts;
  const w = derivePasswordScalar(password);
  const x = randomScalar();

  // pA = x*G + w*M
  const xG = Point.BASE.multiply(x);
  const wM = M.multiply(w);
  const pA = xG.add(wM);
  const pABytes = pA.toBytes();

  return {
    pA: pABytes,
    finish: (pBBytes: Uint8Array): Spake2Result => {
      // Decode pB
      const pB = Point.fromBytes(pBBytes);

      // K_A = x * (pB - w*N) = x * (y*G + w*N - w*N) = x*y*G
      const wN = N.multiply(w);
      const inner = pB.subtract(wN);
      const K = inner.multiply(x);

      return deriveResult(idA, idB, pABytes, pBBytes, K, w, aad);
    },
  };
}

/**
 * Create Side B (server) of the SPAKE2 protocol.
 *
 * Side B generates a random scalar y, computes pB = y*G + w*N, and returns
 * the public value pB along with a finish function that completes the exchange.
 */
export function createSpake2B(opts: Spake2Options): {
  pB: Uint8Array;
  finish: (pA: Uint8Array) => Spake2Result;
} {
  const { password, idA, idB, aad } = opts;
  const w = derivePasswordScalar(password);
  const y = randomScalar();

  // pB = y*G + w*N
  const yG = Point.BASE.multiply(y);
  const wN = N.multiply(w);
  const pB = yG.add(wN);
  const pBBytes = pB.toBytes();

  return {
    pB: pBBytes,
    finish: (pABytes: Uint8Array): Spake2Result => {
      // Decode pA
      const pA = Point.fromBytes(pABytes);

      // K_B = y * (pA - w*M) = y * (x*G + w*M - w*M) = x*y*G
      const wM = M.multiply(w);
      const inner = pA.subtract(wM);
      const K = inner.multiply(y);

      return deriveResult(idA, idB, pABytes, pBBytes, K, w, aad);
    },
  };
}
