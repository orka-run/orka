import { create } from "zustand";
import type { ProtocolMismatchInfo } from "../lib/wsTransport";

export interface ConnectionState {
  status: "connecting" | "connected" | "disconnected" | "reconnecting";
  reconnectAttempts: number;
  lastConnected: number | null;
  protocolMismatch: ProtocolMismatchInfo | null;
  setStatus: (status: ConnectionState["status"], reconnectAttempts?: number) => void;
  setProtocolMismatch: (info: ProtocolMismatchInfo) => void;
  clearProtocolMismatch: () => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: "disconnected",
  reconnectAttempts: 0,
  lastConnected: null,
  protocolMismatch: null,
  setStatus: (status, reconnectAttempts = status === "reconnecting" ? 1 : 0) =>
    set((state) => ({
      status,
      reconnectAttempts: status === "reconnecting" ? reconnectAttempts : 0,
      lastConnected: status === "connected" ? Date.now() : state.lastConnected,
    })),
  setProtocolMismatch: (info) => set({ protocolMismatch: info }),
  clearProtocolMismatch: () => set({ protocolMismatch: null }),
}));
