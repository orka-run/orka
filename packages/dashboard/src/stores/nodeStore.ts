import type { NodeInfo, StoredNode } from "@orka/core";
import { create } from "zustand";
import type { RpcClient } from "../lib/rpcClient";

export interface PairedNodeInfo extends StoredNode {
  /** Live connection status from fleet.nodeUpdated push */
  connectionStatus?: "online" | "offline" | "error";
}

export interface NodeState {
  nodes: NodeInfo[];
  pairedNodes: PairedNodeInfo[];
  selectedNodeId: string | null; // null = "all nodes"
  isLoading: boolean;
  fetchNodes: (client: RpcClient) => Promise<void>;
  fetchPairedNodes: (client: RpcClient) => Promise<void>;
  selectNode: (nodeId: string | null) => void;
  removeNode: (client: RpcClient, nodeId: string) => Promise<void>;
  connectNode: (client: RpcClient, nodeId: string) => Promise<void>;
  disconnectNode: (client: RpcClient, nodeId: string) => Promise<void>;
  updateNodeStatus: (nodeId: string, status: "online" | "offline" | "error") => void;
}

export const useNodeStore = create<NodeState>((set, get) => ({
  nodes: [],
  pairedNodes: [],
  selectedNodeId: null,
  isLoading: false,

  fetchNodes: async (client) => {
    set({ isLoading: true });
    try {
      const nodes = await client.listNodes();
      set({ nodes, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  fetchPairedNodes: async (client) => {
    try {
      const stored = await client.listPairedNodes();
      // Preserve existing connectionStatus from current state
      const current = get().pairedNodes;
      const statusMap = new Map(current.map((n) => [n.nodeId, n.connectionStatus]));
      const pairedNodes: PairedNodeInfo[] = stored.map((n) => ({
        ...n,
        connectionStatus: statusMap.get(n.nodeId),
      }));
      set({ pairedNodes });
    } catch {
      // listPairedNodes may not be available (e.g. hosted mode)
    }
  },

  selectNode: (nodeId) => {
    set({ selectedNodeId: nodeId });
  },

  removeNode: async (client, nodeId) => {
    await client.removePairedNode(nodeId);
    set((state) => ({
      pairedNodes: state.pairedNodes.filter((n) => n.nodeId !== nodeId),
      nodes: state.nodes.filter((n) => n.id !== nodeId),
      selectedNodeId: state.selectedNodeId === nodeId ? null : state.selectedNodeId,
    }));
  },

  connectNode: async (client, nodeId) => {
    await client.connectNode(nodeId);
  },

  disconnectNode: async (client, nodeId) => {
    await client.disconnectNode(nodeId);
  },

  updateNodeStatus: (nodeId, status) => {
    set((state) => ({
      pairedNodes: state.pairedNodes.map((n) =>
        n.nodeId === nodeId ? { ...n, connectionStatus: status } : n,
      ),
      nodes: state.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, status: status === "online" ? "online" : "offline" }
          : n,
      ),
    }));
  },
}));
