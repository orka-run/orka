import { Eye, FileCode2, LayoutList, MessageSquare, ScrollText } from "lucide-react";

export type MobileSessionTab = "chat" | "logs" | "diff" | "overview";

interface MobileTabBarProps {
  hasSelectedSession: boolean;
  activeTab: MobileSessionTab;
  onTabChange: (tab: MobileSessionTab) => void;
  onShowSessions: () => void;
}

const SESSION_TABS: { id: MobileSessionTab; label: string; icon: typeof MessageSquare }[] = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "logs", label: "Logs", icon: ScrollText },
  { id: "diff", label: "Diff", icon: FileCode2 },
  { id: "overview", label: "Info", icon: Eye },
];

export function MobileTabBar({
  hasSelectedSession,
  activeTab,
  onTabChange,
  onShowSessions,
}: MobileTabBarProps) {
  return (
    <nav className="border-t border-zinc-800 bg-zinc-950 safe-area-bottom">
      <div className="flex items-stretch justify-around">
        {/* Sessions button — always visible, opens sidebar drawer */}
        <button
          type="button"
          onClick={onShowSessions}
          className="tap-target flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[10px] font-medium text-zinc-500 transition active:text-zinc-300"
        >
          <LayoutList className="h-5 w-5" />
          Sessions
        </button>

        {/* Session-content tabs — only active when a session is selected */}
        {SESSION_TABS.map(({ id, label, icon: Icon }) => {
          const isActive = hasSelectedSession && activeTab === id;
          const disabled = !hasSelectedSession;
          return (
            <button
              key={id}
              type="button"
              onClick={() => { if (!disabled) onTabChange(id); }}
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
