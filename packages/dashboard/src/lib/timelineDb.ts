import type { OrchestrationEvent } from "@orka/core";
import { createStore, get, set, del } from "idb-keyval";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CachedTimeline {
  events: OrchestrationEvent[];
  updatedAt: number;
}

/** Injectable interface for timeline persistence. */
export interface TimelineStorage {
  load(sessionId: string): Promise<CachedTimeline | undefined>;
  save(sessionId: string, data: CachedTimeline): Promise<void>;
  remove(sessionId: string): Promise<void>;
  evict(maxSessions: number, ttlMs: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// IndexedDB implementation (production)
// ---------------------------------------------------------------------------

/** sessionId → updatedAt timestamp */
type CacheIndex = Record<string, number>;

const INDEX_KEY = "__index";

export function createIdbTimelineStorage(): TimelineStorage {
  const store = createStore("orka-timeline", "events");

  async function getIndex(): Promise<CacheIndex> {
    return (await get<CacheIndex>(INDEX_KEY, store)) ?? {};
  }

  async function setIndex(index: CacheIndex): Promise<void> {
    await set(INDEX_KEY, index, store);
  }

  async function evictInternal(idx: CacheIndex, maxSessions: number, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    let changed = false;

    // Remove expired entries
    for (const [id, ts] of Object.entries(idx)) {
      if (now - ts > ttlMs) {
        await del(`tl:${id}`, store);
        delete idx[id];
        changed = true;
      }
    }

    // Remove oldest if over limit
    const entries = Object.entries(idx).sort(([, a], [, b]) => a - b);
    while (entries.length > maxSessions) {
      const entry = entries.shift();
      if (!entry) break;
      const [id] = entry;
      await del(`tl:${id}`, store);
      delete idx[id];
      changed = true;
    }

    return changed;
  }

  const storage: TimelineStorage = {
    async load(sessionId) {
      try {
        return await get<CachedTimeline>(`tl:${sessionId}`, store);
      } catch {
        return undefined;
      }
    },

    async save(sessionId, data) {
      try {
        await set(`tl:${sessionId}`, data, store);
        const idx = await getIndex();
        const isNew = !(sessionId in idx);
        idx[sessionId] = data.updatedAt;
        await setIndex(idx);
        if (isNew) {
          const changed = await evictInternal(idx, 50, 7 * 24 * 60 * 60 * 1000);
          if (changed) await setIndex(idx);
        }
      } catch {
        // IDB unavailable — degrade gracefully
      }
    },

    async remove(sessionId) {
      try {
        await del(`tl:${sessionId}`, store);
        const idx = await getIndex();
        delete idx[sessionId];
        await setIndex(idx);
      } catch {
        // IDB unavailable
      }
    },

    async evict(maxSessions, ttlMs) {
      try {
        const idx = await getIndex();
        const changed = await evictInternal(idx, maxSessions, ttlMs);
        if (changed) await setIndex(idx);
      } catch {
        // IDB unavailable
      }
    },
  };

  return storage;
}

// ---------------------------------------------------------------------------
// In-memory implementation (testing)
// ---------------------------------------------------------------------------

export function createMemoryTimelineStorage(): TimelineStorage {
  const data = new Map<string, CachedTimeline>();

  return {
    async load(sessionId) {
      return data.get(sessionId);
    },

    async save(sessionId, timeline) {
      data.set(sessionId, timeline);
    },

    async remove(sessionId) {
      data.delete(sessionId);
    },

    async evict(maxSessions, ttlMs) {
      const now = Date.now();

      // Remove expired
      for (const [id, entry] of data) {
        if (now - entry.updatedAt > ttlMs) {
          data.delete(id);
        }
      }

      // Remove oldest if over limit
      if (data.size > maxSessions) {
        const sorted = [...data.entries()].sort(([, a], [, b]) => a.updatedAt - b.updatedAt);
        while (sorted.length > maxSessions) {
          const entry = sorted.shift();
          if (!entry) break;
          const [id] = entry;
          data.delete(id);
        }
      }
    },
  };
}
