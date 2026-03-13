/**
 * Noise_NK_25519_ChaChaPoly_SHA256 implementation.
 *
 * Noise NK pattern:
 *   Pre-message:  <- s  (responder's static key is known to initiator)
 *   Message 1:    -> e, es
 *   Message 2:    <- e, ee
 *   After:        Split() produces two CipherState objects for bidirectional transport
 *
 * Crypto primitives:
 *   DH:   X25519 (via @noble/curves)
 *   AEAD: ChaCha20-Poly1305 (via @noble/ciphers)
 *   Hash: SHA-256 (via @noble/hashes)
 *   HKDF: HKDF-SHA256 (via @noble/hashes)
 *
 * Reference: https://noiseprotocol.org/noise.html
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { randomBytes } from "@noble/hashes/utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Protocol name per Noise spec naming convention. */
const PROTOCOL_NAME = "Noise_NK_25519_ChaChaPoly_SHA256";

/** HASHLEN for SHA-256 is 32 bytes. */
const HASHLEN = 32;

/** DHLEN for X25519 is 32 bytes. */
const DHLEN = 32;

/** Maximum nonce value (2^64 - 1). We use Number.MAX_SAFE_INTEGER as a
 *  practical limit since JS can't do 64-bit integer math natively. In practice
 *  nobody will send 2^53 messages in a session. */
const MAX_NONCE = Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Encode a 64-bit nonce as 12 bytes: 4 zero bytes + 8-byte little-endian. */
function encodeNonce(n: number): Uint8Array {
  const buf = new Uint8Array(12);
  // First 4 bytes are zero (already).
  // Next 8 bytes are little-endian encoding of the 64-bit counter.
  // Since JS numbers are safe up to 2^53, we split into two 32-bit halves.
  const lo = n >>> 0; // low 32 bits
  const hi = (n / 0x100000000) >>> 0; // high 32 bits
  buf[4] = lo & 0xff;
  buf[5] = (lo >>> 8) & 0xff;
  buf[6] = (lo >>> 16) & 0xff;
  buf[7] = (lo >>> 24) & 0xff;
  buf[8] = hi & 0xff;
  buf[9] = (hi >>> 8) & 0xff;
  buf[10] = (hi >>> 16) & 0xff;
  buf[11] = (hi >>> 24) & 0xff;
  return buf;
}

/** Concatenate Uint8Arrays. */
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

/** EMPTY is a zero-length byte array used as default payload. */
const EMPTY = new Uint8Array(0);

// ---------------------------------------------------------------------------
// X25519 DH
// ---------------------------------------------------------------------------

export interface X25519KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** Generate an X25519 keypair. */
export function generateX25519KeyPair(): X25519KeyPair {
  const privateKey = randomBytes(32);
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/** Perform X25519 DH. Returns 32-byte shared secret. */
function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(privateKey, publicKey);
}

// ---------------------------------------------------------------------------
// CipherState (Section 5.1)
// ---------------------------------------------------------------------------

export interface CipherState {
  encrypt(plaintext: Uint8Array, ad?: Uint8Array): Uint8Array;
  decrypt(ciphertext: Uint8Array, ad?: Uint8Array): Uint8Array;
}

function createCipherState(k: Uint8Array | null): CipherState & {
  _k: Uint8Array | null;
  _n: number;
  hasKey(): boolean;
  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
  setNonce(n: number): void;
} {
  let _k = k;
  let _n = 0;

  function hasKey(): boolean {
    return _k !== null;
  }

  function setNonce(n: number): void {
    _n = n;
  }

  function encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!_k) return plaintext;
    if (_n >= MAX_NONCE) {
      throw new Error("Noise: nonce overflow");
    }
    const nonce = encodeNonce(_n);
    const cipher = chacha20poly1305(_k, nonce, ad);
    const ciphertext = cipher.encrypt(plaintext);
    _n++;
    return ciphertext;
  }

  function decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!_k) return ciphertext;
    if (_n >= MAX_NONCE) {
      throw new Error("Noise: nonce overflow");
    }
    const nonce = encodeNonce(_n);
    const cipher = chacha20poly1305(_k, nonce, ad);
    const plaintext = cipher.decrypt(ciphertext);
    _n++;
    return plaintext;
  }

  return {
    get _k() { return _k; },
    get _n() { return _n; },
    hasKey,
    setNonce,
    encryptWithAd,
    decryptWithAd,
    encrypt(plaintext: Uint8Array, ad?: Uint8Array): Uint8Array {
      return encryptWithAd(ad ?? EMPTY, plaintext);
    },
    decrypt(ciphertext: Uint8Array, ad?: Uint8Array): Uint8Array {
      return decryptWithAd(ad ?? EMPTY, ciphertext);
    },
  };
}

