import { Square, LoaderCircle } from "lucide-react";
import { useConnectionStore } from "../stores/connectionStore";
import { useNotificationStore } from "../stores/notificationStore";

interface MobileHeaderProps {
  title?: string | null;
  isStoppable?: boolean;
  isStopping?: boolean;
  onStop?: () => void;
}

const STATUS_DOT: Record<string, string> = {
  connected: "bg-emerald-600",
  connecting: "bg-amber-500",
  reconnecting: "bg-amber-500",
  disconnected: "bg-status-error",
};

export function MobileHeader({ title, isStoppable, isStopping, onStop }: MobileHeaderProps) {
  const status = useConnectionStore((s) => s.status);
  const pendingCount = useNotificationStore((s) => s.pendingCount);
  const dotClass = STATUS_DOT[status] ?? "bg-ink-muted";
  const hasPending = pendingCount > 0;

  return (
    <header className={`flex items-center gap-2 border-b px-2 py-0.5 safe-area-top ${status === "connected" ? "border-border bg-surface" : "border-status-warning/30 bg-status-warning/5"}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-sm ${dotClass} ${hasPending ? "animate-pulse" : ""}`} title={status} />
      <p className="min-w-0 flex-1 truncate text-[11px] text-ink-secondary">
        {title ?? "orka"}
      </p>
      {hasPending && (
        <span className="flex h-4 w-4 items-center justify-center rounded-sm bg-status-warning text-[9px] font-bold text-white">
          {pendingCount}
        </span>
      )}
      {isStoppable && onStop && (
        <button
          type="button"
          onClick={onStop}
          disabled={isStopping}
          className="inline-flex items-center justify-center p-1 text-status-error transition active:opacity-70 disabled:opacity-50"
          aria-label="Stop session"
        >
          {isStopping ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
        </button>
      )}
    </header>
  );
}
