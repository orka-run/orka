import { create } from "zustand";

const STORAGE_KEY = "orka-connection-settings";

interface ConnectionSettings {
  endpointUrl: string | null;
  authToken: string | null;
  pairedNodeId: string | null;
}

interface ConnectionSettingsState extends ConnectionSettings {
  setEndpoint: (url: string | null, token: string | null, pairedNodeId?: string | null) => void;
}

function loadFromStorage(): ConnectionSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ConnectionSettings>;
      return {
        endpointUrl: parsed.endpointUrl ?? null,
        authToken: parsed.authToken ?? null,
        pairedNodeId: parsed.pairedNodeId ?? null,
      };
    }
  } catch {
    // localStorage unavailable or corrupt
  }
  return { endpointUrl: null, authToken: null, pairedNodeId: null };
}

function saveToStorage(settings: ConnectionSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage unavailable
  }
}

export const useConnectionSettingsStore = create<ConnectionSettingsState>((set) => ({
  ...loadFromStorage(),
  setEndpoint: (url, token, pairedNodeId) => {
    const settings: ConnectionSettings = {
      endpointUrl: url,
      authToken: token,
      pairedNodeId: pairedNodeId ?? null,
    };
    saveToStorage(settings);
    set(settings);
  },
}));
