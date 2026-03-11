interface StatusBarProps {
  sessionCount: number;
}

export function StatusBar({ sessionCount }: StatusBarProps) {
  return (
    <footer className="flex items-center justify-between border-t border-zinc-800 bg-zinc-900 px-4 py-1.5 text-xs text-zinc-500">
      <span>{sessionCount} session{sessionCount !== 1 ? "s" : ""}</span>
      <span>orka dashboard</span>
    </footer>
  );
}
