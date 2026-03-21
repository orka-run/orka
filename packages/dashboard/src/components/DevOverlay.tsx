import { Activity, ChevronUp, RefreshCw, Wifi, WifiOff, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useRpcLatency } from "../lib/rpcLatencyStore";
import { useConnectionStore } from "../stores/connectionStore";

const RECENT_CALL_LIMIT = 20;

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function formatDuration(duration: number | null): string {
  if (duration === null) {
    return "--";
  }

  return `${Math.round(duration)}ms`;
}

function formatTimestamp(timestamp: number): string {
  return `${timestampFormatter.format(timestamp)}.${String(timestamp % 1000).padStart(3, "0")}`;
}

function getDurationTone(duration: number): string {
  if (duration < 100) {
    return "text-emerald-700";
  }
  if (duration <= 500) {
    return "text-status-warning";
  }
  return "text-status-error";
}

function getConnectionTone(state: ConnectionState): string {
  if (state === "connected") {
    return "border-emerald-600/40 bg-emerald-600/10 text-emerald-800";
  }
  if (state === "reconnecting") {
    return "border-status-warning/40 bg-status-warning/10 text-status-warning";
  }
  if (state === "connecting") {
    return "border-accent/40 bg-accent/10 text-accent-strong";
  }
  return "border-status-error/40 bg-status-error/10 text-status-error";
}

function formatConnectionLabel(state: ConnectionState): string {
  if (state === "connected") {
    return "Connected";
  }
  if (state === "reconnecting") {
    return "Reconnecting";
  }
  if (state === "connecting") {
    return "Connecting";
  }
  return "Disconnected";
}

function getConnectionIcon(state: ConnectionState) {
  if (state === "connected" || state === "connecting") {
    return Wifi;
  }
  if (state === "reconnecting") {
    return RefreshCw;
  }
  return WifiOff;
}

function computeOverallAverage(stats: Record<string, { avg: number; count: number }>): number | null {
  let totalDuration = 0;
  let totalCount = 0;

  for (const value of Object.values(stats)) {
    totalDuration += value.avg * value.count;
    totalCount += value.count;
  }

  if (totalCount === 0) {
    return null;
  }

  return totalDuration / totalCount;
}

type ConnectionState = ReturnType<typeof useConnectionStore.getState>["status"];

interface DevOverlayProps {
  open: boolean;
  onClose: () => void;
}

export function DevOverlay({ open, onClose }: DevOverlayProps) {
  const { recent, stats, totalCount } = useRpcLatency();
  const connectionState = useConnectionStore((state) => state.status);
  const recentCallsRef = useRef<HTMLDivElement | null>(null);
  const recentCalls = recent.slice(-RECENT_CALL_LIMIT);
  const overallAverage = computeOverallAverage(stats);
  const connectionIcon = getConnectionIcon(connectionState);
  const orderedStats = Object.entries(stats).sort(
    ([leftMethod, _left], [rightMethod, right]) =>
      right.count - (stats[leftMethod]?.count ?? 0) || leftMethod.localeCompare(rightMethod),
  );

  useEffect(() => {
    if (!open) return;
    const element = recentCallsRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [open, recentCalls.length]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== "d") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!open) return null;

  const ConnectionIcon = connectionIcon;

  return (
    <section className="absolute bottom-full left-0 right-0 z-50 max-h-[min(60vh,34rem)] overflow-hidden border-t border-border bg-surface/95 text-ink backdrop-blur">
      <header className="flex items-start justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-ink-muted" />
            <h2 className="text-[12px] font-semibold text-ink">Dev Overlay</h2>
          </div>
          <p className="mt-0.5 text-[10px] text-ink-muted">
            {totalCount} RPC calls, {formatDuration(overallAverage)} weighted average
          </p>
        </div>
        <div className="flex items-center gap-1">
          <span
            className={`inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[10px] font-medium ${getConnectionTone(connectionState)}`}
          >
            <ConnectionIcon
              className={`h-3 w-3 ${connectionState === "reconnecting" ? "animate-spin" : ""}`}
            />
            {formatConnectionLabel(connectionState)}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm border border-border p-1 text-ink-muted transition hover:text-ink"
            aria-label="Close dev overlay"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="grid gap-2 p-2 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.9fr)]">
        <section className="min-h-0">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
              Recent Calls
            </h3>
            <span className="font-mono text-[10px] text-ink-muted">last {recentCalls.length}</span>
          </div>
          <div
            ref={recentCallsRef}
            className="max-h-64 overflow-y-auto rounded-sm border border-border bg-surface-alt"
          >
            {recentCalls.length === 0 ? (
              <div className="px-2 py-4 text-center text-[12px] text-ink-muted">No RPC traffic yet.</div>
            ) : (
              <div className="divide-y divide-border">
                {recentCalls.map((entry, index) => (
                  <div
                    key={`${entry.timestamp}-${entry.method}-${index}`}
                    className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 px-2 py-1.5 text-[11px]"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium text-ink">{entry.method}</div>
                      <div className="mt-0.5 font-mono text-[10px] text-ink-muted">
                        {formatTimestamp(entry.timestamp)}
                      </div>
                    </div>
                    <span
                      className={`rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] ${
                        entry.status === "ok"
                          ? "border-emerald-600/40 bg-emerald-600/10 text-emerald-800"
                          : "border-status-error/40 bg-status-error/10 text-status-error"
                      }`}
                    >
                      {entry.status}
                    </span>
                    <span className={`font-mono ${getDurationTone(entry.duration)}`}>
                      {formatDuration(entry.duration)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="min-h-0">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
              Method Stats
            </h3>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1 text-[10px] text-ink-muted transition hover:text-ink-secondary"
            >
              Close
              <ChevronUp className="h-3 w-3" />
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto rounded-sm border border-border bg-surface-alt">
            {orderedStats.length === 0 ? (
              <div className="px-2 py-4 text-center text-[12px] text-ink-muted">No method data yet.</div>
            ) : (
              <div className="divide-y divide-border">
                {orderedStats.map(([method, methodStats]) => (
                  <div key={method} className="px-2 py-1.5 text-[11px]">
                    <div className="truncate font-medium text-ink">{method}</div>
                    <div className="mt-0.5 grid grid-cols-3 gap-2 font-mono text-[10px] text-ink-muted">
                      <span>
                        avg{" "}
                        <strong className={getDurationTone(methodStats.avg)}>{formatDuration(methodStats.avg)}</strong>
                      </span>
                      <span>
                        p95{" "}
                        <strong className={getDurationTone(methodStats.p95)}>{formatDuration(methodStats.p95)}</strong>
                      </span>
                      <span>
                        n <strong className="text-ink">{methodStats.count}</strong>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
