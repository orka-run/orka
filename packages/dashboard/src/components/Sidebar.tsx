import type { SessionSummary } from "../stores/sessionStore";

const STATUS_COLORS: Record<string, string> = {
  running: "bg-green-500",
  completed: "bg-zinc-500",
  failed: "bg-red-500",
  cancelled: "bg-yellow-500",
  preparing: "bg-blue-500",
  queued: "bg-zinc-600",
};

interface SidebarProps {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function Sidebar({ sessions, selectedId, onSelect }: SidebarProps) {
  const running = sessions.filter((s) => s.status === "running");
  const completed = sessions.filter((s) => s.status !== "running");

  return (
    <aside className="flex w-72 flex-col border-r border-zinc-800 bg-zinc-900">
      <div className="border-b border-zinc-800 px-4 py-3">
        <h1 className="text-lg font-semibold">orka</h1>
        <p className="text-xs text-zinc-500">
          {running.length} running / {sessions.length} total
        </p>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <p className="p-4 text-sm text-zinc-500">No sessions</p>
        ) : (
          <ul className="py-1">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => onSelect(s.id)}
                  className={`w-full px-4 py-2 text-left text-sm hover:bg-zinc-800 ${
                    selectedId === s.id ? "bg-zinc-800" : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${STATUS_COLORS[s.status] ?? "bg-zinc-600"}`} />
                    <span className="truncate font-medium">{s.title || s.id}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
                    <span>{s.backend}</span>
                    <span>·</span>
                    <span>{s.status}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
