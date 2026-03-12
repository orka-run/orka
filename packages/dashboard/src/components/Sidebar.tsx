// UI patterns inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import { useId, useState } from "react";
import { Plus, Search } from "lucide-react";
import type { SessionSummary } from "../stores/sessionStore";
import { formatRelativeTime, getSessionGroup } from "../lib/sessionUi";

interface SidebarProps {
  sessions: SessionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewSession: () => void;
}

interface SessionGroup {
  key: "running" | "completed" | "failed";
  label: string;
  sessions: SessionSummary[];
}

const GROUP_ORDER: Array<SessionGroup["key"]> = ["running", "completed", "failed"];
const GROUP_LABELS: Record<SessionGroup["key"], string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

export function Sidebar({ sessions, selectedId, onSelect, onNewSession }: SidebarProps) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const now = Date.now();
  const runningCount = sessions.filter((session) => getSessionGroup(session.status) === "running").length;
  const filteredSessions = sessions.filter((session) => matchesQuery(session, normalizedQuery));
  const groups = GROUP_ORDER.map((key) => ({
    key,
    label: GROUP_LABELS[key],
    sessions: filteredSessions.filter((session) => getSessionGroup(session.status) === key),
  })).filter((group) => group.sessions.length > 0);

  return (
    <aside className="flex w-80 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
      <div className="border-b border-zinc-800 px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">orka</h1>
            <p className="mt-1 text-xs text-zinc-500">
              {runningCount} active / {sessions.length} total
            </p>
          </div>
          <button
            type="button"
            onClick={onNewSession}
            className="inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-950 transition hover:bg-white"
          >
            <Plus className="h-4 w-4" />
            New Session
          </button>
        </div>
        <div className="relative mt-4">
          <label htmlFor={searchId} className="sr-only">
            Search sessions
          </label>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sessions"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-2 pl-9 pr-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-zinc-700"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-4">
        {groups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/60 px-4 py-8 text-center">
            <p className="text-sm font-medium text-zinc-200">
              {sessions.length === 0 ? "No sessions yet" : "No sessions match"}
            </p>
            <p className="mt-2 text-sm text-zinc-500">
              {sessions.length === 0
                ? "Create a new session to start streaming work here."
                : "Adjust the search input to see more sessions."}
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <section key={group.key}>
                <div className="mb-2 flex items-center justify-between px-1">
                  <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
                    {group.label}
                  </h2>
                  <span className="text-xs text-zinc-600">{group.sessions.length}</span>
                </div>
                <ul className="space-y-2">
                  {group.sessions.map((session) => {
                    const isSelected = selectedId === session.id;

                    return (
                      <li key={session.id}>
                        <button
                          type="button"
                          onClick={() => onSelect(session.id)}
                          className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                            isSelected
                              ? "border-zinc-700 bg-zinc-900 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]"
                              : "border-zinc-900 bg-zinc-950 hover:border-zinc-800 hover:bg-zinc-900/70"
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-3">
                              <p className="truncate text-sm font-medium text-zinc-100">
                                {session.title || session.id}
                              </p>
                              <span className="shrink-0 text-xs text-zinc-500">
                                {formatRelativeTime(session.createdAt, now)}
                              </span>
                            </div>
                            <div className="mt-2 flex items-center gap-2">
                              <span className="rounded-full border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-300">
                                {session.backend}
                              </span>
                              <StatusPill status={session.status} />
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function matchesQuery(session: SessionSummary, query: string): boolean {
  if (!query) {
    return true;
  }

  const haystack = [session.id, session.title, session.backend, session.status, session.model ?? ""]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

const STATUS_CONFIG: Record<
  SessionSummary["status"],
  { dotClass: string; label?: string }
> = {
  running: { dotClass: "bg-emerald-400 animate-pulse", label: "Running" },
  queued: { dotClass: "bg-sky-400 animate-pulse", label: "Queued" },
  preparing: { dotClass: "bg-sky-400 animate-pulse", label: "Preparing" },
  completed: { dotClass: "bg-zinc-500" },
  failed: { dotClass: "bg-red-400", label: "Failed" },
  cancelled: { dotClass: "bg-amber-400" },
};

function StatusPill({ status }: { status: SessionSummary["status"] }) {
  const config = STATUS_CONFIG[status] ?? { dotClass: "bg-zinc-500" };
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${config.dotClass}`} />
      {config.label && (
        <span className="text-[11px] text-zinc-400">{config.label}</span>
      )}
    </span>
  );
}
