import { memo, useState } from "react";
import { Bot, ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import { formatRelativeTime } from "../../lib/sessionUi";
import type { SubagentEntry } from "./eventsToEntries";

export const SubagentCard = memo(function SubagentCard({
  entry,
}: {
  entry: SubagentEntry;
}) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = entry.status === "running";
  const subToolCount = entry.subTools?.length ?? 0;
  const toolCallCount = entry.toolCalls.length;
  const totalCount = subToolCount || toolCallCount;
  const hasContent = totalCount > 0 || !!entry.detail;

  return (
    <div className="overflow-hidden rounded-sm border border-border bg-surface-alt">
      <button
        type="button"
        onClick={() => { if (hasContent) setExpanded(!expanded); }}
        className={`flex w-full items-center gap-2 px-2 py-1 text-left${hasContent ? " cursor-pointer hover:bg-surface-hover" : " cursor-default"}`}
      >
        <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-sm ${isRunning ? "bg-accent/15 text-accent-strong" : "bg-surface-hover text-ink-muted"}`}>
          {isRunning ? (
            <LoaderCircle className="h-3 w-3 animate-spin" />
          ) : (
            <Bot className="h-3 w-3" />
          )}
        </div>
        <span className="min-w-0 truncate text-[11px] font-medium text-ink-secondary">
          {entry.title}
        </span>
        {totalCount > 0 ? (
          <span className="ml-auto shrink-0 text-[10px] text-ink-muted">
            {String(totalCount)} tool call{totalCount !== 1 ? "s" : ""}
          </span>
        ) : (
          <span className="ml-auto shrink-0 text-[10px] text-ink-muted">
            {isRunning ? "Running…" : formatRelativeTime(entry.timestamp)}
          </span>
        )}
        {hasContent ? (
          <div className="shrink-0 p-0.5 text-ink-muted">
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </div>
        ) : null}
      </button>
      {expanded && hasContent ? (
        <div className="border-t border-border/30 px-2 py-1">
          {entry.subTools && entry.subTools.length > 0 ? (
            entry.subTools.map((tool, index) => (
              <div key={`${entry.id}-sub-${String(index)}`} className="flex items-baseline gap-2 py-0.5">
                <span className="shrink-0 text-[10px] text-ink-muted">
                  {formatRelativeTime(tool.timestamp)}
                </span>
                <span className="shrink-0 rounded bg-surface-hover px-1 text-[10px] font-medium text-ink-muted">
                  {tool.title}
                </span>
                <span className="text-[11px] text-ink-secondary">
                  {tool.inProgress ? "Running…" : tool.summary}
                </span>
              </div>
            ))
          ) : entry.toolCalls.length > 0 ? (
            entry.toolCalls.map((call, index) => (
              <div key={`${entry.id}-tc-${String(index)}`} className="flex items-baseline gap-2 py-0.5">
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
            ))
          ) : entry.detail ? (
            <p className="text-[11px] text-ink-muted">{entry.detail}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
