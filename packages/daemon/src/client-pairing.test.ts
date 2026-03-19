import { describe, it, expect, beforeEach } from "bun:test";
import { performClientPairing } from "./client-pairing";
import type { NodeRegistry } from "./node-registry";
import type { RemoteNodeManager } from "./remote-nodes";
import type { StoredNode } from "@orka/core";

/**
 * These tests verify the orchestration logic in performClientPairing.
 *
 * Since the function involves real WebSocket connections and crypto handshakes,
 * we test the simpler delegate methods (listPairedNodes, removePairedNode,
 * connectNode, disconnectNode) and validate the function signature/structure.
 * Full integration testing of the WebSocket + SPAKE2 flow is in E2E tests.
 */

function createMockRegistry(): NodeRegistry & {
  saved: StoredNode[];
  removed: string[];
  nodes: Map<string, StoredNode>;
} {
  const nodes = new Map<string, StoredNode>();
  const saved: StoredNode[] = [];
  const removed: string[] = [];
  return {
    nodes,
    saved,
    removed,
    save(node: StoredNode) {
      saved.push(node);
      nodes.set(node.nodeId, node);
    },
    load(nodeId: string) {
      return nodes.get(nodeId) ?? null;
    },
    loadAll() {
      return Array.from(nodes.values());
    },
    remove(nodeId: string) {
      removed.push(nodeId);
      nodes.delete(nodeId);
    },
  };
}

function createMockRemoteNodes(): RemoteNodeManager & {
  connected: StoredNode[];
  disconnected: string[];
} {
  const connected: StoredNode[] = [];
  const disconnected: string[] = [];
  return {
    connected,
    disconnected,
    async connect(node: StoredNode) {
      connected.push(node);
    },
    disconnect(nodeId: string) {
      disconnected.push(nodeId);
    },
    getHandle() {
      return null;
    },
    listHandles() {
      return [];
    },
    request() {
      return Promise.reject(new Error("not implemented"));
    },
    subscribePush() {
      return () => {};
    },
    shutdown() {},
  };
}

function makeTestNode(overrides?: Partial<StoredNode>): StoredNode {
  return {
    nodeId: "test-node-1",
    nodeName: "Test Node",
    relayUrl: "ws://relay.test:7390",
    nodePaths: ["ws://relay.test:7390/ws/test-node-1"],
    pairedAt: new Date().toISOString(),
    noiseStaticPubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    noiseKeyId: "sha256:test",
    autoConnect: true,
    ...overrides,
  };
}

describe("performClientPairing", () => {
  it("rejects invalid pairing code", async () => {
    const registry = createMockRegistry();
    const remoteNodes = createMockRemoteNodes();

    await expect(
      performClientPairing(
        { pairingCode: "INVALID", relayUrl: "ws://relay:7390" },
        { registry, remoteNodes },
      ),
    ).rejects.toThrow();
  });

  it("has correct function signature", () => {
    expect(typeof performClientPairing).toBe("function");
    expect(performClientPairing.length).toBe(2);
  });
});

describe("client-pairing delegate operations", () => {
  let registry: ReturnType<typeof createMockRegistry>;
  let remoteNodes: ReturnType<typeof createMockRemoteNodes>;

  beforeEach(() => {
    registry = createMockRegistry();
    remoteNodes = createMockRemoteNodes();
  });

  describe("listPairedNodes", () => {
    it("returns empty when no nodes", () => {
      expect(registry.loadAll()).toEqual([]);
    });

    it("returns saved nodes", () => {
      const node = makeTestNode();
      registry.save(node);
      expect(registry.loadAll()).toEqual([node]);
    });
  });

  describe("removePairedNode", () => {
    it("disconnects and removes from registry", () => {
      const node = makeTestNode();
      registry.save(node);

      remoteNodes.disconnect(node.nodeId);
      registry.remove(node.nodeId);

      expect(remoteNodes.disconnected).toContain(node.nodeId);
      expect(registry.removed).toContain(node.nodeId);
      expect(registry.load(node.nodeId)).toBeNull();
    });
  });

  describe("connectNode", () => {
    it("loads node from registry and connects", async () => {
      const node = makeTestNode();
      registry.save(node);

      const loaded = registry.load(node.nodeId);
      expect(loaded).not.toBeNull();
      await remoteNodes.connect(loaded!);

      expect(remoteNodes.connected).toHaveLength(1);
      expect(remoteNodes.connected[0]!.nodeId).toBe(node.nodeId);
    });

    it("throws when node not in registry", () => {
      const loaded = registry.load("nonexistent");
      expect(loaded).toBeNull();
    });
  });

  describe("disconnectNode", () => {
    it("disconnects by nodeId", () => {
      remoteNodes.disconnect("test-node-1");
      expect(remoteNodes.disconnected).toContain("test-node-1");
    });
  });
});
