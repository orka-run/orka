import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { StoredNode } from "@orka/core";
import type { WsTransport } from "@orka/client";
import type { NodeRegistry } from "./node-registry";
import type { PushHub } from "./push-hub";
import { createRemoteNodeManager, type TransportFactory } from "./remote-nodes";

const mockConnect = mock(() => {});
const mockDisconnect = mock(() => {});
const mockRequest = mock(async (): Promise<unknown> => "result");
const mockSubscribe = mock(() => () => {});
let capturedStateListener: ((snapshot: { state: string; reconnectAttempts: number }) => void) | null = null;
const mockOnStateChange = mock((listener: (snapshot: { state: string; reconnectAttempts: number }) => void) => {
  capturedStateListener = listener;
  return () => { capturedStateListener = null; };
});

let transportConstructions: Array<{ url: string; opts: unknown }> = [];

const mockTransportFactory: TransportFactory = (url, opts) => {
  transportConstructions.push({ url, opts });
  return {
    connect: mockConnect,
    disconnect: mockDisconnect,
    request: mockRequest,
    subscribe: mockSubscribe,
    onStateChange: mockOnStateChange,
    registerChannelTransform: mock(() => () => {}),
    onProtocolMismatch: mock(() => () => {}),
    getServerCapabilities: mock(() => null),
    get connectionState() { return "disconnected" as const; },
  } as unknown as WsTransport;
};

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

const mockBroadcast = mock(() => {});

function makePushHub(): PushHub {
  return { broadcast: mockBroadcast } as unknown as PushHub;
}

