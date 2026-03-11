import type { ApprovalRequest, ApprovalDecision } from "@orka/core";

export class ApprovalManager {
  private pending = new Map<string, ApprovalRequest>();

  /** Register a new approval request (from provider event) */
  addRequest(request: ApprovalRequest): void {
    this.pending.set(request.id, request);
  }

  /** Resolve a pending request with a decision */
  resolve(requestId: string, decision: ApprovalDecision): ApprovalRequest | null {
    const req = this.pending.get(requestId);
    if (!req || req.status !== "pending") return null;
    req.status = "resolved";
    req.decision = decision;
    req.resolvedAt = new Date().toISOString();
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
