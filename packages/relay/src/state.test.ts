import { describe, test, expect, beforeEach } from "bun:test";
import { RelayState } from "./state";
import type { SocketData } from "./state";

// Minimal mock for ServerWebSocket — only needs to be distinguishable by identity
function mockWs(overrides?: Partial<SocketData>): any {
  return {
    data: {
      role: "client" as const,
      accountId: "acc-1",
      permissions: "client" as const,
      keyHash: "hash",
      connectedAt: Date.now(),
      messageCount: 0,
      bytesIn: 0,
      bytesOut: 0,
      ...overrides,
    },
    send: () => {},
    close: () => {},
  };
}

describe("RelayState", () => {
  let state: RelayState;

  beforeEach(() => {
    state = new RelayState();
  });

  // --- Node Management ---

  describe("nodes", () => {
    test("registerNode and getNode", () => {
      const ws = mockWs({ role: "node" });
      state.registerNode("acc-1", "node-1", ws);
      const node = state.getNode("acc-1", "node-1");
      expect(node).not.toBeNull();
      expect(node!.id).toBe("node-1");
      expect(node!.accountId).toBe("acc-1");
      expect(node!.activeRequests).toBe(0);
    });

    test("removeNode", () => {
      const ws = mockWs({ role: "node" });
      state.registerNode("acc-1", "node-1", ws);
      state.removeNode("acc-1", "node-1");
      expect(state.getNode("acc-1", "node-1")).toBeNull();
    });

    test("removeNode cleans up empty account map", () => {
      const ws = mockWs({ role: "node" });
      state.registerNode("acc-1", "node-1", ws);
      state.removeNode("acc-1", "node-1");
      expect(state.getNodeCount("acc-1")).toBe(0);
    });

    test("getNodeCount", () => {
      state.registerNode("acc-1", "node-1", mockWs());
      state.registerNode("acc-1", "node-2", mockWs());
      expect(state.getNodeCount("acc-1")).toBe(2);
      expect(state.getNodeCount("acc-2")).toBe(0);
    });

    test("pickNode returns least-loaded node", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      state.registerNode("acc-1", "node-1", ws1);
      state.registerNode("acc-1", "node-2", ws2);

      // Simulate load on node-1
      const node1 = state.getNode("acc-1", "node-1")!;
      node1.activeRequests = 5;

      const picked = state.pickNode("acc-1");
      expect(picked).not.toBeNull();
      expect(picked!.id).toBe("node-2");
    });

    test("pickNode with requested node", () => {
      state.registerNode("acc-1", "node-1", mockWs());
      state.registerNode("acc-1", "node-2", mockWs());

      const picked = state.pickNode("acc-1", "node-2");
      expect(picked!.id).toBe("node-2");
    });

    test("pickNode returns null for unknown account", () => {
      expect(state.pickNode("unknown")).toBeNull();
    });

    test("pickNode returns null for unknown requested node", () => {
      state.registerNode("acc-1", "node-1", mockWs());
      expect(state.pickNode("acc-1", "nonexistent")).toBeNull();
    });
  });

  // --- Client Management ---

  describe("clients", () => {
    test("addClient and getClientCount", () => {
      const ws = mockWs();
      state.addClient("acc-1", ws);
      expect(state.getClientCount("acc-1")).toBe(1);
    });

    test("removeClient", () => {
      const ws = mockWs();
      state.addClient("acc-1", ws);
      state.removeClient("acc-1", ws);
      expect(state.getClientCount("acc-1")).toBe(0);
    });

    test("multiple clients per account", () => {
      state.addClient("acc-1", mockWs());
      state.addClient("acc-1", mockWs());
      expect(state.getClientCount("acc-1")).toBe(2);
    });

    test("removeClient cleans up empty account set", () => {
      const ws = mockWs();
      state.addClient("acc-1", ws);
      state.removeClient("acc-1", ws);
      // Second remove is safe
      state.removeClient("acc-1", ws);
      expect(state.getClientCount("acc-1")).toBe(0);
    });
  });

  // --- Request Tracking ---

  describe("requests", () => {
    test("trackRequest and resolveRequest", () => {
      const clientWs = mockWs();
      state.registerNode("acc-1", "node-1", mockWs());

      state.trackRequest("acc-1", "req-1", {
        client: clientWs,
        nodeId: "node-1",
        accountId: "acc-1",
        method: "test",
        bytesIn: 100,
        startedAt: Date.now(),
      });

      const node = state.getNode("acc-1", "node-1")!;
      expect(node.activeRequests).toBe(1);

      const pr = state.resolveRequest("acc-1", "req-1");
      expect(pr).not.toBeNull();
      expect(pr!.method).toBe("test");
      expect(node.activeRequests).toBe(0);
    });

    test("resolveRequest returns null for unknown request", () => {
      expect(state.resolveRequest("acc-1", "unknown")).toBeNull();
    });

    test("failRequestsForNode removes all pending for that node", () => {
      const clientWs = mockWs();
      state.registerNode("acc-1", "node-1", mockWs());

      state.trackRequest("acc-1", "req-1", {
        client: clientWs, nodeId: "node-1", accountId: "acc-1",
        method: "a", bytesIn: 10, startedAt: Date.now(),
      });
      state.trackRequest("acc-1", "req-2", {
        client: clientWs, nodeId: "node-1", accountId: "acc-1",
        method: "b", bytesIn: 20, startedAt: Date.now(),
      });

      const failed = state.failRequestsForNode("acc-1", "node-1");
      expect(failed.length).toBe(2);

      // Resolve should return null now
      expect(state.resolveRequest("acc-1", "req-1")).toBeNull();
    });

    test("failRequestsForClient removes all pending for that client", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      state.registerNode("acc-1", "node-1", mockWs());

      state.trackRequest("acc-1", "req-1", {
        client: ws1, nodeId: "node-1", accountId: "acc-1",
        method: "a", bytesIn: 10, startedAt: Date.now(),
      });
      state.trackRequest("acc-1", "req-2", {
        client: ws2, nodeId: "node-1", accountId: "acc-1",
        method: "b", bytesIn: 20, startedAt: Date.now(),
      });

      const removed = state.failRequestsForClient(ws1);
      expect(removed.length).toBe(1);

      // ws2's request should still exist
      expect(state.resolveRequest("acc-1", "req-2")).not.toBeNull();
    });

    test("failRequestsForClient decrements node activeRequests", () => {
      const ws = mockWs();
      state.registerNode("acc-1", "node-1", mockWs());

      state.trackRequest("acc-1", "req-1", {
        client: ws, nodeId: "node-1", accountId: "acc-1",
        method: "a", bytesIn: 10, startedAt: Date.now(),
      });

      const node = state.getNode("acc-1", "node-1")!;
      expect(node.activeRequests).toBe(1);

      state.failRequestsForClient(ws);
      expect(node.activeRequests).toBe(0);
    });
  });

  // --- Stats ---

  describe("stats", () => {
    test("getAccountStats", () => {
      state.registerNode("acc-1", "node-1", mockWs());
      state.addClient("acc-1", mockWs());
      state.addClient("acc-1", mockWs());

      const stats = state.getAccountStats("acc-1");
      expect(stats.nodes).toBe(1);
      expect(stats.clients).toBe(2);
      expect(stats.pending).toBe(0);
    });

    test("getGlobalStats", () => {
      state.registerNode("acc-1", "node-1", mockWs());
      state.registerNode("acc-2", "node-2", mockWs());
      state.addClient("acc-1", mockWs());

      const stats = state.getGlobalStats();
      expect(stats.totalNodes).toBe(2);
      expect(stats.totalClients).toBe(1);
      expect(stats.totalPending).toBe(0);
      expect(stats.accounts).toBe(2);
    });

    test("getAccountNodes", () => {
      state.registerNode("acc-1", "node-1", mockWs());
      state.registerNode("acc-1", "node-2", mockWs());

      const nodes = state.getAccountNodes("acc-1");
      expect(nodes.length).toBe(2);
      expect(nodes[0].id).toBe("node-1");
      expect(nodes[0].activeRequests).toBe(0);
    });

    test("getAccountNodes returns empty for unknown account", () => {
      expect(state.getAccountNodes("unknown")).toEqual([]);
    });
  });
});
