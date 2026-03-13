/**
 * E2E encryption for orka CLI ↔ daemon communication.
 *
 * Current implementation uses Noise_NK transport protocol:
 *   - Noise NK pattern with X25519 + ChaCha20-Poly1305 + SHA-256
 *   - Full handshake establishes a secure channel with forward secrecy per session
 *   - Entire JSON-RPC messages are encrypted (not just params/result)
 *   - Keys stored at ~/.orka/keys/ as raw 32-byte X25519 keys (base64url)
 *
 * Legacy support:
 *   - Old X25519 ECDH + AES-256-GCM encryption is still supported for backward
 *     compatibility during the transition period. Old keys are DER-encoded.
 *   - Server detects the protocol from the first WS message:
 *     - {"t":"client_hello",...} → Noise NK path
 *     - JSON-RPC with _enc field → legacy path
 *
 * Key management:
 *   - Raw 32-byte X25519 keys (base64url) for Noise transport
 *   - key_id = "sha256:" + hex(SHA-256(publicKey)) for server identity verification
 *   - Server exposes publicKey and keyId via /health endpoint
 */

import {
  generateKeyPairSync,
  diffieHellman,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createPublicKey,
  createPrivateKey,
  hkdf,
} from "node:crypto";

// --- Key Generation ---

export interface KeyPair {
  publicKey: string;   // base64-encoded raw public key
  privateKey: string;  // base64-encoded raw private key
}

/**
 * Generate a legacy DER-encoded X25519 keypair.
 * @deprecated Use generateNoiseKeyPair() for new Noise transport keys.
 */
export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return {
    publicKey: Buffer.from(publicKey).toString("base64"),
    privateKey: Buffer.from(privateKey).toString("base64"),
  };
}

// --- Shared Secret Derivation ---

