import { describe, test, expect, beforeEach } from "bun:test";
import { RelayState } from "./state";
import type { SocketData } from "./state";
import type { ServerWebSocket } from "bun";

// Minimal mock for ServerWebSocket — only needs to be distinguishable by identity
function mockWs(overrides?: Partial<SocketData>): ServerWebSocket<SocketData> {
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
  } as unknown as ServerWebSocket<SocketData>;
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
      if (!node) throw new Error("expected node");
      expect(node.id).toBe("node-1");
      expect(node.accountId).toBe("acc-1");
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

  // --- Transport Bindings ---

  describe("transport bindings", () => {
    test("bindTransportClient and getTransportBinding", () => {
      const ws = mockWs();
      state.registerNode("acc-1", "node-1", mockWs());
      const relayCid = state.bindTransportClient(ws, "acc-1", "node-1");
      expect(typeof relayCid).toBe("string");

      const binding = state.getTransportBinding(ws);
      expect(binding).not.toBeNull();
      if (!binding) throw new Error("expected binding");
      expect(binding.nodeId).toBe("node-1");
      expect(binding.relayCid).toBe(relayCid);
      expect(binding.accountId).toBe("acc-1");
    });

    test("getTransportClientWs reverse lookup", () => {
      const ws = mockWs();
      state.registerNode("acc-1", "node-1", mockWs());
      const relayCid = state.bindTransportClient(ws, "acc-1", "node-1");

      const found = state.getTransportClientWs("acc-1", relayCid);
      expect(found).toBe(ws);
    });

    test("removeTransportClient", () => {
      const ws = mockWs();
      state.registerNode("acc-1", "node-1", mockWs());
      const relayCid = state.bindTransportClient(ws, "acc-1", "node-1");

      state.removeTransportClient(ws);
      expect(state.getTransportBinding(ws)).toBeNull();
      expect(state.getTransportClientWs("acc-1", relayCid)).toBeNull();
    });

    test("getTransportClientsForNode", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      state.registerNode("acc-1", "node-1", mockWs());
      state.bindTransportClient(ws1, "acc-1", "node-1");
      state.bindTransportClient(ws2, "acc-1", "node-1");

      const clients = state.getTransportClientsForNode("acc-1", "node-1");
      expect(clients.length).toBe(2);
    });

    test("getTransportBindingCount", () => {
      const ws = mockWs();
      state.registerNode("acc-1", "node-1", mockWs());
      expect(state.getTransportBindingCount()).toBe(0);
      state.bindTransportClient(ws, "acc-1", "node-1");
      expect(state.getTransportBindingCount()).toBe(1);
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
      expect(stats.transportBindings).toBe(0);
    });

    test("getGlobalStats", () => {
      state.registerNode("acc-1", "node-1", mockWs());
      state.registerNode("acc-2", "node-2", mockWs());
      state.addClient("acc-1", mockWs());

      const stats = state.getGlobalStats();
      expect(stats.totalNodes).toBe(2);
      expect(stats.totalClients).toBe(1);
      expect(stats.totalTransportBindings).toBe(0);
      expect(stats.accounts).toBe(2);
    });

    test("getAccountNodes", () => {
      state.registerNode("acc-1", "node-1", mockWs());
      state.registerNode("acc-1", "node-2", mockWs());

      const nodes = state.getAccountNodes("acc-1");
      expect(nodes.length).toBe(2);
      expect(nodes[0]?.id).toBe("node-1");
    });

    test("getAccountNodes returns empty for unknown account", () => {
      expect(state.getAccountNodes("unknown")).toEqual([]);
    });
  });
});