describe("RemoteNodeManager", () => {
  beforeEach(() => {
    transportConstructions = [];
    mockConnect.mockClear();
    mockDisconnect.mockClear();
    mockRequest.mockClear();
    mockSubscribe.mockClear();
    mockOnStateChange.mockClear();
    mockBroadcast.mockClear();
    capturedStateListener = null;
  });

  it("empty registry → listHandles returns []", () => {
    const mgr = createRemoteNodeManager(makeRegistry(), makePushHub(), mockTransportFactory);
    expect(mgr.listHandles()).toEqual([]);
    mgr.shutdown();
  });

  it("connect() creates a handle with status tracking", async () => {
    const mgr = createRemoteNodeManager(makeRegistry(), makePushHub(), mockTransportFactory);
    const node = makeNode();

    await mgr.connect(node);

    const handle = mgr.getHandle("node-test");
    if (!handle) throw new Error("expected handle");
    expect(handle.nodeId).toBe("node-test");
    expect(handle.status).toBe("connecting");
    expect(mockConnect).toHaveBeenCalledTimes(1);

    // Simulate connected state
    capturedStateListener?.({ state: "connected", reconnectAttempts: 0 });
    expect(handle.status).toBe("connected");
    expect(handle.lastConnected).toBeGreaterThan(0);

    mgr.shutdown();
  });

  it("connect() appends relay token when present", async () => {
    const mgr = createRemoteNodeManager(makeRegistry(), makePushHub(), mockTransportFactory);
    const node = makeNode({ relayToken: "secret123" });

    await mgr.connect(node);

    expect(transportConstructions).toHaveLength(1);
    if (!transportConstructions[0]) throw new Error("expected transport construction");
    expect(transportConstructions[0].url).toContain("?token=secret123");

    mgr.shutdown();
  });

  it("connect() is idempotent for same node", async () => {
    const mgr = createRemoteNodeManager(makeRegistry(), makePushHub(), mockTransportFactory);
    const node = makeNode();

    await mgr.connect(node);
    await mgr.connect(node);

    expect(transportConstructions).toHaveLength(1);

    mgr.shutdown();
  });

  it("disconnect() removes handle", async () => {
    const mgr = createRemoteNodeManager(makeRegistry(), makePushHub(), mockTransportFactory);
    await mgr.connect(makeNode());

    expect(mgr.getHandle("node-test")).not.toBeNull();

    mgr.disconnect("node-test");

    expect(mgr.getHandle("node-test")).toBeNull();
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(mgr.listHandles()).toHaveLength(0);

    mgr.shutdown();
  });

  it("disconnect() is safe for unknown node", () => {
    const mgr = createRemoteNodeManager(makeRegistry(), makePushHub(), mockTransportFactory);
    expect(() => mgr.disconnect("nonexistent")).not.toThrow();
    mgr.shutdown();
  });

  it("getHandle() returns null for unknown node", () => {
    const mgr = createRemoteNodeManager(makeRegistry(), makePushHub(), mockTransportFactory);
    expect(mgr.getHandle("unknown")).toBeNull();
    mgr.shutdown();
  });

  it("shutdown() disconnects all handles", async () => {
    const mgr = createRemoteNodeManager(makeRegistry(), makePushHub(), mockTransportFactory);
    await mgr.connect(makeNode({ nodeId: "node-1" }));
    await mgr.connect(makeNode({ nodeId: "node-2" }));

    expect(mgr.listHandles()).toHaveLength(2);

    mgr.shutdown();

    expect(mgr.listHandles()).toHaveLength(0);
    expect(mockDisconnect).toHaveBeenCalledTimes(2);
  });

  it("request() delegates to transport", async () => {
    const mgr = createRemoteNodeManager(makeRegistry(), makePushHub(), mockTransportFactory);
    await mgr.connect(makeNode());

    mockRequest.mockImplementationOnce(async () => ({ sessions: [], snapshotSequence: 0 }));
    const result = await mgr.request("node-test", "listSessions", { filters: { status: "running" } });

    expect(result).toEqual({ sessions: [], snapshotSequence: 0 });
    expect(mockRequest).toHaveBeenCalledWith("listSessions", { filters: { status: "running" } });

    mgr.shutdown();
  });

  it("request() throws for unknown node", () => {
    const mgr = createRemoteNodeManager(makeRegistry(), makePushHub(), mockTransportFactory);
    expect(() => mgr.request("unknown", "reap")).toThrow("No connection to node unknown");
    mgr.shutdown();
  });

  it("subscribePush() delegates to transport", async () => {
    const mgr = createRemoteNodeManager(makeRegistry(), makePushHub(), mockTransportFactory);
    await mgr.connect(makeNode());

    const handler = mock(() => {});
    mgr.subscribePush("node-test", "sessions", handler);

    expect(mockSubscribe).toHaveBeenCalledWith("sessions", handler);

    mgr.shutdown();
  });

  it("subscribePush() throws for unknown node", () => {
    const mgr = createRemoteNodeManager(makeRegistry(), makePushHub(), mockTransportFactory);
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
    const mgr = createRemoteNodeManager(makeRegistry(nodes), makePushHub(), mockTransportFactory);

    expect(transportConstructions).toHaveLength(2);

    mgr.shutdown();
  });

  it("state change to disconnected updates handle", async () => {
    const mgr = createRemoteNodeManager(makeRegistry(), makePushHub(), mockTransportFactory);
    await mgr.connect(makeNode());

    const handle = mgr.getHandle("node-test");
    if (!handle) throw new Error("expected handle");
    capturedStateListener?.({ state: "connected", reconnectAttempts: 0 });
    expect(handle.status).toBe("connected");

    capturedStateListener?.({ state: "disconnected", reconnectAttempts: 0 });
    expect(handle.status).toBe("disconnected");

    mgr.shutdown();
  });

  it("broadcasts fleet.nodeUpdated on connect/disconnect", async () => {
    const mgr = createRemoteNodeManager(makeRegistry(), makePushHub(), mockTransportFactory);
    await mgr.connect(makeNode());

    capturedStateListener?.({ state: "connected", reconnectAttempts: 0 });
    expect(mockBroadcast).toHaveBeenCalledWith("fleet.nodeUpdated", {
      nodeId: "node-test",
      status: "online",
    });

    mockBroadcast.mockClear();
    capturedStateListener?.({ state: "disconnected", reconnectAttempts: 0 });
    expect(mockBroadcast).toHaveBeenCalledWith("fleet.nodeUpdated", {
      nodeId: "node-test",
      status: "offline",
    });

    mgr.shutdown();
  });

  it("subscribes to forwarded push channels on connect", async () => {
    const mgr = createRemoteNodeManager(makeRegistry(), makePushHub(), mockTransportFactory);
    await mgr.connect(makeNode());

    // 3 forwarded channels + the explicit subscribePush calls if any
    const subscribedChannels = (
      mockSubscribe.mock.calls as unknown as Array<[string, (...args: unknown[]) => void]>
    ).map((c) => c[0]);
    expect(subscribedChannels).toContain("orchestration.event");
    expect(subscribedChannels).toContain("orchestration.sessionUpdated");
    expect(subscribedChannels).toContain("orchestration.sessionDeleted");

    mgr.shutdown();
  });

  it("forwards push events with nodeId attached", async () => {
    const mgr = createRemoteNodeManager(makeRegistry(), makePushHub(), mockTransportFactory);
    await mgr.connect(makeNode());

    // Find the handler registered for orchestration.event
    const eventCall = (
      mockSubscribe.mock.calls as unknown as Array<[string, (data: unknown) => void]>
    ).find(
      (c) => c[0] === "orchestration.event",
    );
    if (!eventCall) throw new Error("expected event call");
    const handler = eventCall[1];

    // Simulate a push event from remote node
    handler({ sessionId: "sess-123", type: "started" });

    expect(mockBroadcast).toHaveBeenCalledWith("orchestration.event", {
      sessionId: "sess-123",
      type: "started",
      nodeId: "node-test",
    });

    mgr.shutdown();
  });

  it("forwards non-object push data without nodeId", async () => {
    const mgr = createRemoteNodeManager(makeRegistry(), makePushHub(), mockTransportFactory);
    await mgr.connect(makeNode());

    const eventCall = (
      mockSubscribe.mock.calls as unknown as Array<[string, (data: unknown) => void]>
    ).find(
      (c) => c[0] === "orchestration.event",
    );
    if (!eventCall) throw new Error("expected event call");
    const handler = eventCall[1];

    handler("plain-string");

    expect(mockBroadcast).toHaveBeenCalledWith(
      "orchestration.event",
      "plain-string",
    );

    mgr.shutdown();
  });
});
