import type { OrchestrationEvent } from "@orka/core";
import { create } from "zustand";
import type { WsTransport } from "./wsTransport";

interface TimelineCacheState {
  /** sessionId → cached events */
  entries: Record<string, OrchestrationEvent[]>;
  /** sessionIds currently being fetched */
  inflight: Set<string>;
  /** Prefetch a session's timeline in the background */
  prefetch: (transport: WsTransport, sessionId: string) => void;
  /** Get cached timeline or null */
  get: (sessionId: string) => OrchestrationEvent[] | null;
  /** Store a fetched timeline (e.g. after ChatView loads it) */
  set: (sessionId: string, events: OrchestrationEvent[]) => void;
}

export const useTimelineCache = create<TimelineCacheState>((set, get) => ({
  entries: {},
  inflight: new Set(),

  prefetch: (transport, sessionId) => {
    const state = get();
    if (state.entries[sessionId] || state.inflight.has(sessionId)) return;

    const nextInflight = new Set(state.inflight);
    nextInflight.add(sessionId);
    set({ inflight: nextInflight });

    transport
      .request<{ events: OrchestrationEvent[]; total: number }>("getSessionTimeline", { sessionId })
      .then((resp) => {
        const events = resp.events;
        const s = get();
        const nextInflight = new Set(s.inflight);
        nextInflight.delete(sessionId);
        set({
          entries: { ...s.entries, [sessionId]: events },
          inflight: nextInflight,
        });
      })
      .catch(() => {
        const s = get();
        const nextInflight = new Set(s.inflight);
        nextInflight.delete(sessionId);
        set({ inflight: nextInflight });
      });
  },

  get: (sessionId) => {
    return get().entries[sessionId] ?? null;
  },

  set: (sessionId, events) => {
    set((s) => ({ entries: { ...s.entries, [sessionId]: events } }));
  },
}));
