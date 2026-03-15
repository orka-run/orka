import type { StoredNode, PushChannel } from "@orka/core";
import {
  WsTransport,
  appendAuthToken,
  type NoiseConfig,
  type ConnectionState,
  type PushHandler,
  type WsTransportOptions,
} from "@orka/client";
import type { NodeRegistry } from "./node-registry";
import type { PushHub } from "./push-hub";

export type TransportFactory = (url: string, options?: WsTransportOptions) => WsTransport;

const FORWARDED_CHANNELS: PushChannel[] = [
  "orchestration.event",
  "orchestration.sessionUpdated",
  "orchestration.sessionDeleted",
];

export interface RemoteNodeHandle {
  nodeId: string;
  transport: WsTransport;
  status: ConnectionState;
  lastConnected: number | null;
  lastError: string | null;
}

export interface RemoteNodeManager {
  connect(node: StoredNode): Promise<void>;
  disconnect(nodeId: string): void;
  getHandle(nodeId: string): RemoteNodeHandle | null;
  listHandles(): RemoteNodeHandle[];
  /** Make an RPC request to a specific remote node */
  request<T>(nodeId: string, method: string, params?: unknown): Promise<T>;
  /** Subscribe to push events from a specific remote node */
  subscribePush(
    nodeId: string,
    channel: string,
    handler: PushHandler,
  ): () => void;
  shutdown(): void;
}

const defaultTransportFactory: TransportFactory = (url, options) => new WsTransport(url, options);

export function createRemoteNodeManager(
  registry: NodeRegistry,
  pushHub: PushHub,
  transportFactory: TransportFactory = defaultTransportFactory,
): RemoteNodeManager {
  const handles = new Map<string, RemoteNodeHandle>();
  const stateUnsubs = new Map<string, () => void>();
  const pushUnsubs = new Map<string, (() => void)[]>();

  function buildUrl(node: StoredNode): string {
    const base = node.nodePaths[0];
    if (!base) throw new Error(`No nodePaths for node ${node.nodeId}`);
    if (node.relayToken) {
      return appendAuthToken(base, node.relayToken);
    }
    return base;
  }

  function buildNoiseConfig(node: StoredNode): NoiseConfig {
    const publicKey = new Uint8Array(
      Buffer.from(node.noiseStaticPubkey, "base64url"),
    );
    let relayOrigin: string | undefined;
    try {
      relayOrigin = new URL(node.relayUrl).origin;
    } catch {
      // relayUrl may not be a valid URL in all cases
    }
    return {
      nodeId: node.nodeId,
      serverKey: {
        publicKey,
        keyId: node.noiseKeyId,
      },
      relayOrigin,
    };
  }

  async function connect(node: StoredNode): Promise<void> {
    if (handles.has(node.nodeId)) {
      return; // already connected/connecting
    }

    const url = buildUrl(node);
    const noiseConfig = buildNoiseConfig(node);

    console.error(
      `[remote-nodes] connecting to remote node ${node.nodeId} at ${node.nodePaths[0]}`,
    );

    const transport = transportFactory(url, { noiseConfig });

    const handle: RemoteNodeHandle = {
      nodeId: node.nodeId,
      transport,
      status: "connecting",
      lastConnected: null,
      lastError: null,
    };

    handles.set(node.nodeId, handle);

    // Subscribe to push channels from remote node and forward to local dashboard clients
    const unsubs: (() => void)[] = [];
    for (const channel of FORWARDED_CHANNELS) {
      const unsub = transport.subscribe(channel, (data: unknown) => {
        const forwarded =
          data && typeof data === "object"
            ? { ...(data as Record<string, unknown>), nodeId: node.nodeId }
            : data;
        pushHub.broadcast(channel, forwarded);
      });
      unsubs.push(unsub);
    }
    pushUnsubs.set(node.nodeId, unsubs);

    const stateUnsub = transport.onStateChange((snapshot) => {
      const h = handles.get(node.nodeId);
      if (!h) return;

      h.status = snapshot.state;

      if (snapshot.state === "connected") {
        h.lastConnected = Date.now();
        h.lastError = null;
        console.error(
          `[remote-nodes] remote node ${node.nodeId} connected`,
        );
        pushHub.broadcast("fleet.nodeUpdated", {
          nodeId: node.nodeId,
          status: "online",
        });
      } else if (snapshot.state === "disconnected") {
        console.error(
          `[remote-nodes] remote node ${node.nodeId} disconnected`,
        );
        pushHub.broadcast("fleet.nodeUpdated", {
          nodeId: node.nodeId,
          status: "offline",
        });
      }
    });
    stateUnsubs.set(node.nodeId, stateUnsub);

    transport.connect();
  }

  function disconnect(nodeId: string): void {
    const handle = handles.get(nodeId);
    if (!handle) return;

    const pUnsubs = pushUnsubs.get(nodeId);
    if (pUnsubs) {
      for (const unsub of pUnsubs) unsub();
      pushUnsubs.delete(nodeId);
    }

    const unsub = stateUnsubs.get(nodeId);
    if (unsub) {
      unsub();
      stateUnsubs.delete(nodeId);
    }

    handle.transport.disconnect();
    handles.delete(nodeId);
  }

  function getHandle(nodeId: string): RemoteNodeHandle | null {
    return handles.get(nodeId) ?? null;
  }

  function listHandles(): RemoteNodeHandle[] {
    return Array.from(handles.values());
  }

  function request<T>(
    nodeId: string,
    method: string,
    params?: unknown,
  ): Promise<T> {
    const handle = handles.get(nodeId);
    if (!handle) {
      throw new Error(`No connection to node ${nodeId}`);
    }
    return handle.transport.request<T>(method, params);
  }

  function subscribePush(
    nodeId: string,
    channel: string,
    handler: PushHandler,
  ): () => void {
    const handle = handles.get(nodeId);
    if (!handle) {
      throw new Error(`No connection to node ${nodeId}`);
    }
    return handle.transport.subscribe(channel, handler);
  }

  function shutdown(): void {
    for (const nodeId of [...handles.keys()]) {
      disconnect(nodeId);
    }
  }

  // Auto-connect nodes with autoConnect: true
  const autoConnectNodes = registry.loadAll().filter((n) => n.autoConnect);
  for (const node of autoConnectNodes) {
    connect(node).catch((err) => {
      console.error(
        `[remote-nodes] failed to auto-connect to ${node.nodeId}:`,
        err,
      );
      const h = handles.get(node.nodeId);
      if (h) {
        h.lastError = String(err);
      }
      pushHub.broadcast("fleet.nodeUpdated", {
        nodeId: node.nodeId,
        status: "error",
        error: String(err),
      });
    });
  }

  return {
    connect,
    disconnect,
    getHandle,
    listHandles,
    request,
    subscribePush,
    shutdown,
  };
}
