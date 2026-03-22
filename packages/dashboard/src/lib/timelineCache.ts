import type { OrchestrationEvent } from "@orka/core";
import { create } from "zustand";
import type { RpcClient } from "./rpcClient";
import { createIdbTimelineStorage, type TimelineStorage } from "./timelineDb";

export interface TimelineCacheState {
  /** sessionId → cached events */
  entries: Record<string, OrchestrationEvent[]>;
  /** sessionIds currently being fetched */
  inflight: Set<string>;
  /** Prefetch a session's timeline in the background (tries IDB first) */
  prefetch: (client: RpcClient, sessionId: string) => void;
  /** Get cached timeline from memory, or null */
  get: (sessionId: string) => OrchestrationEvent[] | null;
  /** Store a fetched timeline (also persists to IndexedDB) */
  set: (sessionId: string, events: OrchestrationEvent[]) => void;
  /** Load timeline from IndexedDB into memory. Returns events or null. */
  hydrate: (sessionId: string) => Promise<OrchestrationEvent[] | null>;
}

export function createTimelineCache(storage: TimelineStorage) {
  return create<TimelineCacheState>((set, get) => ({
    entries: {},
    inflight: new Set(),

    prefetch: (client, sessionId) => {
      const state = get();
      if (state.entries[sessionId] || state.inflight.has(sessionId)) return;

      const nextInflight = new Set(state.inflight);
      nextInflight.add(sessionId);
      set({ inflight: nextInflight });

      (async () => {
        try {
          // Try IDB hydration first to avoid unnecessary server round-trip
          const cached = await storage.load(sessionId);
          if (cached) {
            set((s) => ({
              entries: { ...s.entries, [sessionId]: cached.events },
              inflight: new Set([...s.inflight].filter((id) => id !== sessionId)),
            }));
            return;
          }

          // Full fetch from server
          const resp = await client.getSessionTimeline({ sessionId });
          set((s) => ({
            entries: { ...s.entries, [sessionId]: resp.events },
            inflight: new Set([...s.inflight].filter((id) => id !== sessionId)),
          }));
          void storage.save(sessionId, { events: resp.events, updatedAt: Date.now() });
        } catch {
          set((s) => ({
            inflight: new Set([...s.inflight].filter((id) => id !== sessionId)),
          }));
        }
      })();
    },

    get: (sessionId) => {
      return get().entries[sessionId] ?? null;
    },

    set: (sessionId, events) => {
      set((s) => ({ entries: { ...s.entries, [sessionId]: events } }));
      void storage.save(sessionId, { events, updatedAt: Date.now() });
    },

    hydrate: async (sessionId) => {
      // Already in memory — return immediately
      const inMemory = get().entries[sessionId];
      if (inMemory) return inMemory;

      try {
        const cached = await storage.load(sessionId);
        if (cached) {
          set((s) => ({ entries: { ...s.entries, [sessionId]: cached.events } }));
          return cached.events;
        }
      } catch {
        // IDB unavailable — degrade gracefully
      }

      return null;
    },
  }));
}

export const useTimelineCache = createTimelineCache(createIdbTimelineStorage());
