import type { StoredNode } from "@orka/core";
import {
  WsTransport,
  appendAuthToken,
  type NoiseConfig,
  type ConnectionState,
  type PushHandler,
} from "@orka/client";
import type { NodeRegistry } from "./node-registry";

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

export function createRemoteNodeManager(
  registry: NodeRegistry,
): RemoteNodeManager {
  const handles = new Map<string, RemoteNodeHandle>();
  const stateUnsubs = new Map<string, () => void>();

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

    const transport = new WsTransport(url, { noiseConfig });

    const handle: RemoteNodeHandle = {
      nodeId: node.nodeId,
      transport,
      status: "connecting",
      lastConnected: null,
      lastError: null,
    };

    handles.set(node.nodeId, handle);

    const unsub = transport.onStateChange((snapshot) => {
      const h = handles.get(node.nodeId);
      if (!h) return;

      h.status = snapshot.state;

      if (snapshot.state === "connected") {
        h.lastConnected = Date.now();
        h.lastError = null;
        console.error(
          `[remote-nodes] remote node ${node.nodeId} connected`,
        );
      } else if (snapshot.state === "disconnected") {
        console.error(
          `[remote-nodes] remote node ${node.nodeId} disconnected`,
        );
      }
    });
    stateUnsubs.set(node.nodeId, unsub);

    transport.connect();
  }

  function disconnect(nodeId: string): void {
    const handle = handles.get(nodeId);
    if (!handle) return;

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
