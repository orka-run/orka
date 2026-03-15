import { create } from "zustand";

const STORAGE_KEY = "orka-connection-settings";

export type DashboardMode = "local" | "hosted";

interface ConnectionSettings {
  mode: DashboardMode;
  endpointUrl: string | null;
  authToken: string | null;
  pairedNodeId: string | null;
}

interface ConnectionSettingsState extends ConnectionSettings {
  setEndpoint: (url: string | null, token: string | null, pairedNodeId?: string | null) => void;
  setMode: (mode: DashboardMode) => void;
}

function loadFromStorage(): ConnectionSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ConnectionSettings>;
      return {
        mode: parsed.mode === "hosted" ? "hosted" : "local",
        endpointUrl: parsed.endpointUrl ?? null,
        authToken: parsed.authToken ?? null,
        pairedNodeId: parsed.pairedNodeId ?? null,
      };
    }
  } catch {
    // localStorage unavailable or corrupt
  }
  return { mode: "local", endpointUrl: null, authToken: null, pairedNodeId: null };
}

function saveToStorage(settings: ConnectionSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage unavailable
  }
}

export const useConnectionSettingsStore = create<ConnectionSettingsState>((set, get) => ({
  ...loadFromStorage(),
  setEndpoint: (url, token, pairedNodeId) => {
    const settings: ConnectionSettings = {
      mode: get().mode,
      endpointUrl: url,
      authToken: token,
      pairedNodeId: pairedNodeId ?? null,
    };
    saveToStorage(settings);
    set(settings);
  },
  setMode: (mode) => {
    const current = get();
    const settings: ConnectionSettings = {
      mode,
      endpointUrl: current.endpointUrl,
      authToken: current.authToken,
      pairedNodeId: current.pairedNodeId,
    };
    saveToStorage(settings);
    set({ mode });
  },
}));
