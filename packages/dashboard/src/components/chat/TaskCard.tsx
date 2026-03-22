import { memo, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import { formatRelativeTime } from "../../lib/sessionUi";
import type { TaskEntry } from "./eventsToEntries";

export const TaskCard = memo(function TaskCard({
  entry,
}: {
  entry: TaskEntry;
}) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = entry.status === "running";
  const toolCount = entry.toolCalls.length;
  const hasToolCalls = toolCount > 0;

  return (
    <div className="overflow-hidden rounded-sm border border-border bg-surface-alt">
      <button
        type="button"
        onClick={() => { if (hasToolCalls) setExpanded(!expanded); }}
        className={`flex w-full items-center gap-2 px-2 py-1 text-left${hasToolCalls ? " cursor-pointer hover:bg-surface-hover" : " cursor-default"}`}
      >
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
        {hasToolCalls ? (
          <span className="ml-auto shrink-0 text-[10px] text-ink-muted">
            {String(toolCount)} tool call{toolCount !== 1 ? "s" : ""}
          </span>
        ) : entry.detail ? (
          <span className="ml-auto max-w-[40%] shrink-0 truncate text-[10px] text-ink-muted">
            {entry.detail}
          </span>
        ) : (
          <span className="ml-auto shrink-0 text-[10px] text-ink-muted">
            {formatRelativeTime(entry.timestamp)}
          </span>
        )}
        {hasToolCalls ? (
          <div className="shrink-0 p-0.5 text-ink-muted">
            {expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </div>
        ) : null}
      </button>
      {expanded && hasToolCalls ? (
        <div className="border-t border-border/30 px-2 py-1">
          {entry.toolCalls.map((call, index) => (
            <div key={`${entry.taskId}-tool-${String(index)}`} className="flex items-baseline gap-2 py-0.5">
              <span className="shrink-0 text-[10px] text-ink-muted">
                {formatRelativeTime(call.timestamp)}
              </span>
              {call.toolName ? (
                <span className="shrink-0 rounded bg-surface-hover px-1 text-[10px] font-medium text-ink-muted">
                  {call.toolName}
                </span>
              ) : null}
              <span className="text-[11px] text-ink-secondary">{call.summary}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
});
