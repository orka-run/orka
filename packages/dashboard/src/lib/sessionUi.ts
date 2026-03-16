import type { SessionSummary } from "../stores/sessionStore";

export type SessionGroupKey = "running" | "completed" | "failed";

export function getSessionGroup(status: SessionSummary["status"]): SessionGroupKey {
  if (status === "completed") {
    return "completed";
  }

  if (status === "failed" || status === "cancelled" || status === "interrupted") {
    return "failed";
  }

  return "running";
}

export function formatRelativeTime(value: string, now = Date.now()): string {
  const date = new Date(value);
  const timestamp = date.getTime();

  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }

  const today = new Date(now);
  const isToday = date.getDate() === today.getDate()
    && date.getMonth() === today.getMonth()
    && date.getFullYear() === today.getFullYear();

  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

  if (isToday) {
    return time;
  }

  const dateStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${dateStr} ${time}`;
}

export function formatDateTime(value: string | null): string {
  if (!value) {
    return "N/A";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatDuration(
  startedAt: string | null,
  finishedAt: string | null,
  fallbackLabel = "Not started",
): string {
  if (!startedAt) {
    return fallbackLabel;
  }

  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt ?? new Date().toISOString()).getTime();

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return fallbackLabel;
  }

  const totalSeconds = Math.floor((end - start) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}
