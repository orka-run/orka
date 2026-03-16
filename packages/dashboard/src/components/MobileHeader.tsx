import { useConnectionStore } from "../stores/connectionStore";

interface MobileHeaderProps {
  title?: string | null;
}

const STATUS_DOT: Record<string, string> = {
  connected: "bg-emerald-600",
  connecting: "bg-amber-500",
  reconnecting: "bg-amber-500",
  disconnected: "bg-status-error",
};

export function MobileHeader({ title }: MobileHeaderProps) {
  const status = useConnectionStore((s) => s.status);
  const dotClass = STATUS_DOT[status] ?? "bg-ink-muted";

  return (
    <header className={`flex items-center gap-2 border-b px-2 py-0.5 safe-area-top ${status === "connected" ? "border-border bg-surface" : "border-status-warning/30 bg-status-warning/5"}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-sm ${dotClass}`} title={status} />
      <p className="min-w-0 flex-1 truncate text-[11px] text-ink-secondary">
        {title ?? "orka"}
      </p>
    </header>
  );
}
