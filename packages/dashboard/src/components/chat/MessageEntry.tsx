import { memo, useCallback, useState } from "react";
import { AlertTriangle, Bot, ChevronRight, Clock3, Reply, User } from "lucide-react";
import { formatDateTime } from "../../lib/sessionUi";
import { MarkdownContent } from "../MarkdownContent";
import type { AssistantEntry, SystemEntry, UserEntry } from "./eventsToEntries";

export interface QuotedText {
  text: string;
  source: "assistant" | "user";
}

export const AssistantMessage = memo(function AssistantMessage({
  entry,
  onQuote,
}: {
  entry: AssistantEntry;
  onQuote?: (quote: QuotedText) => void;
}) {
  const handleQuote = useCallback(() => {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();
    onQuote?.({
      text: selectedText && selectedText.length > 0 ? selectedText : entry.body,
      source: "assistant",
    });
  }, [entry.body, onQuote]);

  return (
    <div className="group/msg flex items-start gap-2">
      <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-sm bg-accent/15 text-accent-strong">
        <Bot className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 max-w-full rounded-sm rounded-tl-none border border-border bg-surface-alt px-2 py-1.5 lg:max-w-3xl [overflow-wrap:anywhere]">
        <MarkdownContent content={entry.body} />
        <p className="mt-1 text-[10px] text-ink-muted">{formatDateTime(entry.timestamp)}</p>
      </div>
      {onQuote ? (
        <button
          type="button"
          onClick={handleQuote}
          aria-label="Quote reply"
          title="Quote reply"
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-ink-muted opacity-0 transition hover:bg-surface-hover hover:text-ink-secondary group-hover/msg:opacity-100"
        >
          <Reply className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
});

export const UserMessage = memo(function UserMessage({ entry }: { entry: UserEntry }) {
  return (
    <div className="flex justify-end">
      <div className="flex max-w-full items-start gap-2 lg:max-w-3xl">
        <div className="min-w-0 rounded-sm rounded-tr-none border border-accent/20 bg-accent/5 px-2 py-1.5 [overflow-wrap:anywhere]">
          <MarkdownContent content={entry.body} />
          <p className="mt-1 text-[10px] text-ink-muted">{formatDateTime(entry.timestamp)}</p>
        </div>
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-accent/15 text-accent-strong">
          <User className="h-3.5 w-3.5" />
        </div>
      </div>
    </div>
  );
});

export const SystemMessage = memo(function SystemMessage({ entry }: { entry: SystemEntry }) {
  const [collapsed, setCollapsed] = useState(entry.defaultCollapsed ?? false);
  const toneClasses =
    entry.tone === "warning"
      ? {
          container: "border-status-warning/30 bg-status-warning/10",
          icon: "text-status-warning",
          title: "text-status-warning",
          body: "text-status-warning/80",
        }
      : entry.tone === "error"
        ? {
            container: "border-status-error/30 bg-status-error/10",
            icon: "text-status-error",
            title: "text-status-error",
            body: "text-status-error/80",
          }
        : {
            container: "border-border bg-surface-alt",
            icon: "text-ink-muted",
            title: "text-ink",
            body: "text-ink-muted",
          };

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => { setCollapsed(false); }}
        className={`flex w-full items-center gap-1.5 rounded-sm border px-2 py-1 text-left ${toneClasses.container}`}
      >
        <ChevronRight className={`h-3 w-3 shrink-0 ${toneClasses.icon}`} />
        <span className={`text-[11px] ${toneClasses.title}`}>{entry.title}</span>
        <span className={`text-[11px] opacity-60 ${toneClasses.body}`}>{entry.body}</span>
      </button>
    );
  }

  return (
    <div className={`flex items-start gap-2 rounded-sm border px-2 py-1.5 ${toneClasses.container}`}>
      {entry.tone === "warning" || entry.tone === "error" ? (
        <AlertTriangle className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${toneClasses.icon}`} />
      ) : entry.defaultCollapsed ? (
        <button type="button" onClick={() => { setCollapsed(true); }} className="mt-0.5 shrink-0">
          <ChevronRight className={`h-3.5 w-3.5 rotate-90 ${toneClasses.icon}`} />
        </button>
      ) : (
        <Clock3 className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${toneClasses.icon}`} />
      )}
      <div>
        <p className={`text-[12px] font-medium ${toneClasses.title}`}>{entry.title}</p>
        <p className={`mt-0.5 text-[11px] ${toneClasses.body}`}>{entry.body}</p>
        <p className="mt-1 text-[10px] text-ink-muted">{formatDateTime(entry.timestamp)}</p>
      </div>
    </div>
  );
});
