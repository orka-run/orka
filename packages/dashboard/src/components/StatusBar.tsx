import { Settings } from "lucide-react";
import { useRpcLatency } from "../lib/rpcLatencyStore";
import { useConnectionStore } from "../stores/connectionStore";
import { useConnectionSettingsStore } from "../stores/connectionSettingsStore";
import { useMode } from "../hooks/useMode";

interface StatusBarProps {
  sessionCount: number;
  serverSessionCount?: number | null;
  onOpenConnectionSettings?: () => void;
}

function getConnectionIndicator(status: ReturnType<typeof useConnectionStore.getState>["status"]) {
  if (status === "connected") {
    return {
      dotClassName: "bg-emerald-600",
      label: "Connected",
    };
  }

  if (status === "connecting" || status === "reconnecting") {
    return {
      dotClassName: "bg-amber-500",
      label: "Connecting...",
    };
  }

  return {
    dotClassName: "bg-status-error",
    label: "Disconnected",
  };
}

export function StatusBar({ sessionCount, serverSessionCount = null, onOpenConnectionSettings }: StatusBarProps) {
  const status = useConnectionStore((state) => state.status);
  const reconnectAttempts = useConnectionStore((state) => state.reconnectAttempts);
  const endpointUrl = useConnectionSettingsStore((s) => s.endpointUrl);
  const { mode } = useMode();
  const { connectionRtt } = useRpcLatency();
  const { dotClassName, label } = getConnectionIndicator(status);
  const displayedSessionCount = serverSessionCount ?? sessionCount;
  const showRtt = status === "connected" && connectionRtt !== null;
  const reconnectLabel = status === "reconnecting" ? ` (attempt ${reconnectAttempts})` : "";
  const connectionTarget = mode === "local" ? "Local daemon" : endpointUrl;

  return (
    <footer className="flex items-center justify-between border-t border-border bg-surface-alt px-2 py-1 text-[11px] text-ink-muted">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenConnectionSettings}
          className="inline-flex items-center gap-1.5 text-ink-secondary transition hover:text-ink"
          title="Connection settings"
        >
          <span className={`h-2 w-2 rounded-sm ${dotClassName}`} />
          <span>
            {label}
            {reconnectLabel}
          </span>
          {connectionTarget ? (
            <span className="max-w-48 truncate text-ink-muted" title={connectionTarget}>
              {connectionTarget}
            </span>
          ) : null}
          <Settings className="h-3 w-3 text-ink-muted" />
        </button>
        {showRtt ? <span>RTT: {Math.round(connectionRtt)}ms</span> : null}
        <span>
          {displayedSessionCount} session{displayedSessionCount !== 1 ? "s" : ""}
        </span>
      </div>
      <span>orka dashboard</span>
    </footer>
  );
}
