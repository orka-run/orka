import { useState } from "react";
import { Check, LoaderCircle, ShieldAlert, X } from "lucide-react";
import { formatDateTime } from "../lib/sessionUi";

const REQUEST_TYPE_LABELS: Record<string, string> = {
  command_execution_approval: "Run Command",
  file_read_approval: "Read File",
  file_change_approval: "Edit File",
  tool_user_input: "User Input Required",
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
    ? "border-amber-800/70"
    : entry.status === "approved"
      ? "border-emerald-900/60"
      : "border-red-900/60";

  const bgColor = isPending
    ? "bg-amber-950/20"
    : entry.status === "approved"
      ? "bg-emerald-950/20"
      : "bg-red-950/20";

  return (
    <div className={`rounded-xl border ${borderColor} ${bgColor} px-4 py-4`}>
      <div className="flex items-center gap-2">
        <ShieldAlert className={`h-4 w-4 ${isPending ? "text-amber-400" : "text-zinc-500"}`} />
        <p className="text-sm font-medium text-zinc-100">{humanRequestType(entry.requestType)}</p>
        {!isPending && (
          <span
            className={`ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
              entry.status === "approved"
                ? "bg-emerald-950/60 text-emerald-300"
                : "bg-red-950/60 text-red-300"
            }`}
          >
            {entry.status === "approved" ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            {entry.status === "approved" ? "Approved" : "Denied"}
          </span>
        )}
      </div>

      {entry.detail && (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 font-mono text-xs leading-relaxed text-zinc-300">
          {entry.detail}
        </pre>
      )}

      {isPending && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleClick("approve")}
            disabled={inflight !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-800/60 bg-emerald-950/40 px-3 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-950/60 disabled:opacity-50"
          >
            {inflight === "approve" ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            Approve
          </button>
          <button
            type="button"
            onClick={() => void handleClick("deny")}
            disabled={inflight !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-1.5 text-xs font-medium text-red-300 transition hover:bg-red-950/60 disabled:opacity-50"
          >
            {inflight === "deny" ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
            Deny
          </button>
        </div>
      )}

      <p className="mt-2 text-xs text-zinc-500">{formatDateTime(entry.timestamp)}</p>
    </div>
  );
}
