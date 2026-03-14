/**
 * E2E encryption for orka CLI ↔ daemon communication.
 *
 * Uses Noise_NK transport protocol:
 *   - Noise NK pattern with X25519 + ChaCha20-Poly1305 + SHA-256
 *   - Full handshake establishes a secure channel with forward secrecy per session
 *   - Entire JSON-RPC messages are encrypted (not just params/result)
 *   - Keys stored at ~/.orka/keys/ as raw 32-byte X25519 keys (base64url)
 *
 * Key management:
 *   - Raw 32-byte X25519 keys (base64url) for Noise transport
 *   - key_id = "sha256:" + hex(SHA-256(publicKey)) for server identity verification
 *   - Server exposes publicKey and keyId via /health endpoint
 */

// --- Key File Management ---

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const KEYS_DIR = "keys";

export function getKeysDir(orkaHome: string): string {
  const dir = join(orkaHome, KEYS_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// --- Noise Transport Key Management ---
// Raw 32-byte X25519 keys stored as base64url, compatible with @noble/curves.
// Key files use ".noise.pub" and ".noise.key" suffixes.

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
