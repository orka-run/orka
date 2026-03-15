import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadKnownHosts, saveKnownHost, lookupKnownHost } from "./known-hosts";

describe("known-hosts", () => {
  let orkaHome: string;

  beforeEach(() => {
    orkaHome = join(tmpdir(), `orka-test-known-hosts-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(orkaHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(orkaHome, { recursive: true, force: true });
  });

  const fakeKey = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
  const fakeKey2 = new Uint8Array([32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);

  test("loadKnownHosts returns empty map when file does not exist", () => {
    const hosts = loadKnownHosts(orkaHome);
    expect(hosts.size).toBe(0);
  });

  test("saveKnownHost creates file and lookupKnownHost finds it", () => {
    saveKnownHost(orkaHome, "127.0.0.1:7394", "sha256:abc123", fakeKey);

    const entry = lookupKnownHost(orkaHome, "127.0.0.1:7394");
    expect(entry).not.toBeNull();
    expect(entry!.keyId).toBe("sha256:abc123");
    expect(entry!.publicKey).toEqual(fakeKey);
  });

  test("lookupKnownHost returns null for unknown host", () => {
    saveKnownHost(orkaHome, "127.0.0.1:7394", "sha256:abc123", fakeKey);

    const entry = lookupKnownHost(orkaHome, "192.168.1.1:7394");
    expect(entry).toBeNull();
  });

  test("loadKnownHosts loads all entries", () => {
    saveKnownHost(orkaHome, "host1:7394", "sha256:aaa", fakeKey);
    saveKnownHost(orkaHome, "host2:7394", "sha256:bbb", fakeKey2);

    const hosts = loadKnownHosts(orkaHome);
    expect(hosts.size).toBe(2);
    expect(hosts.get("host1:7394")!.keyId).toBe("sha256:aaa");
    expect(hosts.get("host2:7394")!.keyId).toBe("sha256:bbb");
  });

  test("saveKnownHost replaces existing entry for same host", () => {
    saveKnownHost(orkaHome, "127.0.0.1:7394", "sha256:old", fakeKey);
    saveKnownHost(orkaHome, "127.0.0.1:7394", "sha256:new", fakeKey2);

    const entry = lookupKnownHost(orkaHome, "127.0.0.1:7394");
    expect(entry).not.toBeNull();
    expect(entry!.keyId).toBe("sha256:new");
    expect(entry!.publicKey).toEqual(fakeKey2);

    // Should have only one entry for this host
    const hosts = loadKnownHosts(orkaHome);
    expect(hosts.size).toBe(1);
  });

  test("file is human-readable with comments", () => {
    saveKnownHost(orkaHome, "127.0.0.1:7394", "sha256:abc123", fakeKey);

    const content = readFileSync(join(orkaHome, "known_hosts"), "utf-8");
    expect(content).toContain("# orka known_hosts");
    expect(content).toContain("127.0.0.1:7394");
    expect(content).toContain("sha256:abc123");
  });

  test("ignores comment lines and blank lines", () => {
    // Manually write a file with comments and blank lines
    const filePath = join(orkaHome, "known_hosts");
    const pubB64 = Buffer.from(fakeKey).toString("base64url");
    const content = `# This is a comment\n\n# Another comment\nhost1:7394 sha256:aaa ${pubB64}\n\n`;
    require("node:fs").writeFileSync(filePath, content);

    const hosts = loadKnownHosts(orkaHome);
    expect(hosts.size).toBe(1);
    expect(hosts.get("host1:7394")!.keyId).toBe("sha256:aaa");
  });

  test("file has restrictive permissions (0o600)", () => {
    saveKnownHost(orkaHome, "127.0.0.1:7394", "sha256:abc123", fakeKey);

    const filePath = join(orkaHome, "known_hosts");
    const stats = require("node:fs").statSync(filePath);
    // 0o600 = owner read/write only
    expect(stats.mode & 0o777).toBe(0o600);
  });

  test("preserves other entries when replacing one", () => {
    saveKnownHost(orkaHome, "host1:7394", "sha256:aaa", fakeKey);
    saveKnownHost(orkaHome, "host2:7394", "sha256:bbb", fakeKey2);
    // Now replace host1
    saveKnownHost(orkaHome, "host1:7394", "sha256:ccc", fakeKey2);

    const hosts = loadKnownHosts(orkaHome);
    expect(hosts.size).toBe(2);
    expect(hosts.get("host1:7394")!.keyId).toBe("sha256:ccc");
    expect(hosts.get("host2:7394")!.keyId).toBe("sha256:bbb");
  });
});
