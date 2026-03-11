import { useState } from "react";
import { DiffPanel } from "./DiffPanel";

interface SessionViewProps {
  sessionId: string;
}

export function SessionView({ sessionId }: SessionViewProps) {
  const [activeTab, setActiveTab] = useState<"overview" | "diff">("diff");

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-zinc-800 px-6 py-3">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-mono text-zinc-400">{sessionId}</h2>
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
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-sm text-zinc-500">
              Session detail view — log streaming, terminal, and controls will be added here.
            </p>
          </div>
        ) : (
          <DiffPanel sessionId={sessionId} />
        )}
      </div>
    </div>
  );
}
