import { Menu } from "lucide-react";
import { useConnectionStore } from "../stores/connectionStore";

interface MobileHeaderProps {
  title?: string | null;
  onToggleSidebar: () => void;
}

const STATUS_DOT: Record<string, string> = {
  connected: "bg-emerald-600",
  connecting: "bg-amber-500",
  reconnecting: "bg-amber-500",
  disconnected: "bg-status-error",
};

export function MobileHeader({ title, onToggleSidebar }: MobileHeaderProps) {
  const status = useConnectionStore((s) => s.status);
  const dotClass = STATUS_DOT[status] ?? "bg-ink-muted";

  return (
    <header className="flex items-center gap-2 border-b border-border bg-surface px-2 py-1 safe-area-top">
      <button
        type="button"
        onClick={onToggleSidebar}
        className="tap-target inline-flex items-center justify-center rounded-sm text-ink-muted transition hover:text-ink"
        aria-label="Open sessions sidebar"
      >
        <Menu className="h-5 w-5" />
      </button>
      <p className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
        {title ?? "orka"}
      </p>
      <span className={`h-2 w-2 shrink-0 rounded-sm ${dotClass}`} title={status} />
    </header>
  );
}
