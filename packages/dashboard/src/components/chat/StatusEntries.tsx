import { memo, useEffect, useState } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { formatDateTime, formatRelativeTime } from "../../lib/sessionUi";
import type {
  ApiRetryEntry as ApiRetryEntryData,
  ErrorEntry as ErrorEntryData,
  RateLimitEntry as RateLimitEntryData,
} from "./eventsToEntries";

function formatCountdown(value: string, now = Date.now()): string | null {
  const target = new Date(value).getTime();
  if (!Number.isFinite(target)) {
    return null;
  }

  const remainingMs = target - now;
  if (remainingMs <= 0) {
    return "now";
  }

  const totalMinutes = Math.ceil(remainingMs / 60_000);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

export const RateLimitEntry = memo(function RateLimitEntry({ entry }: { entry: RateLimitEntryData }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!entry.scheduledResumeAt) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 60_000);

    return () => {
      window.clearInterval(timer);
    };
  }, [entry.scheduledResumeAt]);

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

  const body = entry.scheduledResumeAt
    ? `Rate limit reached - auto-resuming at ${formatRelativeTime(entry.scheduledResumeAt, now)} (${formatCountdown(entry.scheduledResumeAt, now) ?? "scheduled"})`
    : entry.body;

  return (
    <div className={`flex items-start gap-2 rounded-sm border px-2 py-1.5 ${toneClasses.container}`}>
      <AlertTriangle className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${toneClasses.icon}`} />
      <div>
        <p className={`text-[12px] font-medium ${toneClasses.title}`}>{entry.title}</p>
        <p className={`mt-0.5 text-[11px] ${toneClasses.body}`}>{body}</p>
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
