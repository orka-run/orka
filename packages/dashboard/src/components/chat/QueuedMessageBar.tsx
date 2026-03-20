import { memo } from "react";
import { X, Clock3 } from "lucide-react";
import type { UserEntry } from "./eventsToEntries";

interface QueuedMessageBarProps {
  messages: UserEntry[];
  onCancel: (text: string) => void;
}

export const QueuedMessageBar = memo(function QueuedMessageBar({
  messages,
  onCancel,
}: QueuedMessageBarProps) {
  if (messages.length === 0) return null;

  return (
    <div className="border-t border-status-warning/20 bg-status-warning/5 px-2 py-1.5">
      <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-status-warning">
        <Clock3 className="h-3 w-3" />
        Queued ({messages.length})
      </div>
      <div className="flex flex-wrap gap-1">
        {messages.map((msg) => (
          <QueuedChip
            key={msg.id}
            text={msg.body}
            onCancel={() => { onCancel(msg.body); }}
          />
        ))}
      </div>
    </div>
  );
});

const QueuedChip = memo(function QueuedChip({
  text,
  onCancel,
}: {
  text: string;
  onCancel: () => void;
}) {
  const preview = text.length > 60 ? text.slice(0, 57) + "..." : text;

  return (
    <span className="queued-chip inline-flex max-w-full items-center gap-1 rounded-sm border border-status-warning/30 bg-status-warning/10 px-1.5 py-0.5 text-[11px] text-status-warning">
      <span className="min-w-0 truncate">{preview}</span>
      <button
        type="button"
        onClick={onCancel}
        className="ml-0.5 inline-flex shrink-0 items-center justify-center rounded-sm p-0.5 transition hover:bg-status-warning/20"
        aria-label="Cancel queued message"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
});
