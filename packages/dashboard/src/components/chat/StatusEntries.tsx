import { memo } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { formatDateTime } from "../../lib/sessionUi";
import type {
  ApiRetryEntry as ApiRetryEntryData,
  ErrorEntry as ErrorEntryData,
  RateLimitEntry as RateLimitEntryData,
} from "./eventsToEntries";

export const RateLimitEntry = memo(function RateLimitEntry({ entry }: { entry: RateLimitEntryData }) {
  const toneClasses =
    entry.tone === "error"
      ? {
          container: "border-status-error/30 bg-status-error/10",
          icon: "text-status-error",
          title: "text-status-error",
          body: "text-status-error/80",
        }
      : {
          container: "border-status-warning/30 bg-status-warning/10",
          icon: "text-status-warning",
          title: "text-status-warning",
          body: "text-status-warning/80",
        };

  return (
    <div className={`flex items-start gap-2 rounded-sm border px-2 py-1.5 ${toneClasses.container}`}>
      <AlertTriangle className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${toneClasses.icon}`} />
      <div>
        <p className={`text-[12px] font-medium ${toneClasses.title}`}>{entry.title}</p>
        <p className={`mt-0.5 text-[11px] ${toneClasses.body}`}>{entry.body}</p>
        <p className="mt-1 text-[10px] text-ink-muted">{formatDateTime(entry.timestamp)}</p>
      </div>
    </div>
  );
});

export const ApiRetryEntry = memo(function ApiRetryEntry({ entry }: { entry: ApiRetryEntryData }) {
  return (
    <div className="flex items-center gap-2 rounded-sm border border-border/70 bg-surface-alt px-2 py-1 text-[11px] text-ink-muted">
      <RotateCcw className="h-3.5 w-3.5 shrink-0" />
      <p>{entry.body}</p>
      <p className="ml-auto shrink-0 text-[10px] text-ink-muted">{formatDateTime(entry.timestamp)}</p>
    </div>
  );
});

export const ErrorEntry = memo(function ErrorEntry({ entry }: { entry: ErrorEntryData }) {
  return (
    <div className="rounded-sm border border-status-error/30 bg-status-error/10 px-2 py-2">
      <div className="flex items-center gap-1 text-status-error">
        <AlertTriangle className="h-3.5 w-3.5" />
        <p className="text-[12px] font-medium">{entry.title}</p>
      </div>
      <p className="mt-1 text-[12px] text-status-error/80">{entry.body}</p>
      <p className="mt-1 text-[10px] text-ink-muted">{formatDateTime(entry.timestamp)}</p>
    </div>
  );
});
