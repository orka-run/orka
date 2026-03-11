import { create } from "zustand";

export interface ConnectionState {
  status: "connecting" | "connected" | "disconnected" | "reconnecting";
  lastConnected: number | null;
  setStatus: (status: ConnectionState["status"]) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: "disconnected",
  lastConnected: null,
  setStatus: (status) =>
    set((state) => ({
      status,
      lastConnected: status === "connected" ? Date.now() : state.lastConnected,
    })),
}));
