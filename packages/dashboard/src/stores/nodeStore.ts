import type { NodeInfo } from "@orka/core";
import { create } from "zustand";
import type { WsTransport } from "../lib/wsTransport";

export interface NodeState {
  nodes: NodeInfo[];
  selectedNodeId: string | null; // null = "all nodes"
  isLoading: boolean;
  fetchNodes: (transport: WsTransport) => Promise<void>;
  selectNode: (nodeId: string | null) => void;
}

export const useNodeStore = create<NodeState>((set) => ({
  nodes: [],
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

  selectNode: (nodeId) => {
    set({ selectedNodeId: nodeId });
  },
}));
