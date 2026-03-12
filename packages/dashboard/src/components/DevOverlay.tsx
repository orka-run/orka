import { Activity, ChevronDown, ChevronUp, RefreshCw, Wifi, WifiOff, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useRpcLatency } from "../lib/rpcLatencyStore";
import { useConnectionStore } from "../stores/connectionStore";

const OVERLAY_ENABLED_STORAGE_KEY = "orka.dashboard.devOverlay.enabled";
const OVERLAY_COLLAPSED_STORAGE_KEY = "orka.dashboard.devOverlay.collapsed";
const RECENT_CALL_LIMIT = 20;

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function readStoredBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const value = window.localStorage.getItem(key);
    if (value === "1") {
      return true;
    }
    if (value === "0") {
      return false;
    }
  } catch {
    return fallback;
  }

  return fallback;
}

function writeStoredBoolean(key: string, value: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Ignore storage failures; the overlay is a dev-only diagnostic surface.
  }
}

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
    return "text-emerald-300";
  }
  if (duration <= 500) {
    return "text-amber-300";
  }
  return "text-red-300";
}

function getConnectionTone(state: ConnectionState): string {
  if (state === "connected") {
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  }
  if (state === "reconnecting") {
    return "border-amber-500/40 bg-amber-500/10 text-amber-200";
  }
  if (state === "connecting") {
    return "border-sky-500/40 bg-sky-500/10 text-sky-200";
  }
  return "border-red-500/40 bg-red-500/10 text-red-200";
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

export function DevOverlay() {
  const { recent, stats, totalCount } = useRpcLatency();
  const connectionState = useConnectionStore((state) => state.status);
  const [isEnabled, setIsEnabled] = useState(() =>
    readStoredBoolean(OVERLAY_ENABLED_STORAGE_KEY, !!import.meta.env["DEV"]),
  );
  const [isCollapsed, setIsCollapsed] = useState(() =>
    readStoredBoolean(OVERLAY_COLLAPSED_STORAGE_KEY, false),
  );
  const recentCallsRef = useRef<HTMLDivElement | null>(null);
  const recentCalls = recent.slice(-RECENT_CALL_LIMIT);
  const overallAverage = computeOverallAverage(stats);
  const connectionIcon = getConnectionIcon(connectionState);
  const orderedStats = Object.entries(stats).sort(
    ([leftMethod, left], [rightMethod, right]) =>
      right.count - left.count || leftMethod.localeCompare(rightMethod),
  );

  const toggleOverlay = useEffectEvent(() => {
    setIsEnabled((current) => {
      const next = !current;
      writeStoredBoolean(OVERLAY_ENABLED_STORAGE_KEY, next);
      if (!next) {
        writeStoredBoolean(OVERLAY_COLLAPSED_STORAGE_KEY, false);
        setIsCollapsed(false);
      }
      return next;
    });
  });

  const closeOverlay = useEffectEvent(() => {
    writeStoredBoolean(OVERLAY_ENABLED_STORAGE_KEY, false);
    writeStoredBoolean(OVERLAY_COLLAPSED_STORAGE_KEY, false);
    setIsCollapsed(false);
    setIsEnabled(false);
  });

  const toggleCollapsed = useEffectEvent(() => {
    setIsCollapsed((current) => {
      const next = !current;
      writeStoredBoolean(OVERLAY_COLLAPSED_STORAGE_KEY, next);
      return next;
    });
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== "d") {
        return;
      }

      event.preventDefault();
      toggleOverlay();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleOverlay]);

  useEffect(() => {
    if (!isEnabled || isCollapsed) {
      return;
    }

    const element = recentCallsRef.current;
    if (!element) {
      return;
    }

    element.scrollTop = element.scrollHeight;
  }, [isCollapsed, isEnabled, recentCalls.length]);

  if (!isEnabled) {
    return null;
  }

  if (isCollapsed) {
    const ConnectionIcon = connectionIcon;

    return (
      <button
        type="button"
        onClick={toggleCollapsed}
        className="fixed bottom-14 right-2 z-50 flex max-w-[calc(100vw-1rem)] items-center gap-2 rounded-full border border-zinc-700/80 bg-zinc-950/90 px-3 py-2 text-xs text-zinc-100 shadow-2xl backdrop-blur sm:bottom-4 sm:right-4"
      >
        <Activity className="h-3.5 w-3.5 text-zinc-400" />
        <span className="font-medium">RPC: {formatDuration(overallAverage)} avg</span>
        <ConnectionIcon className={`h-3.5 w-3.5 ${connectionState === "reconnecting" ? "animate-spin" : ""}`} />
      </button>
    );
  }

  const ConnectionIcon = connectionIcon;

  return (
    <section className="fixed bottom-14 left-2 right-2 z-50 max-h-[min(60vh,34rem)] overflow-hidden rounded-2xl border border-zinc-700/70 bg-zinc-950/88 text-zinc-100 shadow-2xl backdrop-blur sm:bottom-4 sm:left-auto sm:right-4 sm:w-[30rem]">
      <header className="flex items-start justify-between gap-3 border-b border-zinc-800/80 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-zinc-400" />
            <h2 className="text-sm font-semibold text-zinc-50">Dev Overlay</h2>
          </div>
          <p className="mt-1 text-xs text-zinc-400">
            {totalCount} RPC calls, {formatDuration(overallAverage)} weighted average
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium ${getConnectionTone(connectionState)}`}
          >
            <ConnectionIcon
              className={`h-3.5 w-3.5 ${connectionState === "reconnecting" ? "animate-spin" : ""}`}
            />
            {formatConnectionLabel(connectionState)}
          </span>
          <button
            type="button"
            onClick={toggleCollapsed}
            className="rounded-lg border border-zinc-700/80 p-1.5 text-zinc-400 transition hover:text-zinc-100"
            aria-label="Collapse dev overlay"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={closeOverlay}
            className="rounded-lg border border-zinc-700/80 p-1.5 text-zinc-400 transition hover:text-zinc-100"
            aria-label="Close dev overlay"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.9fr)]">
        <section className="min-h-0">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
              Recent Calls
            </h3>
            <span className="font-mono text-[11px] text-zinc-500">last {recentCalls.length}</span>
          </div>
          <div
            ref={recentCallsRef}
            className="max-h-64 overflow-y-auto rounded-xl border border-zinc-800/80 bg-black/20"
          >
            {recentCalls.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-zinc-500">No RPC traffic yet.</div>
            ) : (
              <div className="divide-y divide-zinc-800/80">
                {recentCalls.map((entry, index) => (
                  <div
                    key={`${entry.timestamp}-${entry.method}-${index}`}
                    className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-3 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium text-zinc-100">{entry.method}</div>
                      <div className="mt-1 font-mono text-[11px] text-zinc-500">
                        {formatTimestamp(entry.timestamp)}
                      </div>
                    </div>
                    <span
                      className={`rounded-full border px-2 py-0.5 font-medium uppercase tracking-[0.12em] ${
                        entry.status === "ok"
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                          : "border-red-500/40 bg-red-500/10 text-red-200"
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
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
              Method Stats
            </h3>
            <button
              type="button"
              onClick={toggleCollapsed}
              className="inline-flex items-center gap-1 text-[11px] text-zinc-500 transition hover:text-zinc-300"
            >
              Minimize
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto rounded-xl border border-zinc-800/80 bg-black/20">
            {orderedStats.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-zinc-500">No method data yet.</div>
            ) : (
              <div className="divide-y divide-zinc-800/80">
                {orderedStats.map(([method, methodStats]) => (
                  <div key={method} className="px-3 py-2 text-xs">
                    <div className="truncate font-medium text-zinc-100">{method}</div>
                    <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-[11px] text-zinc-400">
                      <span>
                        avg{" "}
                        <strong className={getDurationTone(methodStats.avg)}>{formatDuration(methodStats.avg)}</strong>
                      </span>
                      <span>
                        p95{" "}
                        <strong className={getDurationTone(methodStats.p95)}>{formatDuration(methodStats.p95)}</strong>
                      </span>
                      <span>
                        n <strong className="text-zinc-200">{methodStats.count}</strong>
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
