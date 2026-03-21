import { useEffect, useRef, useCallback } from "react";
import { Pin, PinOff, Square, Shield, ShieldOff, Trash2, Copy } from "lucide-react";
import type { SessionSummary } from "../stores/sessionStore";

export interface ContextMenuPosition {
  x: number;
  y: number;
}

export interface SessionContextMenuProps {
  session: SessionSummary;
  position: ContextMenuPosition;
  isPinned: boolean;
  onClose: () => void;
  onTogglePin: () => void;
  onStop: () => void;
  onToggleKept: () => void;
  onDelete: () => void;
  onCopyId: () => void;
}

function isRunning(status: SessionSummary["status"]): boolean {
  return status === "running" || status === "queued" || status === "preparing" || status === "rate_limited";
}

interface MenuItem {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}

export function SessionContextMenu({
  session,
  position,
  isPinned,
  onClose,
  onTogglePin,
  onStop,
  onToggleKept,
  onDelete,
  onCopyId,
}: SessionContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const running = isRunning(session.status);

  // Build menu items based on session state
  const items: MenuItem[] = [];

  if (running) {
    items.push({
      icon: <Square className="h-3.5 w-3.5" />,
      label: "Stop",
      onClick: onStop,
      destructive: true,
    });
  }

  items.push({
    icon: isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />,
    label: isPinned ? "Unpin" : "Pin",
    onClick: onTogglePin,
  });

  if (running) {
    items.push({
      icon: session.kept ? <ShieldOff className="h-3.5 w-3.5" /> : <Shield className="h-3.5 w-3.5" />,
      label: session.kept ? "Unkeep" : "Keep",
      onClick: onToggleKept,
    });
  }

  if (!running) {
    items.push({
      icon: <Trash2 className="h-3.5 w-3.5" />,
      label: "Delete",
      onClick: onDelete,
      destructive: true,
    });
  }

  items.push({
    icon: <Copy className="h-3.5 w-3.5" />,
    label: "Copy ID",
    onClick: onCopyId,
  });

  // Position menu within viewport
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw) {
      menu.style.left = `${Math.max(4, position.x - rect.width)}px`;
    }
    if (rect.bottom > vh) {
      menu.style.top = `${Math.max(4, position.y - rect.height)}px`;
    }
  }, [position]);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const isMobile = "ontouchstart" in window;

  return (
    <div
      className={`fixed inset-0 z-50 ${isMobile ? "bg-black/20" : ""}`}
      onClick={handleBackdropClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={menuRef}
        className="fixed min-w-[140px] rounded-md border border-border bg-surface py-1 shadow-lg"
        style={{ left: position.x, top: position.y }}
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => {
              item.onClick();
              onClose();
            }}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition hover:bg-surface-alt ${
              item.destructive ? "text-red-400 hover:text-red-300" : "text-ink-secondary hover:text-ink"
            }`}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
