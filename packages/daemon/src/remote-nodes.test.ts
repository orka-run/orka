import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { StoredNode } from "@orka/core";
import type { NodeRegistry } from "./node-registry";

// Mock WsTransport before importing module under test
const mockConnect = mock(() => {});
const mockDisconnect = mock(() => {});
const mockRequest = mock(() => Promise.resolve("result"));
const mockSubscribe = mock(() => () => {});
let capturedStateListener: ((snapshot: { state: string; reconnectAttempts: number }) => void) | null = null;
const mockOnStateChange = mock((listener: any) => {
  capturedStateListener = listener;
  return () => { capturedStateListener = null; };
});

const MockWsTransport = mock(function (this: any, _url: string, _opts?: any) {
  this.connect = mockConnect;
  this.disconnect = mockDisconnect;
  this.request = mockRequest;
  this.subscribe = mockSubscribe;
  this.onStateChange = mockOnStateChange;
  return this;
} as any);

mock.module("@orka/client", () => ({
  WsTransport: MockWsTransport,
  appendAuthToken: (url: string, token: string) => `${url}?token=${encodeURIComponent(token)}`,
}));

// Import after mock setup
const { createRemoteNodeManager } = await import("./remote-nodes");

function makeNode(overrides: Partial<StoredNode> = {}): StoredNode {
  return {
    nodeId: "node-test",
    nodeName: "Test Node",
    relayUrl: "wss://relay.example.com",
    nodePaths: ["wss://relay.example.com/ws/node-test"],
    pairedAt: "2026-01-01T00:00:00Z",
    noiseStaticPubkey: Buffer.from(new Uint8Array(32)).toString("base64url"),
    noiseKeyId: "sha256:abc123",
    autoConnect: false,
    ...overrides,
  };
}

function makeRegistry(nodes: StoredNode[] = []): NodeRegistry {
  return {
    save: mock(() => {}),
    load: mock((id: string) => nodes.find((n) => n.nodeId === id) ?? null),
    loadAll: mock(() => nodes),
    remove: mock(() => {}),
  };
}