function deriveSharedSecret(myPrivateKeyB64: string, theirPublicKeyB64: string): Buffer {
  const myPrivateKey = createPrivateKey({
    key: Buffer.from(myPrivateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const theirPublicKey = createPublicKey({
    key: Buffer.from(theirPublicKeyB64, "base64"),
    format: "der",
    type: "spki",
  });
  return diffieHellman({
    privateKey: myPrivateKey,
    publicKey: theirPublicKey,
  });
}

/**
 * Derive an AES-256 encryption key from the ECDH shared secret using HKDF.
 * @deprecated Used by legacy encryption path only.
 */
export function deriveSessionKey(
  myPrivateKey: string,
  theirPublicKey: string,
  sessionSalt?: string,
): Promise<Buffer> {
  const sharedSecret = deriveSharedSecret(myPrivateKey, theirPublicKey);
  const salt = sessionSalt ? Buffer.from(sessionSalt, "base64") : randomBytes(32);

  return new Promise((resolve, reject) => {
    hkdf("sha256", sharedSecret, salt, Buffer.from("orka-e2e-v1"), 32, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(Buffer.from(derivedKey));
    });
  });
}

// --- Encryption / Decryption ---

export interface EncryptedPayload {
  /** Cipher algorithm identifier */
  c: "aes-256-gcm";
  /** Initialization vector (base64) */
  iv: string;
  /** Ciphertext (base64) */
  ct: string;
  /** Authentication tag (base64) */
  tag: string;
}

export function encrypt(key: Buffer, plaintext: string): EncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    c: "aes-256-gcm",
    iv: iv.toString("base64"),
    ct: encrypted.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decrypt(key: Buffer, payload: EncryptedPayload): string {
  if (payload.c !== "aes-256-gcm") {
    throw new Error(`Unsupported cipher: ${payload.c}`);
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ct, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf-8");
}

// --- Encrypted Envelope (legacy) ---

/**
 * Encrypt a JSON-RPC request's params field in-place.
 * The envelope (jsonrpc, id, method, node, traceparent) stays plaintext for relay routing.
 * @deprecated Used by legacy encryption path only. Noise transport encrypts entire messages.
 */
export function encryptRequest(key: Buffer, request: any): any {
  if (!request.params) return request;
  const paramsJson = JSON.stringify(request.params);
  return {
    ...request,
    params: undefined,
    _enc: encrypt(key, paramsJson),
  };
}

/**
 * Decrypt a JSON-RPC request's params from _enc field.
 * @deprecated Used by legacy encryption path only.
 */
export function decryptRequest(key: Buffer, request: any): any {
  if (!request._enc) return request;
  const paramsJson = decrypt(key, request._enc);
  return {
    ...request,
    params: JSON.parse(paramsJson),
    _enc: undefined,
  };
}

/**
 * Encrypt a JSON-RPC response's result (or error.data) field.
 * @deprecated Used by legacy encryption path only.
 */
export function encryptResponse(key: Buffer, response: any): any {
  if (response.result !== undefined) {
    const resultJson = JSON.stringify(response.result);
    return {
      ...response,
      result: undefined,
      _enc: encrypt(key, resultJson),
    };
  }
  return response; // Don't encrypt error messages — they're non-sensitive
}

/**
 * Decrypt a JSON-RPC response's result from _enc field.
 * @deprecated Used by legacy encryption path only.
 */
export function decryptResponse(key: Buffer, response: any): any {
  if (!response._enc) return response;
  const resultJson = decrypt(key, response._enc);
  return {
    ...response,
    result: JSON.parse(resultJson),
    _enc: undefined,
  };
}

// --- Key File Management ---

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const KEYS_DIR = "keys";

export function getKeysDir(orkaHome: string): string {
  const dir = join(orkaHome, KEYS_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveKeyPair(orkaHome: string, name: string, kp: KeyPair): void {
  const dir = getKeysDir(orkaHome);
  writeFileSync(join(dir, `${name}.pub`), kp.publicKey, { mode: 0o644 });
  writeFileSync(join(dir, `${name}.key`), kp.privateKey, { mode: 0o600 });
}

export function loadKeyPair(orkaHome: string, name: string): KeyPair | null {
  const dir = getKeysDir(orkaHome);
  const pubPath = join(dir, `${name}.pub`);
  const keyPath = join(dir, `${name}.key`);
  if (!existsSync(pubPath) || !existsSync(keyPath)) return null;
  return {
    publicKey: readFileSync(pubPath, "utf-8").trim(),
    privateKey: readFileSync(keyPath, "utf-8").trim(),
  };
}

export function loadPublicKey(orkaHome: string, name: string): string | null {
  const dir = getKeysDir(orkaHome);
  const pubPath = join(dir, `${name}.pub`);
  if (!existsSync(pubPath)) return null;
  return readFileSync(pubPath, "utf-8").trim();
}

/**
 * Ensure a keypair exists for the given identity name.
 * Generates one if it doesn't exist. Returns the keypair.
 * @deprecated Use ensureNoiseKeyPair() for Noise transport keys.
 */
export function ensureKeyPair(orkaHome: string, name: string): KeyPair {
  const existing = loadKeyPair(orkaHome, name);
  if (existing) return existing;
  const kp = generateKeyPair();
  saveKeyPair(orkaHome, name, kp);
  return kp;
}

// --- Noise Transport Key Management ---
// Raw 32-byte X25519 keys stored as base64url, compatible with @noble/curves.
// Key files use ".noise.pub" and ".noise.key" suffixes to coexist with legacy keys.

import { generateX25519KeyPair } from "./crypto/noise";
import { computeKeyId } from "./transport/noise-transport";

export interface NoiseKeyInfo {
  /** Raw 32-byte public key as Uint8Array */
  publicKey: Uint8Array;
  /** Raw 32-byte private key as Uint8Array */
  privateKey: Uint8Array;
  /** key_id = "sha256:" + hex(SHA-256(publicKey)) */
  keyId: string;
  /** base64url-encoded public key (for storage/display) */
  publicKeyB64: string;
}

/**
 * Generate a new raw X25519 keypair for Noise transport.
 */
export function generateNoiseKeyPair(): NoiseKeyInfo {
  const kp = generateX25519KeyPair();
  return {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    keyId: computeKeyId(kp.publicKey),
    publicKeyB64: Buffer.from(kp.publicKey).toString("base64url"),
  };
}

/**
 * Save a Noise keypair to disk.
 * Files: <name>.noise.pub (base64url public key) and <name>.noise.key (base64url private key).
 */
export function saveNoiseKeyPair(orkaHome: string, name: string, info: NoiseKeyInfo): void {
  const dir = getKeysDir(orkaHome);
  const pubB64 = Buffer.from(info.publicKey).toString("base64url");
  const privB64 = Buffer.from(info.privateKey).toString("base64url");
  writeFileSync(join(dir, `${name}.noise.pub`), pubB64, { mode: 0o644 });
  writeFileSync(join(dir, `${name}.noise.key`), privB64, { mode: 0o600 });
}

/**
 * Load a Noise keypair from disk.
 */
export function loadNoiseKeyPair(orkaHome: string, name: string): NoiseKeyInfo | null {
  const dir = getKeysDir(orkaHome);
  const pubPath = join(dir, `${name}.noise.pub`);
  const keyPath = join(dir, `${name}.noise.key`);
  if (!existsSync(pubPath) || !existsSync(keyPath)) return null;
  const pubB64 = readFileSync(pubPath, "utf-8").trim();
  const privB64 = readFileSync(keyPath, "utf-8").trim();
  const publicKey = new Uint8Array(Buffer.from(pubB64, "base64url"));
  const privateKey = new Uint8Array(Buffer.from(privB64, "base64url"));
  return {
    publicKey,
    privateKey,
    keyId: computeKeyId(publicKey),
    publicKeyB64: pubB64,
  };
}

/**
 * Load just the Noise public key from disk (e.g. for saved server key).
 */
export function loadNoisePublicKey(orkaHome: string, name: string): NoiseKeyInfo | null {
  const dir = getKeysDir(orkaHome);
  const pubPath = join(dir, `${name}.noise.pub`);
  if (!existsSync(pubPath)) return null;
  const pubB64 = readFileSync(pubPath, "utf-8").trim();
  const publicKey = new Uint8Array(Buffer.from(pubB64, "base64url"));
  return {
    publicKey,
    privateKey: new Uint8Array(0), // not available for public-key-only loads
    keyId: computeKeyId(publicKey),
    publicKeyB64: pubB64,
  };
}

/**
 * Ensure a Noise keypair exists for the given identity name.
 * Generates one if it doesn't exist. Returns the key info.
 */
export function ensureNoiseKeyPair(orkaHome: string, name: string): NoiseKeyInfo {
  const existing = loadNoiseKeyPair(orkaHome, name);
  if (existing) return existing;
  const info = generateNoiseKeyPair();
  saveNoiseKeyPair(orkaHome, name, info);
  return info;
}

/**
 * Save a remote server's Noise public key for later use.
 */
export function saveNoiseServerPublicKey(orkaHome: string, pubB64: string): void {
  const dir = getKeysDir(orkaHome);
  writeFileSync(join(dir, "server.noise.pub"), pubB64, { mode: 0o644 });
}
