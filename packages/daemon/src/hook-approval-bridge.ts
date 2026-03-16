import type { ApprovalDecision, ProviderRuntimeEvent } from "@orka/core";
import { generateId, createEvent } from "@orka/core";
import type { ApprovalManager } from "./approval-manager";
import type { PushHub } from "./push-hub";
import type { OrchestrationEngine } from "./orchestration/engine";

interface PendingHookRequest {
  sessionId: string;
  requestId: string;
  toolName: string;
  toolInput: unknown;
  toolUseId: string;
  resolve: (result: { decision: string; reason?: string }) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Bridge between the hook script's HTTP long-poll and the dashboard's
 * resolveApproval RPC. When the hook script POSTs a tool-approval request,
 * a pending entry is created here. When the dashboard resolves the approval
 * (via resolveApproval RPC), this bridge resolves the HTTP response.
 */
export class HookApprovalBridge {
  private pending = new Map<string, PendingHookRequest>();
  private timeoutMs: number;

  constructor(
    private approvalManager: ApprovalManager,
    private pushHub: PushHub,
    private orchestrationEngine: OrchestrationEngine,
    opts?: { timeoutMs?: number },
  ) {
    this.timeoutMs = opts?.timeoutMs ?? 5 * 60_000; // 5 minutes default
  }

  /**
   * Called by the HTTP handler when the hook script posts a tool-approval request.
   * Returns a promise that resolves when the dashboard makes a decision.
   */
  requestApproval(
    sessionId: string,
    toolName: string,
    toolInput: unknown,
    toolUseId: string,
  ): Promise<{ decision: string; reason?: string }> {
    const requestId = generateId("req");

    // Emit request.opened event for the orchestration timeline
    const event: ProviderRuntimeEvent = createEvent(
      "request.opened",
      sessionId,
      {
        requestType: mapToolToRequestType(toolName),
        detail: formatToolTitle(toolName, toolInput),
        args: toolInput,
      },
      { provider: "claude-code", requestId },
    );
    this.orchestrationEngine.ingest(sessionId, event);

    // Add to approval manager so dashboard can see it
    this.approvalManager.addRequest({
      id: requestId,
      sessionId,
      threadId: sessionId, // For hook-based flow, threadId = sessionId
      requestType: mapToolToRequestType(toolName),
      detail: formatToolTitle(toolName, toolInput),
      args: toolInput,
      status: "pending",
      createdAt: new Date().toISOString(),
    });

    // Notify dashboard
    this.pushHub.broadcast("orchestration.event", {
      sessionId,
      type: "request.opened",
      requestId,
      requestType: mapToolToRequestType(toolName),
      detail: formatToolTitle(toolName, toolInput),
      args: toolInput,
    });

    return new Promise<{ decision: string; reason?: string }>((resolve) => {
      const entry: PendingHookRequest = {
        sessionId,
        requestId,
        toolName,
        toolInput,
        toolUseId,
        resolve,
      };

      // Set up timeout — auto-deny if no response
      if (this.timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.resolveRequest(requestId, "deny", "Approval timed out");
        }, this.timeoutMs);
        entry.timer.unref();
      }

      this.pending.set(requestId, entry);
    });
  }

  /**
   * Called when the dashboard resolves an approval (via resolveApproval RPC).
   * Resolves the HTTP long-poll so the hook script gets the decision.
   */
  resolveRequest(requestId: string, decision: ApprovalDecision | string, reason?: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;

    // Clear timeout
    if (entry.timer) {
      clearTimeout(entry.timer);
    }

    this.pending.delete(requestId);

    // Map ApprovalDecision to hook decision
    const hookDecision = (decision === "approve" || decision === "approve_session") ? "approve" : "deny";

    // Emit request.resolved event
    const resolvedEvent: ProviderRuntimeEvent = createEvent(
      "request.resolved",
      entry.sessionId,
      {
        requestType: mapToolToRequestType(entry.toolName),
        decision: hookDecision,
      },
      { provider: "claude-code", requestId },
    );
    this.orchestrationEngine.ingest(entry.sessionId, resolvedEvent);

    // Resolve the HTTP long-poll
    entry.resolve({ decision: hookDecision, reason });
    return true;
  }

  /** Deny all pending requests for a session (called on session stop/exit). */
  denyAllForSession(sessionId: string): void {
    for (const [requestId, entry] of this.pending) {
      if (entry.sessionId === sessionId) {
        this.resolveRequest(requestId, "deny", "Session ended");
      }
    }
  }

  /** Check if a request is pending in this bridge. */
  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /** Get all pending request IDs for a session. */
  getPendingForSession(sessionId: string): string[] {
    const ids: string[] = [];
    for (const [id, entry] of this.pending) {
      if (entry.sessionId === sessionId) {
        ids.push(id);
      }
    }
    return ids;
  }
}

function mapToolToRequestType(name: string): string {
  switch (name) {
    case "Bash":
      return "command_execution_approval";
    case "Read":
    case "Grep":
    case "Glob":
      return "file_read_approval";
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function getInputString(input: unknown, ...keys: string[]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const rec = input as Record<string, unknown>;
  for (const key of keys) {
    if (typeof rec[key] === "string") return rec[key];
  }
  return undefined;
}

function formatToolTitle(name: string, input: unknown): string {
  const path = getInputString(input, "file_path", "filePath");

  switch (name) {
    case "Bash":
      return getInputString(input, "command") ?? name;
    case "Read":
      return path ? `Read ${path}` : name;
    case "Edit":
    case "MultiEdit":
      return path ? `Edit ${path}` : name;
    case "Write":
      return path ? `Write ${path}` : name;
    case "Grep":
      return `Grep ${getInputString(input, "pattern") ?? ""}`;
    case "Glob":
      return `Glob ${getInputString(input, "pattern") ?? ""}`;
    case "Agent": {
      const desc = getInputString(input, "description");
      return desc ? `Agent: ${desc}` : name;
    }
    default:
      return path ? `${name} ${path}` : name;
  }
}
