import type { ApprovalRequest, ApprovalDecision } from "@orka/core";

export class ApprovalManager {
  private pending = new Map<string, ApprovalRequest>();
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private timeoutMs: number;

  constructor(opts?: { approvalTimeoutMinutes?: number }) {
    // 0 = wait forever
    this.timeoutMs = ((opts?.approvalTimeoutMinutes ?? 5) * 60_000) || 0;
  }

  /** Register a new approval request (from provider event) */
  addRequest(request: ApprovalRequest): void {
    this.pending.set(request.id, request);

    // Set up timeout if configured
    if (this.timeoutMs > 0) {
      const timer = setTimeout(() => {
        this.resolve(request.id, "deny");
      }, this.timeoutMs);
      timer.unref();
      this.timeouts.set(request.id, timer);
    }
  }

  /** Resolve a pending request with a decision */
  resolve(requestId: string, decision: ApprovalDecision): ApprovalRequest | null {
    const req = this.pending.get(requestId);
    if (!req || req.status !== "pending") return null;
    req.status = "resolved";
    req.decision = decision;
    req.resolvedAt = new Date().toISOString();

    // Clear the timeout
    const timer = this.timeouts.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.timeouts.delete(requestId);
    }

    return req;
  }

  /** Get all pending requests */
  getPending(): ApprovalRequest[] {
    return [...this.pending.values()].filter((r) => r.status === "pending");
  }

  /** Get pending requests for a specific session */
  getPendingForSession(sessionId: string): ApprovalRequest[] {
    return this.getPending().filter((r) => r.sessionId === sessionId);
  }

  /** Get a specific request */
  getRequest(requestId: string): ApprovalRequest | null {
    return this.pending.get(requestId) ?? null;
  }

  /** Auto-deny all pending approvals for a session (called on session stop/cancel) */
  denyAllForSession(sessionId: string): ApprovalRequest[] {
    const denied: ApprovalRequest[] = [];
    for (const req of this.getPendingForSession(sessionId)) {
      const resolved = this.resolve(req.id, "deny");
      if (resolved) denied.push(resolved);
    }
    return denied;
  }

  /** Update the timeout duration for future approvals */
  setTimeoutMs(ms: number): void {
    this.timeoutMs = ms;
  }

  /** Clean up resolved requests older than N ms */
  cleanup(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [id, req] of this.pending) {
      if (req.status === "resolved" && req.resolvedAt) {
        const resolvedTime = new Date(req.resolvedAt).getTime();
        if (resolvedTime < cutoff) {
          this.pending.delete(id);
          removed++;
        }
      }
    }
    return removed;
  }
}
