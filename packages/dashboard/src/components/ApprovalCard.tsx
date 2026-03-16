import { useState, useEffect } from "react";
import { Check, Clock, LoaderCircle, ShieldAlert, Terminal, FileEdit, FileSearch, X } from "lucide-react";
import { formatDateTime } from "../lib/sessionUi";

const REQUEST_TYPE_LABELS: Record<string, string> = {
  command_execution_approval: "Run Command",
  file_read_approval: "Read File",
  file_change_approval: "Edit File",
  tool_user_input: "User Input Required",
};

const REQUEST_TYPE_ICONS: Record<string, typeof Terminal> = {
  command_execution_approval: Terminal,
  file_read_approval: FileSearch,
  file_change_approval: FileEdit,
};

function humanRequestType(raw: string): string {
  return REQUEST_TYPE_LABELS[raw] ?? "Approval Required";
}

export interface ApprovalEntry {
  id: string;
  type: "approval";
  timestamp: string;
  requestId: string;
  requestType: string;
  detail?: string;
  status: "pending" | "approved" | "denied";
}

interface ApprovalCardProps {
  entry: ApprovalEntry;
  onResolve: (requestId: string, decision: "approve" | "deny") => Promise<void>;
}

function ElapsedTime({ since }: { since: string }) {
  const [elapsed, setElapsed] = useState("");

  useEffect(() => {
    function update() {
      const ms = Date.now() - new Date(since).getTime();
      if (ms < 60_000) {
        setElapsed(`${Math.floor(ms / 1000)}s`);
      } else {
        setElapsed(`${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`);
      }
    }
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [since]);

  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] text-ink-muted">
      <Clock className="h-2.5 w-2.5" />
      {elapsed}
    </span>
  );
}

export function ApprovalCard({ entry, onResolve }: ApprovalCardProps) {
  const [inflight, setInflight] = useState<"approve" | "deny" | null>(null);
  const isPending = entry.status === "pending";

  async function handleClick(decision: "approve" | "deny") {
    if (!isPending || inflight) return;
    setInflight(decision);
    try {
      await onResolve(entry.requestId, decision);
    } finally {
      setInflight(null);
    }
  }

  const borderColor = isPending
    ? "border-status-warning/50"
    : entry.status === "approved"
      ? "border-emerald-600/30"
      : "border-status-error/30";

  const bgColor = isPending
    ? "bg-status-warning/5"
    : entry.status === "approved"
      ? "bg-emerald-600/5"
      : "bg-status-error/5";

  const Icon = REQUEST_TYPE_ICONS[entry.requestType] ?? ShieldAlert;

  return (
    <div className={`rounded-sm border ${borderColor} ${bgColor} px-2 py-2`}>
      <div className="flex items-center gap-2">
        <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${isPending ? "text-status-warning" : "text-ink-muted"}`} />
        <p className="text-[12px] font-medium text-ink">{humanRequestType(entry.requestType)}</p>
        {isPending && <ElapsedTime since={entry.timestamp} />}
        {!isPending && (
          <span
            className={`ml-auto inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium ${
              entry.status === "approved"
                ? "bg-emerald-600/10 text-emerald-800"
                : "bg-status-error/10 text-status-error"
            }`}
          >
            {entry.status === "approved" ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            {entry.status === "approved" ? "Approved" : "Denied"}
          </span>
        )}
      </div>

      {entry.detail && (
        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-surface-alt px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink-secondary">
          {entry.detail}
        </pre>
      )}

      {isPending && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleClick("approve")}
            disabled={inflight !== null}
            className="inline-flex items-center gap-1 rounded-sm border border-emerald-600/30 bg-emerald-600/10 px-2 py-1 text-[11px] font-medium text-emerald-800 transition hover:bg-emerald-600/20 disabled:opacity-50"
          >
            {inflight === "approve" ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            Approve
          </button>
          <button
            type="button"
            onClick={() => void handleClick("deny")}
            disabled={inflight !== null}
            className="inline-flex items-center gap-1 rounded-sm border border-status-error/30 bg-status-error/10 px-2 py-1 text-[11px] font-medium text-status-error transition hover:bg-status-error/20 disabled:opacity-50"
          >
            {inflight === "deny" ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
            Deny
          </button>
        </div>
      )}

      <p className="mt-1.5 text-[10px] text-ink-muted">{formatDateTime(entry.timestamp)}</p>
    </div>
  );
}
