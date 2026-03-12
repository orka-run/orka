import { useEffect, useRef, useState } from "react";
import { Wifi, WifiOff, RefreshCw } from "lucide-react";
import { useConnectionStore, type ConnectionState } from "../stores/connectionStore";

const MAX_RECONNECT_BEFORE_ERROR = 3;

export function ConnectionBanner() {
  const status = useConnectionStore((state) => state.status);
  const reconnectAttempts = useConnectionStore((state) => state.reconnectAttempts);
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

  if (status === "connected" && !showSuccess) {
    return null;
  }

  if (status === "connecting") {
    return null;
  }

  if (showSuccess) {
    return (
      <div className="fixed inset-x-0 top-0 z-50 flex h-10 items-center justify-center gap-2 bg-emerald-900/90 text-sm text-emerald-200 backdrop-blur-sm">
        <Wifi size={16} />
        <span>Connected</span>
      </div>
    );
  }

  const isError = status === "disconnected" || reconnectAttempts >= MAX_RECONNECT_BEFORE_ERROR;

  if (isError) {
    return (
      <div className="fixed inset-x-0 top-0 z-50 flex h-10 items-center justify-center gap-2 bg-red-900/90 text-sm text-red-200 backdrop-blur-sm">
        <WifiOff size={16} />
        <span>Unable to connect to daemon</span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="ml-2 inline-flex items-center gap-1 rounded border border-red-700 px-2 py-0.5 text-xs text-red-200 transition-colors hover:bg-red-800"
        >
          <RefreshCw size={12} />
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-x-0 top-0 z-50 flex h-10 items-center justify-center gap-2 bg-amber-900/90 text-sm text-amber-200 backdrop-blur-sm">
      <RefreshCw size={16} className="animate-spin" />
      <span>Connection lost. Reconnecting...</span>
    </div>
  );
}