describe("RemoteNodeManager", () => {
  beforeEach(() => {
    MockWsTransport.mockClear();
    mockConnect.mockClear();
    mockDisconnect.mockClear();
    mockRequest.mockClear();
    mockSubscribe.mockClear();
    mockOnStateChange.mockClear();
    capturedStateListener = null;
  });

  it("empty registry → listHandles returns []", () => {
    const mgr = createRemoteNodeManager(makeRegistry());
    expect(mgr.listHandles()).toEqual([]);
    mgr.shutdown();
  });

  it("connect() creates a handle with status tracking", async () => {
    const mgr = createRemoteNodeManager(makeRegistry());
    const node = makeNode();

    await mgr.connect(node);

    const handle = mgr.getHandle("node-test");
    expect(handle).not.toBeNull();
    expect(handle!.nodeId).toBe("node-test");
    expect(handle!.status).toBe("connecting");
    expect(mockConnect).toHaveBeenCalledTimes(1);

    // Simulate connected state
    capturedStateListener?.({ state: "connected", reconnectAttempts: 0 });
    expect(handle!.status).toBe("connected");
    expect(handle!.lastConnected).toBeGreaterThan(0);

    mgr.shutdown();
  });

  it("connect() appends relay token when present", async () => {
    const mgr = createRemoteNodeManager(makeRegistry());
    const node = makeNode({ relayToken: "secret123" });

    await mgr.connect(node);

    expect(MockWsTransport).toHaveBeenCalledTimes(1);
    const calledUrl = MockWsTransport.mock.calls[0][0];
    expect(calledUrl).toContain("?token=secret123");

    mgr.shutdown();
  });

  it("connect() is idempotent for same node", async () => {
    const mgr = createRemoteNodeManager(makeRegistry());
    const node = makeNode();

    await mgr.connect(node);
    await mgr.connect(node);

    expect(MockWsTransport).toHaveBeenCalledTimes(1);

    mgr.shutdown();
  });

  it("disconnect() removes handle", async () => {
    const mgr = createRemoteNodeManager(makeRegistry());
    await mgr.connect(makeNode());

    expect(mgr.getHandle("node-test")).not.toBeNull();

    mgr.disconnect("node-test");

    expect(mgr.getHandle("node-test")).toBeNull();
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(mgr.listHandles()).toHaveLength(0);

    mgr.shutdown();
  });

  it("disconnect() is safe for unknown node", () => {
    const mgr = createRemoteNodeManager(makeRegistry());
    expect(() => mgr.disconnect("nonexistent")).not.toThrow();
    mgr.shutdown();
  });

  it("getHandle() returns null for unknown node", () => {
    const mgr = createRemoteNodeManager(makeRegistry());
    expect(mgr.getHandle("unknown")).toBeNull();
    mgr.shutdown();
  });

  it("shutdown() disconnects all handles", async () => {
    const mgr = createRemoteNodeManager(makeRegistry());
    await mgr.connect(makeNode({ nodeId: "node-1" }));
    await mgr.connect(makeNode({ nodeId: "node-2" }));

    expect(mgr.listHandles()).toHaveLength(2);

    mgr.shutdown();

    expect(mgr.listHandles()).toHaveLength(0);
    expect(mockDisconnect).toHaveBeenCalledTimes(2);
  });

  it("request() delegates to transport", async () => {
    const mgr = createRemoteNodeManager(makeRegistry());
    await mgr.connect(makeNode());

    mockRequest.mockResolvedValueOnce({ sessions: [] });
    const result = await mgr.request("node-test", "listSessions", { status: "running" });

    expect(result).toEqual({ sessions: [] });
    expect(mockRequest).toHaveBeenCalledWith("listSessions", { status: "running" });

    mgr.shutdown();
  });

  it("request() throws for unknown node", () => {
    const mgr = createRemoteNodeManager(makeRegistry());
    expect(() => mgr.request("unknown", "test")).toThrow("No connection to node unknown");
    mgr.shutdown();
  });

  it("subscribePush() delegates to transport", async () => {
    const mgr = createRemoteNodeManager(makeRegistry());
    await mgr.connect(makeNode());

    const handler = mock(() => {});
    mgr.subscribePush("node-test", "sessions", handler);

    expect(mockSubscribe).toHaveBeenCalledWith("sessions", handler);

    mgr.shutdown();
  });

  it("subscribePush() throws for unknown node", () => {
    const mgr = createRemoteNodeManager(makeRegistry());
    expect(() => mgr.subscribePush("unknown", "ch", () => {})).toThrow(
      "No connection to node unknown",
    );
    mgr.shutdown();
  });

  it("auto-connects nodes with autoConnect: true", () => {
    const nodes = [
      makeNode({ nodeId: "auto-1", autoConnect: true }),
      makeNode({ nodeId: "no-auto", autoConnect: false }),
      makeNode({ nodeId: "auto-2", autoConnect: true }),
    ];
    const mgr = createRemoteNodeManager(makeRegistry(nodes));

    // auto-connect is async but fires immediately
    // WsTransport should have been constructed for the 2 autoConnect nodes
    expect(MockWsTransport).toHaveBeenCalledTimes(2);

    mgr.shutdown();
  });

  it("state change to disconnected updates handle", async () => {
    const mgr = createRemoteNodeManager(makeRegistry());
    await mgr.connect(makeNode());

    const handle = mgr.getHandle("node-test")!;
    capturedStateListener?.({ state: "connected", reconnectAttempts: 0 });
    expect(handle.status).toBe("connected");

    capturedStateListener?.({ state: "disconnected", reconnectAttempts: 0 });
    expect(handle.status).toBe("disconnected");

    mgr.shutdown();
  });
});
