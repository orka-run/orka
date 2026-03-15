import { LayoutList, MessageSquare, FileCode2, ScrollText, Settings } from "lucide-react";

export type MobileTab = "sessions" | "chat" | "diff" | "logs" | "settings";

interface MobileTabBarProps {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
  hasActiveSession: boolean;
}

const TABS: { id: MobileTab; label: string; icon: typeof LayoutList }[] = [
  { id: "sessions", label: "Sessions", icon: LayoutList },
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "diff", label: "Diff", icon: FileCode2 },
  { id: "logs", label: "Logs", icon: ScrollText },
  { id: "settings", label: "Settings", icon: Settings },
];

export function MobileTabBar({ activeTab, onTabChange, hasActiveSession }: MobileTabBarProps) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-800 bg-zinc-950 safe-area-bottom">
      <div className="flex items-stretch justify-around">
        {TABS.map(({ id, label, icon: Icon }) => {
          const isActive = activeTab === id;
          const disabled = id !== "sessions" && id !== "settings" && !hasActiveSession;

          return (
            <button
              key={id}
              type="button"
              onClick={() => onTabChange(id)}
              disabled={disabled}
              className={`tap-target flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[10px] font-medium transition ${
                isActive
                  ? "text-zinc-100"
                  : disabled
                    ? "text-zinc-700"
                    : "text-zinc-500 active:text-zinc-300"
              }`}
            >
              <Icon className="h-5 w-5" />
              {label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
