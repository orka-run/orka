/**
 * E2E encryption for orka CLI ↔ daemon communication.
 *
 * Design:
 *   - X25519 ECDH key exchange for shared secret derivation
 *   - AES-256-GCM for symmetric encryption of JSON-RPC params/result
 *   - Envelope fields (jsonrpc, id, method, node) remain plaintext for relay routing
 *   - Only `params` (request) and `result`/`error.data` (response) are encrypted
 *   - Perfect forward secrecy via ephemeral session keys
 *   - User-owned keys — relay operator has zero access to payload content
 *
 * Key management:
 *   - User generates a persistent identity keypair (stored in ~/.orka/keys/)
 *   - Daemon node has its own keypair
 *   - Public keys exchanged out-of-band (config) or via relay (relay sees only pubkeys)
 *   - Each WS session derives ephemeral shared secret from ECDH
 *
 * Post-quantum readiness:
 *   - Current: X25519 + AES-256-GCM (standard, fast, well-supported)
 *   - Future: Hybrid X25519+Kyber768 when liboqs/mlkem bindings are stable in Bun
 *   - The encrypted envelope format includes a `cipher` field for algorithm negotiation
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
 * The salt ensures different sessions with the same keypairs produce different keys.
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

// --- Encrypted Envelope ---

/**
 * Encrypt a JSON-RPC request's params field in-place.
 * The envelope (jsonrpc, id, method, node) stays plaintext for relay routing.
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
 */
export function ensureKeyPair(orkaHome: string, name: string): KeyPair {
  const existing = loadKeyPair(orkaHome, name);
  if (existing) return existing;
  const kp = generateKeyPair();
  saveKeyPair(orkaHome, name, kp);
  return kp;
}
