interface SessionViewProps {
  sessionId: string;
}

export function SessionView({ sessionId }: SessionViewProps) {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-zinc-800 px-6 py-3">
        <h2 className="text-sm font-mono text-zinc-400">{sessionId}</h2>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-sm text-zinc-500">
            Session detail view — log streaming, terminal, and controls will be added here.
          </p>
        </div>
      </div>
    </div>
  );
}
