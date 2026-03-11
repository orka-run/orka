// UI patterns inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import { useState } from "react";
import { ChatView } from "./ChatView";
import { DiffPanel } from "./DiffPanel";
import { formatDateTime, formatDuration } from "../lib/sessionUi";
import { useSessionStore } from "../stores/sessionStore";

interface SessionViewProps {
  sessionId: string;
}

export function SessionView({ sessionId }: SessionViewProps) {
  const [activeTab, setActiveTab] = useState<"overview" | "chat" | "diff">("chat");
  const session = useSessionStore((state) => state.sessions.find((item) => item.id === sessionId) ?? null);

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        Session metadata is unavailable.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-zinc-800 px-6 py-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-lg font-semibold text-zinc-100">{session.title}</p>
            <p className="mt-1 text-sm font-mono text-zinc-500">{sessionId}</p>
          </div>
          <div className="flex rounded-lg border border-zinc-800 bg-zinc-900 p-1">
            <button
              type="button"
              onClick={() => setActiveTab("overview")}
              className={`rounded-md px-3 py-1.5 text-sm ${
                activeTab === "overview"
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 transition hover:text-zinc-200"
              }`}
            >
              Overview
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("chat")}
              className={`rounded-md px-3 py-1.5 text-sm ${
                activeTab === "chat"
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 transition hover:text-zinc-200"
              }`}
            >
              Chat
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("diff")}
              className={`rounded-md px-3 py-1.5 text-sm ${
                activeTab === "diff"
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 transition hover:text-zinc-200"
              }`}
            >
              Diff
            </button>
          </div>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === "overview" ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(18rem,1fr)]">
            <section className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Overview</p>
              <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                <MetadataItem label="Status" value={session.status} />
                <MetadataItem label="Backend" value={session.backend} />
                <MetadataItem label="Model" value={session.model ?? "Default"} />
                <MetadataItem label="Mode" value={session.mode} />
                <MetadataItem label="Created" value={formatDateTime(session.createdAt)} />
                <MetadataItem
                  label="Duration"
                  value={formatDuration(session.startedAt, session.finishedAt)}
                />
              </dl>
            </section>
            <section className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Paths</p>
              <dl className="mt-4 space-y-4">
                <MetadataItem label="Session ID" value={session.id} mono />
                <MetadataItem label="Task ID" value={session.taskId} mono />
                <MetadataItem label="Project Path" value={session.projectPath} mono />
              </dl>
            </section>
          </div>
        ) : activeTab === "chat" ? (
          <ChatView sessionId={sessionId} />
        ) : (
          <DiffPanel sessionId={sessionId} />
        )}
      </div>
    </div>
  );
}

function MetadataItem({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">{label}</dt>
      <dd className={`mt-2 text-sm text-zinc-100 ${mono ? "font-mono break-all" : ""}`}>{value}</dd>
    </div>
  );
}