// ---------------------------------------------------------------------------
// SymmetricState (Section 5.2)
// ---------------------------------------------------------------------------

function createSymmetricState(protocolName: string) {
  // InitializeSymmetric: if protocolName.length <= HASHLEN, pad with zeros;
  // otherwise h = HASH(protocolName).
  const nameBytes = new TextEncoder().encode(protocolName);
  let h: Uint8Array;
  if (nameBytes.length <= HASHLEN) {
    h = new Uint8Array(HASHLEN);
    h.set(nameBytes);
  } else {
    h = sha256(nameBytes);
  }
  let ck = new Uint8Array(h); // ck = h
  let cs = createCipherState(null);

  function mixKey(inputKeyMaterial: Uint8Array): void {
    // HKDF(ck, input_key_material, 2) → (ck, temp_k)
    const out = hkdf(sha256, inputKeyMaterial, ck, undefined, 2 * HASHLEN);
    ck = new Uint8Array(out.slice(0, HASHLEN));
    const tempK = new Uint8Array(out.slice(HASHLEN, 2 * HASHLEN));
    cs = createCipherState(tempK);
  }

  function mixHash(data: Uint8Array): void {
    h = sha256(concat(h, data));
  }

  /** MixKeyAndHash is not needed for NK pattern (no PSK), omitted. */

  function encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = cs.encryptWithAd(h, plaintext);
    mixHash(ciphertext);
    return ciphertext;
  }

  function decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = cs.decryptWithAd(h, ciphertext);
    mixHash(ciphertext);
    return plaintext;
  }

  function split(): [CipherState, CipherState] {
    const out = hkdf(sha256, EMPTY, ck, undefined, 2 * HASHLEN);
    const tempK1 = new Uint8Array(out.slice(0, HASHLEN));
    const tempK2 = new Uint8Array(out.slice(HASHLEN, 2 * HASHLEN));
    return [createCipherState(tempK1), createCipherState(tempK2)];
  }

  function getHandshakeHash(): Uint8Array {
    return new Uint8Array(h);
  }

  return {
    mixKey,
    mixHash,
    encryptAndHash,
    decryptAndHash,
    split,
    getHandshakeHash,
    get h() { return h; },
    get ck() { return ck; },
    get cs() { return cs; },
  };
}

// ---------------------------------------------------------------------------
// HandshakeState — NK pattern (Section 5.3)
// ---------------------------------------------------------------------------

/**
 * Result of a completed Noise NK handshake.
 */
export interface NoiseHandshakeResult {
  /** CipherState for sending transport messages. */
  sendCipher: CipherState;
  /** CipherState for receiving transport messages. */
  recvCipher: CipherState;
  /** GetHandshakeHash() for channel binding. */
  handshakeHash: Uint8Array;
}

// ---------------------------------------------------------------------------
// Initiator
// ---------------------------------------------------------------------------

export interface NoiseInitiator {
  /** Write handshake message 1: -> e, es. Returns the message to send. */
  writeMessage1(payload?: Uint8Array): Uint8Array;
  /** Read handshake message 2: <- e, ee. Returns payload and handshake result. */
  readMessage2(msg: Uint8Array): { payload: Uint8Array; result: NoiseHandshakeResult };
}

/**
 * Create a Noise NK initiator (client).
 *
 * @param prologue - Prologue data for session binding. Both sides must use
 *   the same prologue or the handshake will fail.
 * @param remoteStaticPubkey - The responder's static public key (32 bytes).
 *   This is the "pre-message" `<- s` in NK.
 */
