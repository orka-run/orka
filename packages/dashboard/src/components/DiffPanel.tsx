// Attribution: Diff panel concept inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileDiff, LoaderCircle, RefreshCw, RotateCcw } from "lucide-react";
import type { Checkpoint } from "@orka/core";
import { parseDiff, type DiffFile, type DiffLine } from "../lib/parseDiff";
import { formatRelativeTime } from "../lib/sessionUi";
import { useRpcClient } from "../lib/transportContext";
import { useSessionStore } from "../stores/sessionStore";
import { highlightCode } from "../lib/syntaxHighlight";

interface DiffPanelProps {
  sessionId: string;
  onSelectionLoadSettled?: (status: "ok" | "error", error?: unknown) => void;
}

type DiffViewMode = "full" | "turn";
type FileChangeKind = "A" | "M" | "D";

interface TurnTransition {
  key: string;
  fromTurn: number;
  toTurn: number;
  status: Checkpoint["status"];
  createdAt: string;
  files: Checkpoint["files"];
  additions: number;
  deletions: number;
}

interface FileSidebarItem {
  key: string;
  path: string;
  label: string;
  kind: FileChangeKind;
  additions: number;
  deletions: number;
  diffFile: DiffFile | null;
}

const ACTIVE_STATUSES = new Set(["queued", "preparing", "running", "rate_limited"]);
const AUTO_REFRESH_MS = 5_000;
const VIEW_MODES: Array<{ id: DiffViewMode; label: string }> = [
  { id: "full", label: "Full Session" },
  { id: "turn", label: "Per Turn" },
];

