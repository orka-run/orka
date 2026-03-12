import { useSyncExternalStore } from "react";

export const DEFAULT_RPC_LATENCY_BUFFER_SIZE = 100;

export type MethodStats = {
  avg: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  count: number;
};

export type RpcCompletion = {
  method: string;
  duration: number;
  success: boolean;
  timestamp: number;
};

type MethodMeasurements = {
  values: number[];
  nextIndex: number;
  count: number;
  lastRtt: number | null;
};

type MethodLatencySnapshot = {
  stats: MethodStats;
  lastRtt: number | null;
  connectionRtt: number | null;
};

type AllLatencySnapshot = {
  stats: Record<string, MethodStats>;
  lastRttByMethod: Record<string, number | null>;
  connectionRtt: number | null;
};

const EMPTY_STATS: MethodStats = {
  avg: 0,
  p95: 0,
  p99: 0,
  min: 0,
  max: 0,
  count: 0,
};

function clampDuration(duration: number): number {
  return Math.max(0, Number.isFinite(duration) ? duration : 0);
}

function getPercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sortedValues.length) - 1),
  );
  return sortedValues[index] ?? 0;
}

function calculateStats(values: readonly number[]): MethodStats {
  if (values.length === 0) {
    return EMPTY_STATS;
  }

  const sortedValues = [...values].sort((left, right) => left - right);
  const total = values.reduce((sum, value) => sum + value, 0);

  return {
    avg: total / values.length,
    p95: getPercentile(sortedValues, 95),
    p99: getPercentile(sortedValues, 99),
    min: sortedValues[0] ?? 0,
    max: sortedValues.at(-1) ?? 0,
    count: values.length,
  };
}

export class RpcLatencyStore {
  private readonly methods = new Map<string, MethodMeasurements>();
  private readonly listeners = new Set<() => void>();
  private connectionRtt: number | null = null;

  constructor(private readonly bufferSize = DEFAULT_RPC_LATENCY_BUFFER_SIZE) {}

  getMethodStats(method: string): MethodStats {
    return calculateStats(this.getMethodValues(method));
  }

  getAllStats(): Record<string, MethodStats> {
    const stats: Record<string, MethodStats> = {};
    for (const method of this.methods.keys()) {
      stats[method] = this.getMethodStats(method);
    }
    return stats;
  }

  getLastRtt(method: string): number | null {
    return this.methods.get(method)?.lastRtt ?? null;
  }

  getConnectionRtt(): number | null {
    return this.connectionRtt;
  }

  onRpcComplete = (entry: RpcCompletion): void => {
    const duration = clampDuration(entry.duration);
    const current = this.methods.get(entry.method) ?? {
      values: [],
      nextIndex: 0,
      count: 0,
      lastRtt: null,
    };

    if (current.values.length < this.bufferSize) {
      current.values.push(duration);
      current.count = current.values.length;
    } else {
      current.values[current.nextIndex] = duration;
      current.nextIndex = (current.nextIndex + 1) % this.bufferSize;
      current.count = this.bufferSize;
    }

    current.lastRtt = duration;
    this.connectionRtt = duration;
    this.methods.set(entry.method, current);
    this.emit();
  };

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(method?: string): MethodLatencySnapshot | AllLatencySnapshot {
    if (method) {
      return {
        stats: this.getMethodStats(method),
        lastRtt: this.getLastRtt(method),
        connectionRtt: this.getConnectionRtt(),
      };
    }

    const lastRttByMethod: Record<string, number | null> = {};
    for (const [name, measurements] of this.methods) {
      lastRttByMethod[name] = measurements.lastRtt;
    }

    return {
      stats: this.getAllStats(),
      lastRttByMethod,
      connectionRtt: this.getConnectionRtt(),
    };
  }

  reset(): void {
    this.methods.clear();
    this.connectionRtt = null;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private getMethodValues(method: string): number[] {
    const measurements = this.methods.get(method);
    if (!measurements) {
      return [];
    }

    return measurements.values.slice(0, measurements.count);
  }
}

export const rpcLatencyStore = new RpcLatencyStore();

export function useRpcLatency(method: string): MethodLatencySnapshot;
export function useRpcLatency(): AllLatencySnapshot;
export function useRpcLatency(method?: string): MethodLatencySnapshot | AllLatencySnapshot {
  return useSyncExternalStore(
    (listener) => rpcLatencyStore.subscribe(listener),
    () => rpcLatencyStore.getSnapshot(method),
    () => rpcLatencyStore.getSnapshot(method),
  );
}
