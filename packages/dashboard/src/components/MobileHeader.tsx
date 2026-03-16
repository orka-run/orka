import { Menu } from "lucide-react";
import { useConnectionStore } from "../stores/connectionStore";

interface MobileHeaderProps {
  title?: string | null;
  onToggleSidebar: () => void;
}

const STATUS_DOT: Record<string, string> = {
  connected: "bg-emerald-400",
  connecting: "bg-amber-400",
  reconnecting: "bg-amber-400",
  disconnected: "bg-red-400",
};

export function MobileHeader({ title, onToggleSidebar }: MobileHeaderProps) {
  const status = useConnectionStore((s) => s.status);
  const dotClass = STATUS_DOT[status] ?? "bg-zinc-500";

  return (
    <header className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-950 px-3 py-2 safe-area-top">
      <button
        type="button"
        onClick={onToggleSidebar}
        className="tap-target inline-flex items-center justify-center rounded-lg text-zinc-400 transition hover:text-zinc-100"
        aria-label="Open sessions sidebar"
      >
        <Menu className="h-5 w-5" />
      </button>
      <p className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">
        {title ?? "orka"}
      </p>
      <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} title={status} />
    </header>
  );
}