export function DiffPanel({ sessionId, onSelectionLoadSettled }: DiffPanelProps) {
  const client = useRpcClient();
  const queryClient = useQueryClient();
  const session = useSessionStore((state) => state.sessions.find((item) => item.id === sessionId));
  const isActive = session ? ACTIVE_STATUSES.has(session.status) : false;
  const [viewMode, setViewMode] = useState<DiffViewMode>("full");
  const [selectedTurnSeq, setSelectedTurnSeq] = useState<number | null>(null);
  const [selectedFullFileKey, setSelectedFullFileKey] = useState<string | null>(null);
  const [selectedTurnFileKey, setSelectedTurnFileKey] = useState<string | null>(null);

  const fullDiffQuery = useQuery({
    queryKey: ["session-diff", sessionId],
    queryFn: () => client.getDiff(sessionId),
    refetchInterval: viewMode === "full" && isActive ? AUTO_REFRESH_MS : false,
    enabled: viewMode === "full",
  });

  const checkpointsQuery = useQuery({
    queryKey: ["session-checkpoints", sessionId],
    queryFn: () => client.getCheckpoints(sessionId),
    refetchInterval: viewMode === "turn" && isActive ? AUTO_REFRESH_MS : false,
    enabled: viewMode === "turn",
  });

  const checkpoints = [...(checkpointsQuery.data ?? [])].sort((left, right) => left.turnSeq - right.turnSeq);
  const turnTransitions = buildTurnTransitions(checkpoints);
  const turnSelectionSignature = turnTransitions.map((transition) => transition.key).join("|");

  useEffect(() => {
    setSelectedTurnSeq((current) =>
      turnTransitions.some((transition) => transition.toTurn === current)
        ? current
        : (turnTransitions.at(-1)?.toTurn ?? null),
    );
  }, [sessionId, turnSelectionSignature]);

  const selectedTransition =
    turnTransitions.find((transition) => transition.toTurn === selectedTurnSeq) ?? null;

  const turnDiffQuery = useQuery({
    queryKey: [
      "turn-diff",
      sessionId,
      selectedTransition?.fromTurn ?? -1,
      selectedTransition?.toTurn ?? -1,
    ],
    queryFn: () => {
      if (!selectedTransition) {
        throw new Error("No turn selected");
      }

      return client.getTurnDiff(sessionId, selectedTransition.fromTurn, selectedTransition.toTurn);
    },
    enabled: viewMode === "turn" && selectedTransition?.status === "ready",
  });

  useEffect(() => {
    if (viewMode === "full") {
      if (fullDiffQuery.isSuccess) {
        onSelectionLoadSettled?.("ok");
      } else if (fullDiffQuery.isError) {
        onSelectionLoadSettled?.("error", fullDiffQuery.error);
      }
      return;
    }

    if (checkpointsQuery.isError) {
      onSelectionLoadSettled?.("error", checkpointsQuery.error);
      return;
    }

    if (!checkpointsQuery.isSuccess) {
      return;
    }

    if (selectedTransition?.status === "ready") {
      if (turnDiffQuery.isSuccess) {
        onSelectionLoadSettled?.("ok");
      } else if (turnDiffQuery.isError) {
        onSelectionLoadSettled?.("error", turnDiffQuery.error);
      }
      return;
    }

    onSelectionLoadSettled?.("ok");
  }, [
    checkpointsQuery.error,
    checkpointsQuery.isError,
    checkpointsQuery.isSuccess,
    fullDiffQuery.error,
    fullDiffQuery.isError,
    fullDiffQuery.isSuccess,
    onSelectionLoadSettled,
    selectedTransition?.status,
    turnDiffQuery.error,
    turnDiffQuery.isError,
    turnDiffQuery.isSuccess,
    viewMode,
  ]);

  const fullDiffText = fullDiffQuery.data?.diff ?? "";
  const fullStatus = fullDiffQuery.data?.status.trim() ?? "";
  const fullFiles = parseDiff(fullDiffText);
  const fullFileItems = buildFileSidebarItems(fullFiles);
  const fullFileSelectionSignature = fullFileItems.map((item) => item.key).join("|");

  useEffect(() => {
    setSelectedFullFileKey((current) =>
      fullFileItems.some((item) => item.key === current) ? current : (fullFileItems[0]?.key ?? null),
    );
  }, [sessionId, fullFileSelectionSignature]);

  const turnDiffText = turnDiffQuery.data?.diff ?? "";
  const turnFiles = parseDiff(turnDiffText);
  const turnFileItems = buildFileSidebarItems(turnFiles, selectedTransition?.files ?? null);
  const turnFileSelectionSignature = turnFileItems.map((item) => item.key).join("|");

  useEffect(() => {
    setSelectedTurnFileKey((current) =>
      turnFileItems.some((item) => item.key === current) ? current : (turnFileItems[0]?.key ?? null),
    );
  }, [sessionId, selectedTransition?.key, turnFileSelectionSignature]);

  const activeFileItems = viewMode === "full" ? fullFileItems : turnFileItems;
  const selectedFileKey = viewMode === "full" ? selectedFullFileKey : selectedTurnFileKey;
  const selectedFile =
    activeFileItems.find((item) => item.key === selectedFileKey) ?? activeFileItems[0] ?? null;
  const activeDiffText = viewMode === "full" ? fullDiffText : turnDiffText;
  const isFetching =
    viewMode === "full"
      ? fullDiffQuery.isFetching
      : checkpointsQuery.isFetching || turnDiffQuery.isFetching;

  const handleRefresh = () => {
    if (viewMode === "full") {
      queryClient.invalidateQueries({ queryKey: ["session-diff", sessionId] });
      return;
    }

    queryClient.invalidateQueries({ queryKey: ["session-checkpoints", sessionId] });
    if (selectedTransition) {
      queryClient.invalidateQueries({
        queryKey: ["turn-diff", sessionId, selectedTransition.fromTurn, selectedTransition.toTurn],
      });
    }
  };

  const revertMutation = useMutation({
    mutationFn: ({ turnSeq, mode }: { turnSeq: number; mode: "files" | "files_and_conversation" }) =>
      client.revertSession(sessionId, turnSeq, mode),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["session-checkpoints", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["session-diff", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["session-detail", sessionId] });
    },
  });

  const handleRevert = (turnSeq: number, mode: "files" | "files_and_conversation") => {
    revertMutation.mutate({ turnSeq, mode });
  };

  if (viewMode === "full" && fullDiffQuery.isLoading) {
    return <LoadingState />;
  }

  if (viewMode === "turn" && checkpointsQuery.isLoading) {
    return <LoadingState />;
  }

  if (viewMode === "full" && fullDiffQuery.isError) {
    return (
      <div className="space-y-2">
        <Toolbar
          isActive={isActive}
          isFetching={isFetching}
          viewMode={viewMode}
          onRefresh={handleRefresh}
          onViewModeChange={setViewMode}
        />
        <ErrorState
          title="Unable to load worktree diff."
          error={fullDiffQuery.error}
        />
      </div>
    );
  }

  if (viewMode === "turn" && checkpointsQuery.isError) {
    return (
      <div className="space-y-2">
        <Toolbar
          isActive={isActive}
          isFetching={isFetching}
          viewMode={viewMode}
          onRefresh={handleRefresh}
          onViewModeChange={setViewMode}
        />
        <ErrorState
          title="Unable to load checkpoints."
          error={checkpointsQuery.error}
        />
      </div>
    );
  }

  const shouldShowFullSessionEmptyState =
    viewMode === "full" && !activeDiffText.trim() && activeFileItems.length === 0;

  return (
    <div className="space-y-2">
      <Toolbar
        isActive={isActive}
        isFetching={isFetching}
        viewMode={viewMode}
        onRefresh={handleRefresh}
        onViewModeChange={setViewMode}
      />
      {viewMode === "full" && fullStatus ? <StatusBlock status={fullStatus} /> : null}
      {viewMode === "turn" ? (
        <TurnTimeline
          transitions={turnTransitions}
          selectedTurnSeq={selectedTransition?.toTurn ?? null}
          onSelectTurn={setSelectedTurnSeq}
          onRevert={handleRevert}
          isReverting={revertMutation.isPending}
        />
      ) : null}
      {viewMode === "turn" && turnTransitions.length === 0 ? <NoTurnDiffsState /> : null}
      {shouldShowFullSessionEmptyState ? <NoChangesState /> : null}
      {!shouldShowFullSessionEmptyState && !(viewMode === "turn" && turnTransitions.length === 0) ? (
        <div className="grid gap-2 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <FilesSidebar
            files={activeFileItems}
            selectedFileKey={selectedFile?.key ?? null}
            onSelectFile={viewMode === "full" ? setSelectedFullFileKey : setSelectedTurnFileKey}
          />
          <DiffViewer
            diffText={activeDiffText}
            selectedFile={selectedFile}
            isLoading={viewMode === "turn" && selectedTransition?.status === "ready" && turnDiffQuery.isLoading}
            error={viewMode === "turn" ? turnDiffQuery.error : null}
            unavailableReason={viewMode === "turn" ? getTransitionUnavailableReason(selectedTransition) : null}
          />
        </div>
      ) : null}
    </div>
  );
}

