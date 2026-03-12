import { describe, test, expect, beforeEach } from "bun:test";
import { ApprovalManager } from "./approval-manager";
import type { ApprovalRequest } from "@orka/core";

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "req-1",
    sessionId: "sess-1",
    threadId: "thread-1",
    requestType: "command_execution_approval",
    status: "pending",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("ApprovalManager", () => {
  let mgr: ApprovalManager;

  beforeEach(() => {
    mgr = new ApprovalManager();
  });

  test("addRequest stores request as pending", () => {
    const req = makeRequest();
    mgr.addRequest(req);
    expect(mgr.getRequest("req-1")).toEqual(req);
    expect(mgr.getPending()).toHaveLength(1);
  });

  test("resolve marks request resolved with decision", () => {
    mgr.addRequest(makeRequest());
    const resolved = mgr.resolve("req-1", "approve");
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("resolved");
    expect(resolved!.decision).toBe("approve");
    expect(resolved!.resolvedAt).toBeDefined();
  });

  test("resolve returns null for unknown requestId", () => {
    expect(mgr.resolve("nonexistent", "deny")).toBeNull();
  });

  test("resolve returns null for already resolved request", () => {
    mgr.addRequest(makeRequest());
    mgr.resolve("req-1", "approve");
    expect(mgr.resolve("req-1", "deny")).toBeNull();
  });

  test("getPending returns only pending requests", () => {
    mgr.addRequest(makeRequest({ id: "req-1" }));
    mgr.addRequest(makeRequest({ id: "req-2" }));
    mgr.resolve("req-1", "approve");

    const pending = mgr.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe("req-2");
  });

  test("getPendingForSession filters by sessionId", () => {
    mgr.addRequest(makeRequest({ id: "req-1", sessionId: "sess-1" }));
    mgr.addRequest(makeRequest({ id: "req-2", sessionId: "sess-2" }));
    mgr.addRequest(makeRequest({ id: "req-3", sessionId: "sess-1" }));

    const forSess1 = mgr.getPendingForSession("sess-1");
    expect(forSess1).toHaveLength(2);
    expect(forSess1.map((r) => r.id).sort()).toEqual(["req-1", "req-3"]);

    const forSess2 = mgr.getPendingForSession("sess-2");
    expect(forSess2).toHaveLength(1);
    expect(forSess2[0]?.id).toBe("req-2");
  });

  test("cleanup removes old resolved requests", () => {
    const oldDate = new Date(Date.now() - 60_000).toISOString();
    mgr.addRequest(makeRequest({ id: "req-1" }));
    mgr.addRequest(makeRequest({ id: "req-2" }));

    // Resolve req-1 with an old timestamp
    mgr.resolve("req-1", "approve");
    const resolved = mgr.getRequest("req-1")!;
    resolved.resolvedAt = oldDate;

    // Cleanup with 30s threshold — should remove req-1
    const removed = mgr.cleanup(30_000);
    expect(removed).toBe(1);
    expect(mgr.getRequest("req-1")).toBeNull();
    expect(mgr.getRequest("req-2")).not.toBeNull();
  });

  test("cleanup does not remove recently resolved requests", () => {
    mgr.addRequest(makeRequest({ id: "req-1" }));
    mgr.resolve("req-1", "deny");

    const removed = mgr.cleanup(60_000);
    expect(removed).toBe(0);
    expect(mgr.getRequest("req-1")).not.toBeNull();
  });
});
