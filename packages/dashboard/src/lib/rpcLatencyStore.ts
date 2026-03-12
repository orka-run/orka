import { useSyncExternalStore } from "react";

export interface MethodStats {
  avg: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  count: number;
}

export type RpcCompletionStatus = "ok" | "error";

export interface RpcCompletion {
  method: string;
  duration: number;
  ok: boolean;
  timestamp: number;
  status?: RpcCompletionStatus;
}

export interface RpcLatencyEntry {
  method: string;
  duration: number;
  status: RpcCompletionStatus;
  timestamp: number;
}

export interface RpcLatencyStore {
  getMethodStats: (method: string) => MethodStats;
  getAllStats: () => Record<string, MethodStats>;
  getLastRtt: (method: string) => number | null;
  getAllLastRtt: () => Record<string, number | null>;
  getConnectionRtt: () => number | null;
  getRecentEntries: (limit?: number) => RpcLatencyEntry[];
  getTotalCount: () => number;
  onRpcComplete: (completion: RpcCompletion) => void;
  subscribe: (listener: () => void) => () => void;
  reset: () => void;
}

type MethodBucket = {
  entries: Array<RpcLatencyEntry | undefined>;
  nextIndex: number;
  count: number;
  lastRtt: number | null;
  lastTimestamp: number | null;
  lastOk: boolean | null;
};

export const DEFAULT_RPC_LATENCY_BUFFER_SIZE = 100;
export const DEFAULT_RECENT_RPC_ENTRY_LIMIT = 200;

const EMPTY_METHOD_STATS: MethodStats = {
  avg: 0,
  p95: 0,
  p99: 0,
  min: 0,
  max: 0,
  count: 0,
};

function createMethodBucket(maxEntries: number): MethodBucket {
  return {
    entries: new Array<RpcLatencyEntry | undefined>(maxEntries),
    nextIndex: 0,
    count: 0,
    lastRtt: null,
    lastTimestamp: null,
    lastOk: null,
  };
}

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * ratio) - 1),
  );
  return sortedValues[index] ?? 0;
}

function snapshotValues(bucket: MethodBucket): number[] {
  if (bucket.count === 0) {
    return [];
  }

  if (bucket.count < bucket.entries.length) {
    return bucket.entries
      .slice(0, bucket.count)
      .flatMap((entry) => (entry ? [entry.duration] : []));
  }

  return [
    ...bucket.entries.slice(bucket.nextIndex),
    ...bucket.entries.slice(0, bucket.nextIndex),
  ].flatMap((entry) => (entry ? [entry.duration] : []));
}

function computeStats(bucket: MethodBucket): MethodStats {
  const values = snapshotValues(bucket);
  if (values.length === 0) {
    return EMPTY_METHOD_STATS;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const sum = values.reduce((total, value) => total + value, 0);

  return {
    avg: sum / values.length,
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    count: values.length,
  };
}

export function createRpcLatencyStore(
  maxEntries = DEFAULT_RPC_LATENCY_BUFFER_SIZE,
): RpcLatencyStore {
  const capacity = Math.max(1, Math.floor(maxEntries) || DEFAULT_RPC_LATENCY_BUFFER_SIZE);
  const buckets = new Map<string, MethodBucket>();
  const listeners = new Set<() => void>();
  const recentLimit = Math.max(
    DEFAULT_RECENT_RPC_ENTRY_LIMIT,
    capacity,
  );
  const recentEntries: RpcLatencyEntry[] = [];
  let connectionRtt: number | null = null;
  let totalCount = 0;

  const getBucket = (method: string): MethodBucket => {
    const existing = buckets.get(method);
    if (existing) {
      return existing;
    }

    const created = createMethodBucket(capacity);
    buckets.set(method, created);
    return created;
  };

  const emit = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getMethodStats(method) {
      const bucket = buckets.get(method);
      return bucket ? computeStats(bucket) : EMPTY_METHOD_STATS;
    },
    getAllStats() {
      return Object.fromEntries(
        [...buckets.entries()].map(([method, bucket]) => [method, computeStats(bucket)]),
      );
    },
    getLastRtt(method) {
      return buckets.get(method)?.lastRtt ?? null;
    },
    getAllLastRtt() {
      return Object.fromEntries(
        [...buckets.entries()].map(([method, bucket]) => [method, bucket.lastRtt]),
      );
    },
    getConnectionRtt() {
      return connectionRtt;
    },
    getRecentEntries(limit) {
      const safeLimit = Math.max(1, Math.floor(limit ?? recentEntries.length) || recentEntries.length);
      return recentEntries.slice(-safeLimit);
    },
    getTotalCount() {
      return totalCount;
    },
    onRpcComplete(completion) {
      const duration = Math.max(0, completion.duration);
      const entry: RpcLatencyEntry = {
        method: completion.method,
        duration,
        status: completion.status ?? (completion.ok ? "ok" : "error"),
        timestamp: completion.timestamp,
      };
      const bucket = getBucket(completion.method);
      bucket.entries[bucket.nextIndex] = entry;
      bucket.nextIndex = (bucket.nextIndex + 1) % bucket.entries.length;
      bucket.count = Math.min(bucket.count + 1, bucket.entries.length);
      bucket.lastRtt = duration;
      bucket.lastTimestamp = completion.timestamp;
      bucket.lastOk = completion.ok;
      totalCount += 1;
      connectionRtt = duration;
      recentEntries.push(entry);
      if (recentEntries.length > recentLimit) {
        recentEntries.shift();
      }
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      buckets.clear();
      recentEntries.length = 0;
      connectionRtt = null;
      totalCount = 0;
      emit();
    },
  };
}

export const rpcLatencyStore = createRpcLatencyStore();

type RpcLatencyMethodSnapshot = {
  connectionRtt: number | null;
  lastRtt: number | null;
  stats: MethodStats;
  recent: RpcLatencyEntry[];
  totalCount: number;
};

type RpcLatencyAllSnapshot = {
  connectionRtt: number | null;
  lastRtt: Record<string, number | null>;
  stats: Record<string, MethodStats>;
  recent: RpcLatencyEntry[];
  totalCount: number;
};

export function useRpcLatency(method: string): RpcLatencyMethodSnapshot;
export function useRpcLatency(): RpcLatencyAllSnapshot;
export function useRpcLatency(method?: string): RpcLatencyMethodSnapshot | RpcLatencyAllSnapshot {
  return useSyncExternalStore(
    rpcLatencyStore.subscribe,
    () => {
      if (method) {
        return {
          connectionRtt: rpcLatencyStore.getConnectionRtt(),
          lastRtt: rpcLatencyStore.getLastRtt(method),
          stats: rpcLatencyStore.getMethodStats(method),
          recent: rpcLatencyStore.getRecentEntries().filter((entry) => entry.method === method),
          totalCount: rpcLatencyStore.getTotalCount(),
        };
      }

      return {
        connectionRtt: rpcLatencyStore.getConnectionRtt(),
        lastRtt: rpcLatencyStore.getAllLastRtt(),
        stats: rpcLatencyStore.getAllStats(),
        recent: rpcLatencyStore.getRecentEntries(),
        totalCount: rpcLatencyStore.getTotalCount(),
      };
    },
    () => {
      if (method) {
        return {
          connectionRtt: null,
          lastRtt: null,
          stats: EMPTY_METHOD_STATS,
          recent: [],
          totalCount: 0,
        };
      }

      return {
        connectionRtt: null,
        lastRtt: {},
        stats: {},
        recent: [],
        totalCount: 0,
      };
    },
  );
}
