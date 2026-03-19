import { describe, expect, it } from "bun:test";
import type { SessionSummary } from "@orka/core";
import { createSessionCache } from "./session-cache";

function makeSummary(id: string, overrides?: Partial<SessionSummary>): SessionSummary {
  return {
    id,
    status: "running",
    backend: "claude-code",
    title: `Session ${id}`,
    createdAt: new Date().toISOString(),
    nodeId: null,
    ...overrides,
  };
}

describe("SessionCache", () => {
  it("setNodeSessions + getAllSessions round-trip", () => {
    const cache = createSessionCache();
    const sessions = [makeSummary("sess-001"), makeSummary("sess-002")];

    cache.setNodeSessions("node-a", sessions);

    const all = cache.getAllSessions();
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.id).sort()).toEqual(["sess-001", "sess-002"]);
  });

  it("upsertSession updates existing session", () => {
    const cache = createSessionCache();
    cache.setNodeSessions("node-a", [makeSummary("sess-001", { status: "running" })]);

    cache.upsertSession("node-a", makeSummary("sess-001", { status: "completed" }));

    const all = cache.getAllSessions();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("completed");
  });

  it("upsertSession adds new session", () => {
    const cache = createSessionCache();
    cache.setNodeSessions("node-a", [makeSummary("sess-001")]);

    cache.upsertSession("node-a", makeSummary("sess-002"));

    const all = cache.getAllSessions();
    expect(all).toHaveLength(2);
  });

  it("removeSession removes from both maps", () => {
    const cache = createSessionCache();
    cache.setNodeSessions("node-a", [makeSummary("sess-001"), makeSummary("sess-002")]);

    cache.removeSession("sess-001");

    expect(cache.getAllSessions()).toHaveLength(1);
    expect(cache.getAllSessions()[0]!.id).toBe("sess-002");
    expect(cache.getOwningNode("sess-001")).toBeNull();
  });

  it("getOwningNode returns correct node", () => {
    const cache = createSessionCache();
    cache.setNodeSessions("node-a", [makeSummary("sess-001")]);
    cache.setNodeSessions("node-b", [makeSummary("sess-002")]);

    expect(cache.getOwningNode("sess-001")).toBe("node-a");
    expect(cache.getOwningNode("sess-002")).toBe("node-b");
  });

  it("getOwningNode returns null for unknown session", () => {
    const cache = createSessionCache();
    expect(cache.getOwningNode("sess-unknown")).toBeNull();
  });

  it("clearNode removes all sessions for that node", () => {
    const cache = createSessionCache();
    cache.setNodeSessions("node-a", [makeSummary("sess-001"), makeSummary("sess-002")]);
    cache.setNodeSessions("node-b", [makeSummary("sess-003")]);

    cache.clearNode("node-a");

    expect(cache.getAllSessions()).toHaveLength(1);
    expect(cache.getAllSessions()[0]!.id).toBe("sess-003");
    expect(cache.getOwningNode("sess-001")).toBeNull();
    expect(cache.getOwningNode("sess-002")).toBeNull();
    expect(cache.getOwningNode("sess-003")).toBe("node-b");
  });

  it("multiple nodes: sessions from different nodes don't interfere", () => {
    const cache = createSessionCache();
    cache.setNodeSessions("node-a", [makeSummary("sess-001"), makeSummary("sess-002")]);
    cache.setNodeSessions("node-b", [makeSummary("sess-003"), makeSummary("sess-004")]);

    expect(cache.getAllSessions()).toHaveLength(4);

    // Update session on node-a doesn't affect node-b
    cache.upsertSession("node-a", makeSummary("sess-001", { status: "completed" }));
    expect(cache.getOwningNode("sess-001")).toBe("node-a");
    expect(cache.getOwningNode("sess-003")).toBe("node-b");

    // Remove session from node-b doesn't affect node-a
    cache.removeSession("sess-003");
    expect(cache.getAllSessions()).toHaveLength(3);
    expect(cache.getOwningNode("sess-001")).toBe("node-a");

    // Clear node-b doesn't affect node-a
    cache.clearNode("node-b");
    expect(cache.getAllSessions()).toHaveLength(2);
    expect(cache.getAllSessions().map((s) => s.id).sort()).toEqual(["sess-001", "sess-002"]);
  });

  it("setNodeSessions replaces previous sessions for the node", () => {
    const cache = createSessionCache();
    cache.setNodeSessions("node-a", [makeSummary("sess-001"), makeSummary("sess-002")]);

    // Replace with different sessions
    cache.setNodeSessions("node-a", [makeSummary("sess-003")]);

    expect(cache.getAllSessions()).toHaveLength(1);
    expect(cache.getAllSessions()[0]!.id).toBe("sess-003");
    expect(cache.getOwningNode("sess-001")).toBeNull();
    expect(cache.getOwningNode("sess-002")).toBeNull();
    expect(cache.getOwningNode("sess-003")).toBe("node-a");
  });

  it("upsertSession to new node creates node entry", () => {
    const cache = createSessionCache();
    cache.upsertSession("node-new", makeSummary("sess-001"));

    expect(cache.getAllSessions()).toHaveLength(1);
    expect(cache.getOwningNode("sess-001")).toBe("node-new");
  });

  it("removeSession is a no-op for unknown session", () => {
    const cache = createSessionCache();
    cache.setNodeSessions("node-a", [makeSummary("sess-001")]);

    cache.removeSession("sess-unknown"); // should not throw

    expect(cache.getAllSessions()).toHaveLength(1);
  });

  it("clearNode is a no-op for unknown node", () => {
    const cache = createSessionCache();
    cache.setNodeSessions("node-a", [makeSummary("sess-001")]);

    cache.clearNode("node-unknown"); // should not throw

    expect(cache.getAllSessions()).toHaveLength(1);
  });
});
