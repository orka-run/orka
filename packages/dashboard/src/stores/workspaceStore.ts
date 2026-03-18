import type { WorkspaceInfo, WorkspaceMetadata, WorkspaceSettings } from "@orka/core";
import { create } from "zustand";
import type { RpcClient } from "../lib/rpcClient";

const ACTIVE_WORKSPACE_KEY = "orka:activeWorkspace";

export interface WorkspaceState {
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: string | null; // null = show all sessions
  loading: boolean;

  fetchWorkspaces: (client: RpcClient) => Promise<void>;
  setActiveWorkspace: (id: string | null) => void;
  createWorkspace: (
    client: RpcClient,
    opts: {
      name: string;
      paths?: Array<{ nodeId?: string; path: string }>;
      settings?: WorkspaceSettings;
      metadata?: WorkspaceMetadata;
    },
  ) => Promise<WorkspaceInfo>;
  updateWorkspace: (
    client: RpcClient,
    id: string,
    opts: Partial<{
      name: string;
      settings: WorkspaceSettings;
      metadata: WorkspaceMetadata;
      archivedAt: string | null;
    }>,
  ) => Promise<void>;
  deleteWorkspace: (client: RpcClient, id: string) => Promise<void>;
}

function restoreActiveWorkspace(): string | null {
  try {
    return localStorage.getItem(ACTIVE_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: restoreActiveWorkspace(),
  loading: false,

  fetchWorkspaces: async (client) => {
    set((state) => ({ loading: state.workspaces.length === 0 }));
    try {
      const workspaces = await client.listWorkspaces();
      set((state) => {
        const activeStillExists =
          state.activeWorkspaceId === null ||
          workspaces.some((w) => w.id === state.activeWorkspaceId);
        return {
          workspaces,
          activeWorkspaceId: activeStillExists ? state.activeWorkspaceId : null,
          loading: false,
        };
      });
    } catch {
      set({ loading: false });
    }
  },

  setActiveWorkspace: (id) => {
    set({ activeWorkspaceId: id });
    try {
      if (id != null) {
        localStorage.setItem(ACTIVE_WORKSPACE_KEY, id);
      } else {
        localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
      }
    } catch {
      // localStorage unavailable
    }
  },

  createWorkspace: async (client, opts) => {
    const workspace = await client.createWorkspace(opts);
    set((state) => ({
      workspaces: [...state.workspaces, workspace],
    }));
    return workspace;
  },

  updateWorkspace: async (client, id, opts) => {
    await client.updateWorkspace(id, opts);
    // Re-fetch to get updated data
    void get().fetchWorkspaces(client);
  },

  deleteWorkspace: async (client, id) => {
    await client.deleteWorkspace(id);
    set((state) => ({
      workspaces: state.workspaces.filter((w) => w.id !== id),
      activeWorkspaceId: state.activeWorkspaceId === id ? null : state.activeWorkspaceId,
    }));
  },
}));
