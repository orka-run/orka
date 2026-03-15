import { Settings } from "lucide-react";
import { useRpcLatency } from "../lib/rpcLatencyStore";
import { useConnectionStore } from "../stores/connectionStore";
import { useConnectionSettingsStore } from "../stores/connectionSettingsStore";

interface StatusBarProps {
  sessionCount: number;
  serverSessionCount?: number | null;
  onOpenConnectionSettings?: () => void;
}

function getConnectionIndicator(status: ReturnType<typeof useConnectionStore.getState>["status"]) {
  if (status === "connected") {
    return {
      dotClassName: "bg-emerald-400",
      label: "Connected",
    };
  }

  if (status === "connecting" || status === "reconnecting") {
    return {
      dotClassName: "bg-amber-400",
      label: "Connecting...",
    };
  }

  return {
    dotClassName: "bg-red-400",
    label: "Disconnected",
  };
}

export function StatusBar({ sessionCount, serverSessionCount = null, onOpenConnectionSettings }: StatusBarProps) {
  const status = useConnectionStore((state) => state.status);
  const reconnectAttempts = useConnectionStore((state) => state.reconnectAttempts);
  const endpointUrl = useConnectionSettingsStore((s) => s.endpointUrl);
  const { connectionRtt } = useRpcLatency();
  const { dotClassName, label } = getConnectionIndicator(status);
  const displayedSessionCount = serverSessionCount ?? sessionCount;
  const showRtt = status === "connected" && connectionRtt !== null;
  const reconnectLabel = status === "reconnecting" ? ` (attempt ${reconnectAttempts})` : "";

  return (
    <footer className="flex items-center justify-between border-t border-zinc-800 bg-zinc-900 px-4 py-1.5 text-xs text-zinc-500">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onOpenConnectionSettings}
          className="inline-flex items-center gap-1.5 text-zinc-300 transition hover:text-zinc-100"
          title="Connection settings"
        >
          <span className={`h-2 w-2 rounded-full ${dotClassName}`} />
          <span>
            {label}
            {reconnectLabel}
          </span>
          {endpointUrl ? (
            <span className="max-w-48 truncate text-zinc-500" title={endpointUrl}>
              {endpointUrl}
            </span>
          ) : null}
          <Settings className="h-3 w-3 text-zinc-600" />
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
