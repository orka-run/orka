import type { NodeInfo, StoredNode } from "@orka/core";
import { create } from "zustand";
import type { WsTransport } from "../lib/wsTransport";

export interface PairedNodeInfo extends StoredNode {
  /** Live connection status from fleet.nodeUpdated push */
  connectionStatus?: "online" | "offline" | "error";
}

export interface NodeState {
  nodes: NodeInfo[];
  pairedNodes: PairedNodeInfo[];
  selectedNodeId: string | null; // null = "all nodes"
  isLoading: boolean;
  fetchNodes: (transport: WsTransport) => Promise<void>;
  fetchPairedNodes: (transport: WsTransport) => Promise<void>;
  selectNode: (nodeId: string | null) => void;
  removeNode: (transport: WsTransport, nodeId: string) => Promise<void>;
  connectNode: (transport: WsTransport, nodeId: string) => Promise<void>;
  disconnectNode: (transport: WsTransport, nodeId: string) => Promise<void>;
  updateNodeStatus: (nodeId: string, status: "online" | "offline" | "error") => void;
}

export const useNodeStore = create<NodeState>((set, get) => ({
  nodes: [],
  pairedNodes: [],
  selectedNodeId: null,
  isLoading: false,

  fetchNodes: async (transport) => {
    set({ isLoading: true });
    try {
      const nodes = await transport.request<NodeInfo[]>("listNodes");
      set({ nodes, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  fetchPairedNodes: async (transport) => {
    try {
      const stored = await transport.request<StoredNode[]>("listPairedNodes");
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

  removeNode: async (transport, nodeId) => {
    await transport.request("removePairedNode", { nodeId });
    set((state) => ({
      pairedNodes: state.pairedNodes.filter((n) => n.nodeId !== nodeId),
      nodes: state.nodes.filter((n) => n.id !== nodeId),
      selectedNodeId: state.selectedNodeId === nodeId ? null : state.selectedNodeId,
    }));
  },

  connectNode: async (transport, nodeId) => {
    await transport.request("connectNode", { nodeId });
  },

  disconnectNode: async (transport, nodeId) => {
    await transport.request("disconnectNode", { nodeId });
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
