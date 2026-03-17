// Attribution: Diff panel concept inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileDiff, LoaderCircle, RefreshCw } from "lucide-react";
import type { DiffResult } from "@orka/core";
import { parseDiff, type DiffFile, type DiffLine } from "../lib/parseDiff";
import { useRpcClient } from "../lib/transportContext";
import { useSessionStore } from "../stores/sessionStore";

interface DiffPanelProps {
  sessionId: string;
  onSelectionLoadSettled?: (status: "ok" | "error", error?: unknown) => void;
}

const ACTIVE_STATUSES = new Set(["queued", "preparing", "running"]);
const AUTO_REFRESH_MS = 5_000;

export function DiffPanel({ sessionId, onSelectionLoadSettled }: DiffPanelProps) {
  const client = useRpcClient();
  const queryClient = useQueryClient();
  const session = useSessionStore((state) => state.sessions.find((s) => s.id === sessionId));
  const isActive = session ? ACTIVE_STATUSES.has(session.status) : false;

  const diffQuery = useQuery({
    queryKey: ["session-diff", sessionId],
    queryFn: () => client.getDiff(sessionId),
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
      <div className="flex h-full items-center justify-center rounded-sm border border-border bg-surface">
        <div className="flex items-center gap-2 text-[12px] text-ink-muted">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Loading diff…
        </div>
      </div>
    );
  }

  if (diffQuery.isError) {
    return (
      <div className="space-y-2">
        <RefreshBar isActive={isActive} isFetching={diffQuery.isFetching} onRefresh={handleRefresh} />
        <div className="rounded-sm border border-status-error/30 bg-status-error/10 p-2 text-[12px] text-status-error">
          <p className="font-medium">Unable to load worktree diff.</p>
          <p className="mt-1 opacity-80">
            {diffQuery.error instanceof Error ? diffQuery.error.message : "Unknown error"}
          </p>
        </div>
      </div>
    );
  }

  const status = diffQuery.data?.status.trim() ?? "";

  if (!diffQuery.data?.diff.trim()) {
    return (
      <div className="space-y-2">
        <RefreshBar isActive={isActive} isFetching={diffQuery.isFetching} onRefresh={handleRefresh} />
        {status ? <StatusBlock status={status} /> : null}
        <div className="flex min-h-48 flex-col items-center justify-center rounded-sm border border-dashed border-border bg-surface px-4 py-8 text-center">
          <FileDiff className="h-8 w-8 text-ink-muted" />
          <p className="mt-2 text-[12px] font-medium text-ink-secondary">No changes</p>
          <p className="mt-1 max-w-md text-[11px] text-ink-muted">
            This session worktree is clean. New edits will appear here once files change.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <RefreshBar isActive={isActive} isFetching={diffQuery.isFetching} onRefresh={handleRefresh} />
      {status ? <StatusBlock status={status} /> : null}
      <div className="space-y-2">
        {files.map((file) => {
          const key = getFileKey(file);
          const isCollapsed = collapsedFiles[key] ?? false;
          const fileSummary = summarizeFile(file);

          return (
            <section
              key={key}
              className="overflow-hidden rounded-sm border border-border bg-surface"
            >
              <button
                type="button"
                onClick={() =>
                  setCollapsedFiles((previous) => ({
                    ...previous,
                    [key]: !isCollapsed,
                  }))
                }
                className="flex w-full items-center justify-between gap-2 border-b border-border px-2 py-1.5 text-left"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {isCollapsed ? (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                  )}
                  <div className="min-w-0">
                    <p
                      className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] text-ink-secondary"
                      style={{ direction: "rtl", textAlign: "left" }}
                      title={getFileLabel(file)}
                    >
                      <bdi>{getFileLabel(file)}</bdi>
                    </p>
                    <p className="mt-0.5 font-mono text-[10px] text-ink-muted">
                      --- {file.oldPath || "/dev/null"}  +++ {file.newPath || "/dev/null"}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 font-mono text-[10px]">
                  <span className="rounded-sm bg-emerald-600/10 px-1.5 py-0.5 text-emerald-700">
                    +{fileSummary.additions}
                  </span>
                  <span className="rounded-sm bg-status-error/10 px-1.5 py-0.5 text-status-error">
                    -{fileSummary.removals}
                  </span>
                </div>
              </button>
              {isCollapsed ? null : (
                <div className="overflow-x-auto">
                  {file.hunks.length === 0 ? (
                    <div className="px-2 py-2 font-mono text-[11px] text-ink-muted">
                      Binary or metadata-only diff.
                    </div>
                  ) : (
                    file.hunks.map((hunk) => (
                      <div key={`${key}-${hunk.header}`} className="border-t border-border first:border-t-0">
                        <div className="bg-surface-alt px-2 py-1 font-mono text-[10px] text-accent-strong">
                          {hunk.header}
                        </div>
                        <div className="font-mono text-[11px]">
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
      <p className="text-[10px] text-ink-muted">
        {isActive ? "Auto-refreshing while session is active" : "Session finished"}
      </p>
      <button
        type="button"
        onClick={onRefresh}
        disabled={isFetching}
        className="flex items-center gap-1 rounded-sm border border-border bg-surface-alt px-2 py-1 text-[10px] text-ink-muted transition hover:border-ink-muted hover:text-ink-secondary disabled:opacity-50"
      >
        <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
        Refresh
      </button>
    </div>
  );
}

function StatusBlock({ status }: { status: string }) {
  return (
    <div className="rounded-sm border border-border bg-surface p-2">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-ink-muted">
        Git Status
      </p>
      <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-6 text-ink-secondary">
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
      <span className="border-r border-border/50 px-1 py-0.5 text-right text-[10px] text-ink-muted md:px-2 md:text-[11px]">
        {line.oldLineNumber ?? ""}
      </span>
      <span className="border-r border-border/50 px-1 py-0.5 text-right text-[10px] text-ink-muted md:px-2 md:text-[11px]">
        {line.newLineNumber ?? ""}
      </span>
      <span className="border-r border-border/50 px-1 py-0.5 text-center text-[10px] text-ink-muted md:px-2 md:text-[11px]">{marker}</span>
      <span className="px-2 py-0.5 whitespace-pre-wrap break-all text-ink md:px-3">{line.content}</span>
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
      return "bg-emerald-600/5";
    case "remove":
      return "bg-status-error/5";
    default:
      return "bg-transparent";
  }
}
