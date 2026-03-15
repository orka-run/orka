// Attribution: Diff panel concept inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileDiff, LoaderCircle, RefreshCw } from "lucide-react";
import type { DiffResult } from "@orka/core";
import { parseDiff, type DiffFile, type DiffLine } from "../lib/parseDiff";
import { useTransport } from "../lib/transportContext";
import { useSessionStore } from "../stores/sessionStore";

interface DiffPanelProps {
  sessionId: string;
  onSelectionLoadSettled?: (status: "ok" | "error", error?: unknown) => void;
}

const ACTIVE_STATUSES = new Set(["queued", "preparing", "running"]);
const AUTO_REFRESH_MS = 5_000;

export function DiffPanel({ sessionId, onSelectionLoadSettled }: DiffPanelProps) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const session = useSessionStore((state) => state.sessions.find((s) => s.id === sessionId));
  const isActive = session ? ACTIVE_STATUSES.has(session.status) : false;

  const diffQuery = useQuery({
    queryKey: ["session-diff", sessionId],
    queryFn: () => transport.request<DiffResult>("getDiff", { sessionId }),
    refetchInterval: isActive ? AUTO_REFRESH_MS : false,
  });

  useEffect(() => {
    if (diffQuery.isSuccess) {
      onSelectionLoadSettled?.("ok");
    } else if (diffQuery.isError) {
      onSelectionLoadSettled?.("error", diffQuery.error);
    }
  }, [diffQuery.error, diffQuery.isError, diffQuery.isSuccess, onSelectionLoadSettled]);

  const files = parseDiff(diffQuery.data?.diff ?? "");
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setCollapsedFiles((previous) => {
      const nextState: Record<string, boolean> = {};

      for (const file of files) {
        const key = getFileKey(file);
        nextState[key] = previous[key] ?? false;
      }

      return nextState;
    });
  }, [diffQuery.data?.diff]);

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["session-diff", sessionId] });
  };

  if (diffQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950/50">
        <div className="flex items-center gap-3 text-sm text-zinc-400">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Loading diff…
        </div>
      </div>
    );
  }

  if (diffQuery.isError) {
    return (
      <div className="space-y-3">
        <RefreshBar isActive={isActive} isFetching={diffQuery.isFetching} onRefresh={handleRefresh} />
        <div className="rounded-xl border border-red-950 bg-red-950/20 p-4 text-sm text-red-200">
          <p className="font-medium">Unable to load worktree diff.</p>
          <p className="mt-1 text-red-200/80">
            {diffQuery.error instanceof Error ? diffQuery.error.message : "Unknown error"}
          </p>
        </div>
      </div>
    );
  }

  const status = diffQuery.data?.status.trim() ?? "";

  if (!diffQuery.data?.diff.trim()) {
    return (
      <div className="space-y-4">
        <RefreshBar isActive={isActive} isFetching={diffQuery.isFetching} onRefresh={handleRefresh} />
        {status ? <StatusBlock status={status} /> : null}
        <div className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-6 py-10 text-center">
          <FileDiff className="h-8 w-8 text-zinc-600" />
          <p className="mt-4 text-sm font-medium text-zinc-300">No changes</p>
          <p className="mt-2 max-w-md text-sm text-zinc-500">
            This session worktree is clean. New edits will appear here once files change.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <RefreshBar isActive={isActive} isFetching={diffQuery.isFetching} onRefresh={handleRefresh} />
      {status ? <StatusBlock status={status} /> : null}
      <div className="space-y-3">
        {files.map((file) => {
          const key = getFileKey(file);
          const isCollapsed = collapsedFiles[key] ?? false;
          const fileSummary = summarizeFile(file);

          return (
            <section
              key={key}
              className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/70"
            >
              <button
                type="button"
                onClick={() =>
                  setCollapsedFiles((previous) => ({
                    ...previous,
                    [key]: !isCollapsed,
                  }))
                }
                className="flex w-full items-center justify-between gap-4 border-b border-zinc-800 px-3 py-3.5 text-left md:px-4 md:py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  {isCollapsed ? (
                    <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" />
                  ) : (
                    <ChevronDown className="h-4 w-4 shrink-0 text-zinc-500" />
                  )}
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm text-zinc-200">{getFileLabel(file)}</p>
                    <p className="mt-1 font-mono text-xs text-zinc-500">
                      --- {file.oldPath || "/dev/null"}  +++ {file.newPath || "/dev/null"}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3 font-mono text-xs">
                  <span className="rounded-full bg-emerald-950/60 px-2 py-1 text-emerald-300">
                    +{fileSummary.additions}
                  </span>
                  <span className="rounded-full bg-red-950/60 px-2 py-1 text-red-300">
                    -{fileSummary.removals}
                  </span>
                </div>
              </button>
              {isCollapsed ? null : (
                <div className="overflow-x-auto">
                  {file.hunks.length === 0 ? (
                    <div className="px-4 py-4 font-mono text-sm text-zinc-500">
                      Binary or metadata-only diff.
                    </div>
                  ) : (
                    file.hunks.map((hunk) => (
                      <div key={`${key}-${hunk.header}`} className="border-t border-zinc-900 first:border-t-0">
                        <div className="bg-zinc-900/80 px-4 py-2 font-mono text-xs text-sky-300">
                          {hunk.header}
                        </div>
                        <div className="font-mono text-sm">
                          {hunk.lines.map((line, index) => (
                            <DiffLineRow
                              key={`${key}-${hunk.header}-${index}`}
                              line={line}
                            />
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function RefreshBar({
  isActive,
  isFetching,
  onRefresh,
}: {
  isActive: boolean;
  isFetching: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <p className="text-xs text-zinc-500">
        {isActive ? "Auto-refreshing while session is active" : "Session finished"}
      </p>
      <button
        type="button"
        onClick={onRefresh}
        disabled={isFetching}
        className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200 disabled:opacity-50"
      >
        <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
        Refresh
      </button>
    </div>
  );
}

function StatusBlock({ status }: { status: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
        Git Status
      </p>
      <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-6 text-zinc-300">
        {status}
      </pre>
    </div>
  );
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const lineClassName = getLineClassName(line.type);
  const marker = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";

  return (
    <div className={`grid min-w-full grid-cols-[2.5rem_2.5rem_1.25rem_minmax(0,1fr)] md:grid-cols-[4rem_4rem_1.5rem_minmax(0,1fr)] ${lineClassName}`}>
      <span className="border-r border-zinc-900/80 px-1 py-1 text-right text-xs text-zinc-500 md:px-2 md:text-sm">
        {line.oldLineNumber ?? ""}
      </span>
      <span className="border-r border-zinc-900/80 px-1 py-1 text-right text-xs text-zinc-500 md:px-2 md:text-sm">
        {line.newLineNumber ?? ""}
      </span>
      <span className="border-r border-zinc-900/80 px-1 py-1 text-center text-xs text-zinc-500 md:px-2 md:text-sm">{marker}</span>
      <span className="px-2 py-1 whitespace-pre-wrap break-all text-zinc-100 md:px-3">{line.content}</span>
    </div>
  );
}

function getFileKey(file: DiffFile): string {
  return `${file.oldPath}->${file.newPath}`;
}

function getFileLabel(file: DiffFile): string {
  if (file.oldPath === "/dev/null") {
    return `${file.newPath} (new)`;
  }

  if (file.newPath === "/dev/null") {
    return `${file.oldPath} (deleted)`;
  }

  if (file.oldPath !== file.newPath) {
    return `${file.oldPath} -> ${file.newPath}`;
  }

  return file.newPath;
}

function summarizeFile(file: DiffFile): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;

  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add") {
        additions += 1;
      } else if (line.type === "remove") {
        removals += 1;
      }
    }
  }

  return { additions, removals };
}

function getLineClassName(type: DiffLine["type"]): string {
  switch (type) {
    case "add":
      return "bg-emerald-950/30";
    case "remove":
      return "bg-red-950/30";
    default:
      return "bg-transparent";
  }
}
