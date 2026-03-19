/**
 * TOFU (Trust On First Use) key pinning store for Noise server keys.
 *
 * Stores known host keys in ~/.orka/known_hosts, similar to SSH's known_hosts.
 * Format: one entry per line — "hostname key_id public_key_base64"
 * Lines starting with # are comments.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KNOWN_HOSTS_FILE = "known_hosts";

export interface KnownHostEntry {
  keyId: string;
  publicKey: Uint8Array;
  publicKeyB64: string;
}

function knownHostsPath(orkaHome: string): string {
  return join(orkaHome, KNOWN_HOSTS_FILE);
}

/**
 * Load all known hosts from ~/.orka/known_hosts.
 */
export function loadKnownHosts(orkaHome: string): Map<string, KnownHostEntry> {
  const filePath = knownHostsPath(orkaHome);
  const result = new Map<string, KnownHostEntry>();
  if (!existsSync(filePath)) return result;

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    console.error(`[tofu] failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;

    const host = parts[0];
    const keyId = parts[1];
    const pubKeyB64 = parts[2];
    if (!host || !keyId || !pubKeyB64) continue;
    const publicKey = new Uint8Array(Buffer.from(pubKeyB64, "base64url"));
    result.set(host, { keyId, publicKey, publicKeyB64: pubKeyB64 });
  }
  return result;
}

/**
 * Save a new known host entry (appends to file).
 */
export function saveKnownHost(
  orkaHome: string,
  host: string,
  keyId: string,
  publicKey: Uint8Array,
): void {
  const filePath = knownHostsPath(orkaHome);
  const pubKeyB64 = Buffer.from(publicKey).toString("base64url");
  const line = `${host} ${keyId} ${pubKeyB64}\n`;

  try {
    if (!existsSync(filePath)) {
      writeFileSync(filePath, `# orka known_hosts — TOFU key pinning\n${line}`, { mode: 0o600 });
    } else {
      // Remove any existing entry for this host before appending
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      const filtered = lines.filter((l) => {
        const trimmed = l.trim();
        if (!trimmed || trimmed.startsWith("#")) return true;
        const parts = trimmed.split(/\s+/);
        return parts[0] !== host;
      });
      // Remove trailing empty lines, then append new entry
      while (filtered.length > 0 && filtered[filtered.length - 1] === "") {
        filtered.pop();
      }
      filtered.push(line);
      writeFileSync(filePath, filtered.join("\n"), { mode: 0o600 });
    }
  } catch (err) {
    console.error(`[tofu] failed to save known host ${host}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Look up a single host in known_hosts.
 */
export function lookupKnownHost(orkaHome: string, host: string): KnownHostEntry | null {
  const filePath = knownHostsPath(orkaHome);
  if (!existsSync(filePath)) return null;

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    console.error(`[tofu] failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;

    const h = parts[0];
    const keyId = parts[1];
    const pubKeyB64 = parts[2];
    if (!h || !keyId || !pubKeyB64) continue;
    if (h === host) {
      const publicKey = new Uint8Array(Buffer.from(pubKeyB64, "base64url"));
      return { keyId, publicKey, publicKeyB64: pubKeyB64 };
    }
  }
  return null;
}
