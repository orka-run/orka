import type { SessionSummary } from "../stores/sessionStore";

export type SessionGroupKey = "running" | "completed" | "failed";

export function getSessionGroup(status: SessionSummary["status"]): SessionGroupKey {
  if (status === "completed") {
    return "completed";
  }

  if (status === "failed" || status === "cancelled") {
    return "failed";
  }

  return "running";
}

export function formatRelativeTime(value: string, now = Date.now()): string {
  const timestamp = new Date(value).getTime();
  const diffMs = now - timestamp;

  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }

  if (Math.abs(diffMs) < 60_000) {
    return "just now";
  }

  const units: Array<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> = [
    { amount: 60_000, unit: "minute" },
    { amount: 3_600_000, unit: "hour" },
    { amount: 86_400_000, unit: "day" },
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  for (let index = units.length - 1; index >= 0; index -= 1) {
    const { amount, unit } = units[index]!;
    if (Math.abs(diffMs) >= amount || index === 0) {
      return formatter.format(-Math.round(diffMs / amount), unit);
    }
  }

  return "just now";
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
