import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNodeRegistry } from "./node-registry";
import type { StoredNode } from "@orka/core";

function makeNode(overrides: Partial<StoredNode> = {}): StoredNode {
  return {
    nodeId: "node-abc123",
    nodeName: "My Workstation",
    relayUrl: "wss://relay.example.com",
    nodePaths: ["/project-a", "/project-b"],
    pairedAt: "2026-03-15T10:00:00Z",
    noiseStaticPubkey: "dGVzdC1wdWJsaWMta2V5LTMyLWJ5dGVzLXBhZA",
    noiseKeyId: "sha256:abc123",
    autoConnect: true,
    ...overrides,
  };
}

describe("node-registry", () => {
  function setup() {
    const testHome = mkdtempSync(join(tmpdir(), "orka-node-registry-test-"));
    const registry = createNodeRegistry(testHome);
    return { testHome, registry };
  }

  function cleanup(testHome: string) {
    rmSync(testHome, { recursive: true, force: true });
  }

  test("save and load round-trip", () => {
    const { testHome, registry } = setup();
    try {
      const node = makeNode();
      registry.save(node);
      const loaded = registry.load("node-abc123");
      expect(loaded).toEqual(node);
    } finally {
      cleanup(testHome);
    }
  });

  test("save with optional relayToken", () => {
    const { testHome, registry } = setup();
    try {
      const node = makeNode({ relayToken: "secret-token" });
      registry.save(node);
      const loaded = registry.load("node-abc123");
      expect(loaded).toEqual(node);
      expect(loaded!.relayToken).toBe("secret-token");
    } finally {
      cleanup(testHome);
    }
  });

  test("load returns null for nonexistent node", () => {
    const { testHome, registry } = setup();
    try {
      expect(registry.load("nonexistent")).toBeNull();
    } finally {
      cleanup(testHome);
    }
  });

  test("loadAll returns all saved nodes", () => {
    const { testHome, registry } = setup();
    try {
      const node1 = makeNode({ nodeId: "node-001", nodeName: "Node 1" });
      const node2 = makeNode({ nodeId: "node-002", nodeName: "Node 2" });
      const node3 = makeNode({ nodeId: "node-003", nodeName: "Node 3" });
      registry.save(node1);
      registry.save(node2);
      registry.save(node3);

      const all = registry.loadAll();
      expect(all).toHaveLength(3);
      const ids = all.map((n) => n.nodeId).sort();
      expect(ids).toEqual(["node-001", "node-002", "node-003"]);
    } finally {
      cleanup(testHome);
    }
  });

  test("loadAll returns empty array when no nodes exist", () => {
    const { testHome, registry } = setup();
    try {
      expect(registry.loadAll()).toEqual([]);
    } finally {
      cleanup(testHome);
    }
  });

  test("remove deletes node", () => {
    const { testHome, registry } = setup();
    try {
      const node = makeNode();
      registry.save(node);
      expect(registry.load("node-abc123")).not.toBeNull();

      registry.remove("node-abc123");
      expect(registry.load("node-abc123")).toBeNull();
    } finally {
      cleanup(testHome);
    }
  });

  test("remove nonexistent node doesn't throw", () => {
    const { testHome, registry } = setup();
    try {
      expect(() => registry.remove("nonexistent")).not.toThrow();
    } finally {
      cleanup(testHome);
    }
  });

  test("save overwrites existing node", () => {
    const { testHome, registry } = setup();
    try {
      const node = makeNode();
      registry.save(node);

      const updated = makeNode({ nodeName: "Updated Name", autoConnect: false });
      registry.save(updated);

      const loaded = registry.load("node-abc123");
      expect(loaded!.nodeName).toBe("Updated Name");
      expect(loaded!.autoConnect).toBe(false);
    } finally {
      cleanup(testHome);
    }
  });
});
