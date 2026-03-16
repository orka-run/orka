import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Wifi, WifiOff, RefreshCw } from "lucide-react";
import { useConnectionStore, type ConnectionState } from "../stores/connectionStore";

const MAX_RECONNECT_BEFORE_ERROR = 3;

function ProtocolMismatchBanner() {
  const mismatch = useConnectionStore((state) => state.protocolMismatch);

  if (!mismatch) return null;

  if (mismatch.kind === "outdated_client") {
    return (
      <div className="flex h-10 shrink-0 items-center justify-center gap-2 bg-status-error/90 text-[12px] text-white backdrop-blur-sm">
        <AlertTriangle size={16} />
        <span>
          Dashboard version is incompatible with the daemon (server protocol v{mismatch.serverVersion}, dashboard supports v{mismatch.clientRange.min}–{mismatch.clientRange.max}). Please reload.
        </span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="ml-2 inline-flex items-center gap-1 rounded-sm border border-white/30 px-2 py-0.5 text-[11px] text-white transition-colors hover:bg-white/10"
        >
          <RefreshCw size={12} />
          Reload
        </button>
      </div>
    );
  }

  // outdated_server: the daemon is older than the dashboard expects
  return (
    <div className="flex h-10 shrink-0 items-center justify-center gap-2 bg-status-warning/90 text-[12px] text-ink backdrop-blur-sm">
      <AlertTriangle size={16} />
      <span>
        Daemon protocol (v{mismatch.serverVersion}) is older than this dashboard expects (v{mismatch.clientRange.min}–{mismatch.clientRange.max}). Some features may not work. Update the daemon and reload.
      </span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="ml-2 inline-flex items-center gap-1 rounded-sm border border-ink/30 px-2 py-0.5 text-[11px] text-ink transition-colors hover:bg-ink/10"
      >
        <RefreshCw size={12} />
        Reload
      </button>
    </div>
  );
}

export function ConnectionBanner() {
  const status = useConnectionStore((state) => state.status);
  const reconnectAttempts = useConnectionStore((state) => state.reconnectAttempts);
  const protocolMismatch = useConnectionStore((state) => state.protocolMismatch);
  const [showSuccess, setShowSuccess] = useState(false);
  const prevStatusRef = useRef<ConnectionState["status"]>(status);

  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;

    if (status === "connected" && (prev === "reconnecting" || prev === "disconnected")) {
      setShowSuccess(true);
      const timer = setTimeout(() => setShowSuccess(false), 2000);
      return () => clearTimeout(timer);
    }

    if (status !== "connected") {
      setShowSuccess(false);
    }

    return undefined;
  }, [status]);

  // Protocol mismatch takes priority over connection status banners
  if (protocolMismatch) {
    return <ProtocolMismatchBanner />;
  }

  if (status === "connected" && !showSuccess) {
    return null;
  }

  if (status === "connecting") {
    return null;
  }

  if (showSuccess) {
    return (
      <div className="flex h-10 shrink-0 items-center justify-center gap-2 bg-emerald-600/90 text-[12px] text-white backdrop-blur-sm">
        <Wifi size={16} />
        <span>Connected</span>
      </div>
    );
  }

  const isError = status === "disconnected" || reconnectAttempts >= MAX_RECONNECT_BEFORE_ERROR;

  if (isError) {
    return (
      <div className="flex h-10 shrink-0 items-center justify-center gap-2 bg-status-error/90 text-[12px] text-white backdrop-blur-sm">
        <WifiOff size={16} />
        <span>Unable to connect to daemon</span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="ml-2 inline-flex items-center gap-1 rounded-sm border border-white/30 px-2 py-0.5 text-[11px] text-white transition-colors hover:bg-white/10"
        >
          <RefreshCw size={12} />
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-10 shrink-0 items-center justify-center gap-2 bg-status-warning/90 text-[12px] text-ink backdrop-blur-sm">
      <RefreshCw size={16} className="animate-spin" />
      <span>Connection lost. Reconnecting...</span>
    </div>
  );
}