function Toolbar({
  isActive,
  isFetching,
  viewMode,
  onRefresh,
  onViewModeChange,
}: {
  isActive: boolean;
  isFetching: boolean;
  viewMode: DiffViewMode;
  onRefresh: () => void;
  onViewModeChange: (mode: DiffViewMode) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="inline-flex rounded-sm border border-border bg-surface-alt p-0.5">
        {VIEW_MODES.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onViewModeChange(option.id)}
            className={`rounded-sm px-2 py-1 text-[11px] font-medium ${
              viewMode === option.id
                ? "bg-surface text-ink"
                : "text-ink-muted transition hover:text-ink-secondary"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3">
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
    </div>
  );
}

function TurnTimeline({
  transitions,
  selectedTurnSeq,
  onSelectTurn,
  onRevert,
  isReverting,
}: {
  transitions: TurnTransition[];
  selectedTurnSeq: number | null;
  onSelectTurn: (turnSeq: number) => void;
  onRevert: (turnSeq: number, mode: "files" | "files_and_conversation") => void;
  isReverting: boolean;
}) {
  const [revertMenuTurn, setRevertMenuTurn] = useState<number | null>(null);

  if (transitions.length === 0) {
    return null;
  }

  return (
    <section className="overflow-hidden rounded-sm border border-border bg-surface">
      <div className="border-b border-border px-2 py-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
          Turn Timeline
        </p>
      </div>
      <div className="overflow-x-auto p-2">
        <div className="flex min-w-max gap-2">
          {transitions.map((transition) => {
            const isSelected = transition.toTurn === selectedTurnSeq;
            const changedFileCount = transition.files?.length ?? 0;
            const showRevertMenu = revertMenuTurn === transition.toTurn;

            return (
              <div key={transition.key} className="relative">
                <button
                  type="button"
                  onClick={() => onSelectTurn(transition.toTurn)}
                  className={`min-w-[11rem] rounded-sm border px-3 py-2 text-left transition ${
                    isSelected
                      ? "border-accent/40 bg-accent/10"
                      : "border-border bg-surface-alt hover:border-ink-muted/50 hover:bg-surface-hover"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-[11px] font-semibold text-ink">
                        T{transition.fromTurn} to T{transition.toTurn}
                      </p>
                      <p className="mt-0.5 text-[10px] text-ink-muted">
                        {formatRelativeTime(transition.createdAt)}
                      </p>
                    </div>
                    {transition.status !== "ready" ? (
                      <span className="rounded-sm border border-status-warning/30 bg-status-warning/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-status-warning">
                        {transition.status}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 text-[11px] text-ink-secondary">
                    {changedFileCount} file{changedFileCount === 1 ? "" : "s"}
                  </p>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 font-mono text-[10px]">
                      <span className="rounded-sm bg-emerald-600/10 px-1.5 py-0.5 text-emerald-700">
                        +{transition.additions}
                      </span>
                      <span className="rounded-sm bg-status-error/10 px-1.5 py-0.5 text-status-error">
                        -{transition.deletions}
                      </span>
                    </div>
                    {transition.status === "ready" ? (
                      <button
                        type="button"
                        title="Revert to this turn"
                        disabled={isReverting}
                        onClick={(event) => {
                          event.stopPropagation();
                          setRevertMenuTurn(showRevertMenu ? null : transition.toTurn);
                        }}
                        className="rounded-sm p-0.5 text-ink-muted transition hover:bg-surface hover:text-ink-secondary disabled:opacity-50"
                      >
                        <RotateCcw className="h-3 w-3" />
                      </button>
                    ) : null}
                  </div>
                </button>
                {showRevertMenu ? (
                  <div className="absolute left-0 top-full z-10 mt-1 w-52 rounded-sm border border-border bg-surface shadow-lg">
                    <button
                      type="button"
                      disabled={isReverting}
                      onClick={() => {
                        setRevertMenuTurn(null);
                        onRevert(transition.toTurn, "files");
                      }}
                      className="w-full px-3 py-2 text-left text-[11px] text-ink-secondary transition hover:bg-surface-alt disabled:opacity-50"
                    >
                      <p className="font-medium text-ink">Revert files only</p>
                      <p className="mt-0.5 text-ink-muted">Restore worktree, keep conversation</p>
                    </button>
                    <button
                      type="button"
                      disabled={isReverting}
                      onClick={() => {
                        setRevertMenuTurn(null);
                        onRevert(transition.toTurn, "files_and_conversation");
                      }}
                      className="w-full border-t border-border/70 px-3 py-2 text-left text-[11px] text-ink-secondary transition hover:bg-surface-alt disabled:opacity-50"
                    >
                      <p className="font-medium text-ink">Revert files + conversation</p>
                      <p className="mt-0.5 text-ink-muted">Restore worktree, truncate history</p>
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function FilesSidebar({
  files,
  selectedFileKey,
  onSelectFile,
}: {
  files: FileSidebarItem[];
  selectedFileKey: string | null;
  onSelectFile: (fileKey: string) => void;
}) {
  return (
    <section className="overflow-hidden rounded-sm border border-border bg-surface">
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
            Files
          </p>
          <span className="text-[10px] text-ink-muted">
            {files.length} file{files.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
      {files.length === 0 ? (
        <div className="px-3 py-6 text-center text-[11px] text-ink-muted">
          No changed files for this selection.
        </div>
      ) : (
        <div className="max-h-[16rem] overflow-y-auto lg:max-h-[38rem]">
          {files.map((file) => {
            const isSelected = file.key === selectedFileKey;

            return (
              <button
                key={file.key}
                type="button"
                onClick={() => onSelectFile(file.key)}
                className={`flex w-full items-start justify-between gap-2 border-b border-border/70 px-3 py-2 text-left last:border-b-0 ${
                  isSelected ? "bg-accent/10" : "transition hover:bg-surface-alt"
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={getChangeKindClassName(file.kind)}>
                      {file.kind}
                    </span>
                    <span className="truncate font-mono text-[11px] text-ink" title={file.label}>
                      {file.label}
                    </span>
                  </div>
                </div>
                <div className="shrink-0 text-right font-mono text-[10px]">
                  <p className="text-emerald-700">+{file.additions}</p>
                  <p className="text-status-error">-{file.deletions}</p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function DiffViewer({
  diffText,
  selectedFile,
  isLoading,
  error,
  unavailableReason,
}: {
  diffText: string;
  selectedFile: FileSidebarItem | null;
  isLoading: boolean;
  error: unknown;
  unavailableReason: string | null;
}) {
  if (unavailableReason) {
    return (
      <section className="rounded-sm border border-border bg-surface p-4">
        <p className="text-[12px] font-medium text-ink-secondary">Diff unavailable</p>
        <p className="mt-1 text-[11px] text-ink-muted">{unavailableReason}</p>
      </section>
    );
  }

  if (isLoading) {
    return <LoadingState compact />;
  }

  if (error) {
    return (
      <ErrorState
        title="Unable to load the selected turn diff."
        error={error}
      />
    );
  }

  if (!diffText.trim()) {
    return (
      <section className="rounded-sm border border-border bg-surface">
        <div className="flex min-h-64 flex-col items-center justify-center px-4 py-8 text-center">
          <FileDiff className="h-8 w-8 text-ink-muted" />
          <p className="mt-2 text-[12px] font-medium text-ink-secondary">No changes</p>
          <p className="mt-1 max-w-md text-[11px] text-ink-muted">
            This selection does not contain a patch diff.
          </p>
        </div>
      </section>
    );
  }

  if (!selectedFile) {
    return (
      <section className="rounded-sm border border-border bg-surface">
        <div className="flex min-h-64 flex-col items-center justify-center px-4 py-8 text-center">
          <FileDiff className="h-8 w-8 text-ink-muted" />
          <p className="mt-2 text-[12px] font-medium text-ink-secondary">Select a file</p>
          <p className="mt-1 max-w-md text-[11px] text-ink-muted">
            Choose a file from the sidebar to inspect its hunks.
          </p>
        </div>
      </section>
    );
  }

  if (!selectedFile.diffFile) {
    return <RawDiffBlock diffText={diffText} />;
  }

  return (
    <section className="overflow-hidden rounded-sm border border-border bg-surface">
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={getChangeKindClassName(selectedFile.kind)}>
                {selectedFile.kind}
              </span>
              <p
                className="truncate font-mono text-[11px] font-semibold text-ink"
                title={selectedFile.label}
              >
                {selectedFile.label}
              </p>
            </div>
            <p className="mt-1 font-mono text-[10px] text-ink-muted">
              +{selectedFile.additions} -{selectedFile.deletions}
            </p>
          </div>
        </div>
      </div>
      <div className="max-h-[28rem] overflow-auto lg:max-h-[38rem]">
        {selectedFile.diffFile.hunks.length === 0 ? (
          <div className="px-3 py-3 font-mono text-[11px] text-ink-muted">
            Binary or metadata-only diff.
          </div>
        ) : (
          selectedFile.diffFile.hunks.map((hunk) => (
            <div key={`${selectedFile.key}-${hunk.header}`} className="border-t border-border first:border-t-0">
              <div className="bg-accent/10 px-3 py-1 font-mono text-[10px] text-accent-strong">
                {hunk.header}
              </div>
              <div className="font-mono text-[11px]">
                {hunk.lines.map((line, index) => (
                  <DiffLineRow
                    key={`${selectedFile.key}-${hunk.header}-${index}`}
                    line={line}
                    filePath={selectedFile.path}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function LoadingState({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex h-full items-center justify-center rounded-sm border border-border bg-surface">
      <div className={`flex items-center gap-2 text-[12px] text-ink-muted ${compact ? "min-h-64 py-8" : "min-h-48"}`}>
        <LoaderCircle className="h-4 w-4 animate-spin" />
        Loading diff…
      </div>
    </div>
  );
}

function ErrorState({ title, error }: { title: string; error: unknown }) {
  return (
    <div className="rounded-sm border border-status-error/30 bg-status-error/10 p-3 text-[12px] text-status-error">
      <p className="font-medium">{title}</p>
      <p className="mt-1 opacity-80">
        {error instanceof Error ? error.message : "Unknown error"}
      </p>
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

function NoTurnDiffsState() {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center rounded-sm border border-dashed border-border bg-surface px-4 py-8 text-center">
      <FileDiff className="h-8 w-8 text-ink-muted" />
      <p className="mt-2 text-[12px] font-medium text-ink-secondary">No turn checkpoints yet</p>
      <p className="mt-1 max-w-md text-[11px] text-ink-muted">
        Per-turn diffs will appear after the session captures checkpoints for completed turns.
      </p>
    </div>
  );
}

function NoChangesState() {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center rounded-sm border border-dashed border-border bg-surface px-4 py-8 text-center">
      <FileDiff className="h-8 w-8 text-ink-muted" />
      <p className="mt-2 text-[12px] font-medium text-ink-secondary">No changes</p>
      <p className="mt-1 max-w-md text-[11px] text-ink-muted">
        This session worktree is clean. New edits will appear here once files change.
      </p>
    </div>
  );
}

function RawDiffBlock({ diffText }: { diffText: string }) {
  return (
    <section className="overflow-hidden rounded-sm border border-border bg-surface">
      <div className="border-b border-border px-3 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
          Raw Diff
        </p>
      </div>
      <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-all px-3 py-3 font-mono text-[11px] leading-5 text-ink-secondary lg:max-h-[38rem]">
        {diffText}
      </pre>
    </section>
  );
}

function DiffLineRow({ line, filePath }: { line: DiffLine; filePath: string }) {
  const lineClassName = getLineClassName(line.type);
  const marker = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
  const highlightedContent = highlightDiffLineContent(line.content, filePath);

  return (
    <div
      className={`grid min-w-full grid-cols-[2.5rem_2.5rem_1.25rem_minmax(0,1fr)] md:grid-cols-[4rem_4rem_1.5rem_minmax(0,1fr)] ${lineClassName}`}
    >
      <span className="border-r border-border/50 px-1 py-0.5 text-right text-[10px] text-ink-muted md:px-2 md:text-[11px]">
        {line.oldLineNumber ?? ""}
      </span>
      <span className="border-r border-border/50 px-1 py-0.5 text-right text-[10px] text-ink-muted md:px-2 md:text-[11px]">
        {line.newLineNumber ?? ""}
      </span>
      <span className="border-r border-border/50 px-1 py-0.5 text-center text-[10px] text-ink-muted md:px-2 md:text-[11px]">
        {marker}
      </span>
      <span
        className="px-2 py-0.5 whitespace-pre-wrap break-all text-ink md:px-3"
        dangerouslySetInnerHTML={{ __html: highlightedContent }}
      />
    </div>
  );
}

function buildTurnTransitions(checkpoints: Checkpoint[]): TurnTransition[] {
  const transitions: TurnTransition[] = [];

  for (let index = 1; index < checkpoints.length; index += 1) {
    const previous = checkpoints[index - 1];
    const current = checkpoints[index];
    if (!previous || !current) {
      continue;
    }
    const additions = current.files?.reduce((total, file) => total + file.additions, 0) ?? 0;
    const deletions = current.files?.reduce((total, file) => total + file.deletions, 0) ?? 0;

    transitions.push({
      key: `${previous.turnSeq}-${current.turnSeq}`,
      fromTurn: previous.turnSeq,
      toTurn: current.turnSeq,
      status: current.status,
      createdAt: current.createdAt,
      files: current.files,
      additions,
      deletions,
    });
  }

  return transitions;
}

function buildFileSidebarItems(
  diffFiles: DiffFile[],
  checkpointFiles?: Checkpoint["files"],
): FileSidebarItem[] {
  const itemsByPath = new Map<string, FileSidebarItem>();

  for (const diffFile of diffFiles) {
    const path = getDiffFilePath(diffFile);
    const stats = summarizeFile(diffFile);

    itemsByPath.set(path, {
      key: path,
      path,
      label: getFileLabel(diffFile),
      kind: getDiffFileChangeKind(diffFile),
      additions: stats.additions,
      deletions: stats.removals,
      diffFile,
    });
  }

  const items: FileSidebarItem[] = [];

  for (const file of checkpointFiles ?? []) {
    const existing = itemsByPath.get(file.path);
    items.push({
      key: file.path,
      path: file.path,
      label: existing?.label ?? file.path,
      kind: existing?.kind ?? "M",
      additions: file.additions,
      deletions: file.deletions,
      diffFile: existing?.diffFile ?? null,
    });
    itemsByPath.delete(file.path);
  }

  const remainingItems = [...itemsByPath.values()].sort((left, right) => left.path.localeCompare(right.path));

  return [...items.sort((left, right) => left.path.localeCompare(right.path)), ...remainingItems];
}

function getTransitionUnavailableReason(transition: TurnTransition | null): string | null {
  if (!transition || transition.status === "ready") {
    return null;
  }

  switch (transition.status) {
    case "oversized":
      return `Turn ${transition.fromTurn} to ${transition.toTurn} exceeded the checkpoint diff size limit.`;
    case "missing":
      return `Checkpoint data for turn ${transition.toTurn} is missing.`;
    case "error":
      return `Checkpoint capture failed for turn ${transition.toTurn}.`;
    default:
      return `Diff data is not ready for turn ${transition.toTurn}.`;
  }
}

function getDiffFilePath(file: DiffFile): string {
  if (file.newPath === "/dev/null") {
    return file.oldPath;
  }

  return file.newPath;
}

function getDiffFileChangeKind(file: DiffFile): FileChangeKind {
  if (file.oldPath === "/dev/null") {
    return "A";
  }

  if (file.newPath === "/dev/null") {
    return "D";
  }

  return "M";
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

function getChangeKindClassName(kind: FileChangeKind): string {
  switch (kind) {
    case "A":
      return "inline-flex h-5 w-5 items-center justify-center rounded-sm bg-emerald-600/10 font-mono text-[10px] font-semibold text-emerald-700";
    case "D":
      return "inline-flex h-5 w-5 items-center justify-center rounded-sm bg-status-error/10 font-mono text-[10px] font-semibold text-status-error";
    default:
      return "inline-flex h-5 w-5 items-center justify-center rounded-sm bg-accent/10 font-mono text-[10px] font-semibold text-accent-strong";
  }
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

function highlightDiffLineContent(content: string, filePath: string): string {
  return highlightCode(content, filePath);
}