export function createInitiator(
  prologue: Uint8Array,
  remoteStaticPubkey: Uint8Array,
): NoiseInitiator {
  const ss = createSymmetricState(PROTOCOL_NAME);

  // Initialize per Noise spec Section 5.3:
  // 1. Mix prologue first
  ss.mixHash(prologue);
  // 2. Then process pre-message pattern: <- s (responder's static key)
  ss.mixHash(remoteStaticPubkey);

  let ephemeral: X25519KeyPair | null = null;

  return {
    writeMessage1(payload?: Uint8Array): Uint8Array {
      const pl = payload ?? EMPTY;

      // -> e: Generate ephemeral keypair, send public key, mix hash
      ephemeral = generateX25519KeyPair();
      ss.mixHash(ephemeral.publicKey);

      // -> es: DH(e, rs) where e is our ephemeral, rs is remote static
      const dhResult = dh(ephemeral.privateKey, remoteStaticPubkey);
      ss.mixKey(dhResult);

      // Encrypt and hash the payload
      const encPayload = ss.encryptAndHash(pl);

      // Message = e.public_key || encrypted_payload
      return concat(ephemeral.publicKey, encPayload);
    },

    readMessage2(msg: Uint8Array): { payload: Uint8Array; result: NoiseHandshakeResult } {
      if (!ephemeral) {
        throw new Error("Noise: must call writeMessage1 before readMessage2");
      }

      // <- e: Read responder's ephemeral public key
      const re = msg.slice(0, DHLEN);
      ss.mixHash(re);

      // <- ee: DH(e, re)
      const dhResult = dh(ephemeral.privateKey, re);
      ss.mixKey(dhResult);

      // Decrypt payload
      const encPayload = msg.slice(DHLEN);
      const payload = ss.decryptAndHash(encPayload);

      // Split
      const [c1, c2] = ss.split();
      const handshakeHash = ss.getHandshakeHash();

      // Initiator: c1 is for sending, c2 is for receiving
      return {
        payload,
        result: {
          sendCipher: c1,
          recvCipher: c2,
          handshakeHash,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Responder
// ---------------------------------------------------------------------------

export interface NoiseResponder {
  /** Read handshake message 1: -> e, es. Returns the payload. */
  readMessage1(msg: Uint8Array): { payload: Uint8Array };
  /** Write handshake message 2: <- e, ee. Returns message and handshake result. */
  writeMessage2(payload?: Uint8Array): { msg: Uint8Array; result: NoiseHandshakeResult };
}

/**
 * Create a Noise NK responder (server).
 *
 * @param prologue - Prologue data. Must match the initiator's prologue.
 * @param staticKeypair - The responder's static X25519 keypair.
 */
export function createResponder(
  prologue: Uint8Array,
  staticKeypair: X25519KeyPair,
): NoiseResponder {
  const ss = createSymmetricState(PROTOCOL_NAME);

  // Initialize per Noise spec Section 5.3:
  // 1. Mix prologue first
  ss.mixHash(prologue);
  // 2. Then process pre-message pattern: <- s (our own static key)
  ss.mixHash(staticKeypair.publicKey);

  let remoteEphemeral: Uint8Array | null = null;
  let ephemeral: X25519KeyPair | null = null;

  return {
    readMessage1(msg: Uint8Array): { payload: Uint8Array } {
      // -> e: Read initiator's ephemeral public key
      remoteEphemeral = msg.slice(0, DHLEN);
      ss.mixHash(remoteEphemeral);

      // -> es: DH(s, re) where s is our static, re is remote ephemeral
      const dhResult = dh(staticKeypair.privateKey, remoteEphemeral);
      ss.mixKey(dhResult);

      // Decrypt payload
      const encPayload = msg.slice(DHLEN);
      const payload = ss.decryptAndHash(encPayload);

      return { payload };
    },

    writeMessage2(payload?: Uint8Array): { msg: Uint8Array; result: NoiseHandshakeResult } {
      if (!remoteEphemeral) {
        throw new Error("Noise: must call readMessage1 before writeMessage2");
      }

      const pl = payload ?? EMPTY;

      // <- e: Generate ephemeral, send public key, mix hash
      ephemeral = generateX25519KeyPair();
      ss.mixHash(ephemeral.publicKey);

      // <- ee: DH(e, re) where e is our ephemeral, re is remote ephemeral
      const dhResult = dh(ephemeral.privateKey, remoteEphemeral);
      ss.mixKey(dhResult);

      // Encrypt payload
      const encPayload = ss.encryptAndHash(pl);

      // Split
      const [c1, c2] = ss.split();
      const handshakeHash = ss.getHandshakeHash();

      // Responder: c2 is for sending, c1 is for receiving
      // (Opposite of initiator: initiator uses c1 to send, c2 to receive.
      //  Responder uses c2 to send, c1 to receive.)
      const msg = concat(ephemeral.publicKey, encPayload);
      return {
        msg,
        result: {
          sendCipher: c2,
          recvCipher: c1,
          handshakeHash,
        },
      };
    },
  };
}
