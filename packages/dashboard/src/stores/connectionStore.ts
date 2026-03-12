import { create } from "zustand";

export interface ConnectionState {
  status: "connecting" | "connected" | "disconnected" | "reconnecting";
  reconnectAttempts: number;
  lastConnected: number | null;
  setStatus: (status: ConnectionState["status"], reconnectAttempts?: number) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: "disconnected",
  reconnectAttempts: 0,
  lastConnected: null,
  setStatus: (status, reconnectAttempts = status === "reconnecting" ? 1 : 0) =>
    set((state) => ({
      status,
      reconnectAttempts: status === "reconnecting" ? reconnectAttempts : 0,
      lastConnected: status === "connected" ? Date.now() : state.lastConnected,
    })),
}));
