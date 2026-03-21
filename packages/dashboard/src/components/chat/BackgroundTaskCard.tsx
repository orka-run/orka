import { memo, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import { formatRelativeTime } from "../../lib/sessionUi";
import type { BackgroundTaskEntry } from "./eventsToEntries";

export const BackgroundTaskCard = memo(function BackgroundTaskCard({
  entry,
}: {
  entry: BackgroundTaskEntry;
}) {
  const [showProgress, setShowProgress] = useState(false);
  const isRunning = entry.status === "running";
  const hasProgress = entry.progressUpdates.length > 0;

  return (
    <div className="overflow-hidden rounded-sm border border-border bg-surface-alt">
      <div className="flex items-center gap-2 px-2 py-1">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-surface-hover text-ink-muted">
          {isRunning ? (
            <LoaderCircle className="h-3 w-3 animate-spin text-accent" />
          ) : (
            <CheckCircle2 className="h-3 w-3 text-status-success" />
          )}
        </div>
        <span className="min-w-0 truncate text-[11px] font-medium text-ink-secondary">
          {entry.title}
        </span>
        {entry.detail ? (
          <span className="ml-auto max-w-[40%] shrink-0 truncate text-[10px] text-ink-muted">
            {entry.detail}
          </span>
        ) : (
          <span className="ml-auto shrink-0 text-[10px] text-ink-muted">
            {formatRelativeTime(entry.timestamp)}
          </span>
        )}
        {hasProgress ? (
          <button
            type="button"
            onClick={() => { setShowProgress(!showProgress); }}
            className="shrink-0 p-0.5 text-ink-muted hover:text-ink-secondary"
          >
            {showProgress ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        ) : null}
      </div>
      {showProgress && hasProgress ? (
        <div className="border-t border-border/30 px-2 py-1">
          {entry.progressUpdates.map((update, index) => (
            <div key={`${entry.taskId}-progress-${String(index)}`} className="flex items-baseline gap-2 py-0.5">
              <span className="shrink-0 text-[10px] text-ink-muted">
                {formatRelativeTime(update.timestamp)}
              </span>
              <span className="text-[11px] text-ink-secondary">{update.summary}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
});
