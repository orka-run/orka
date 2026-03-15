/**
 * LocalStorage-backed Noise key storage for the dashboard.
 * Persists paired node public keys across browser sessions.
 */

export interface StoredNoiseKey {
  /** hex-encoded 32-byte public key */
  publicKey: string;
  /** key_id = "sha256:" + hex(SHA-256(publicKey)) */
  keyId: string;
}

const STORAGE_KEY = "orka-noise-keys";

export function saveNoiseKey(nodeId: string, key: StoredNoiseKey): void {
  const keys = loadAllNoiseKeys();
  keys[nodeId] = key;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
}

export function loadNoiseKey(nodeId: string): StoredNoiseKey | null {
  const keys = loadAllNoiseKeys();
  return keys[nodeId] ?? null;
}

export function loadAllNoiseKeys(): Record<string, StoredNoiseKey> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, StoredNoiseKey>;
  } catch {
    return {};
  }
}

export function removeNoiseKey(nodeId: string): void {
  const keys = loadAllNoiseKeys();
  delete keys[nodeId];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
}

/** Convert a stored hex key to a Uint8Array suitable for NoiseKeyInfo.publicKey */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
