import type { ServerWebSocket } from "bun";

// --- Types ---

export interface SocketData {
  role: "client" | "node";
  nodeId?: string;
  accountId: string;
  permissions: "client" | "node" | "admin";
  keyHash: string;
  connectedAt: number;
  messageCount: number;
  bytesIn: number;
  bytesOut: number;
}

export interface PairingSocketData {
  role: "pairing";
  enrollId: string;
  side: "registrant" | "joiner";
  accountId: string;
}

/** Union type for all WebSocket data variants used by the relay server. */
export type AnySocketData = SocketData | PairingSocketData;

export interface NodeConnection {
  id: string;
  accountId: string;
  ws: ServerWebSocket<SocketData>;
  registeredAt: number;
  lastHeartbeatAt: number;
}

export interface TransportBinding {
  nodeId: string;
  relayCid: string;
  accountId: string;
}

export interface AccountStats {
  nodes: number;
  clients: number;
  transportBindings: number;
}

export interface GlobalStats {
  totalNodes: number;
  totalClients: number;
  totalTransportBindings: number;
  accounts: number;
}

// --- Relay State ---

export class RelayState {
  /** Account → Map<nodeId, NodeConnection> */
  private nodesByAccount = new Map<string, Map<string, NodeConnection>>();
  /** Account → Set<WebSocket> (active client connections) */
  private clientsByAccount = new Map<string, Set<ServerWebSocket<SocketData>>>();
  /** Client WS → TransportBinding (client is in Noise transport mode) */
  private transportClients = new Map<ServerWebSocket<SocketData>, TransportBinding>();
  /** "accountId:relayCid" → client WS (reverse lookup for node→client routing) */
  private transportCidToClient = new Map<string, ServerWebSocket<SocketData>>();

  // --- Node Management ---

  registerNode(accountId: string, nodeId: string, ws: ServerWebSocket<SocketData>): void {
    let accountNodes = this.nodesByAccount.get(accountId);
    if (!accountNodes) {
      accountNodes = new Map();
      this.nodesByAccount.set(accountId, accountNodes);
    }
    accountNodes.set(nodeId, {
      id: nodeId,
      accountId,
      ws,
      registeredAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    });
  }

  removeNode(accountId: string, nodeId: string): void {
    const accountNodes = this.nodesByAccount.get(accountId);
    if (!accountNodes) return;
    accountNodes.delete(nodeId);
    if (accountNodes.size === 0) this.nodesByAccount.delete(accountId);
  }

  getNode(accountId: string, nodeId: string): NodeConnection | null {
    return this.nodesByAccount.get(accountId)?.get(nodeId) ?? null;
  }

  getNodeCount(accountId: string): number {
    return this.nodesByAccount.get(accountId)?.size ?? 0;
  }

  // --- Client Management ---

  addClient(accountId: string, ws: ServerWebSocket<SocketData>): void {
    let clients = this.clientsByAccount.get(accountId);
    if (!clients) {
      clients = new Set();
      this.clientsByAccount.set(accountId, clients);
    }
    clients.add(ws);
  }

  removeClient(accountId: string, ws: ServerWebSocket<SocketData>): void {
    const clients = this.clientsByAccount.get(accountId);
    if (!clients) return;
    clients.delete(ws);
    if (clients.size === 0) this.clientsByAccount.delete(accountId);
  }

  getClientCount(accountId: string): number {
    return this.clientsByAccount.get(accountId)?.size ?? 0;
  }

  // --- Transport Bindings (Noise through relay) ---

  /** Bind a client WS to a node for Noise transport. Returns a unique relay client ID. */
  bindTransportClient(clientWs: ServerWebSocket<SocketData>, accountId: string, nodeId: string): string {
    const relayCid = Math.random().toString(36).slice(2, 14);
    const binding: TransportBinding = { nodeId, relayCid, accountId };
    this.transportClients.set(clientWs, binding);
    this.transportCidToClient.set(`${accountId}:${relayCid}`, clientWs);
    return relayCid;
  }

  /** Get transport binding for a client WS (null if not in transport mode). */
  getTransportBinding(clientWs: ServerWebSocket<SocketData>): TransportBinding | null {
    return this.transportClients.get(clientWs) ?? null;
  }

  /** Look up the client WS for a relay client ID (for node→client routing). */
  getTransportClientWs(accountId: string, relayCid: string): ServerWebSocket<SocketData> | null {
    return this.transportCidToClient.get(`${accountId}:${relayCid}`) ?? null;
  }

  /** Remove a client's transport binding. */
  removeTransportClient(clientWs: ServerWebSocket<SocketData>): void {
    const binding = this.transportClients.get(clientWs);
    if (binding) {
      this.transportCidToClient.delete(`${binding.accountId}:${binding.relayCid}`);
      this.transportClients.delete(clientWs);
    }
  }

  /** Get all transport-mode clients bound to a specific node (for cleanup on node disconnect). */
  getTransportClientsForNode(accountId: string, nodeId: string): ServerWebSocket<SocketData>[] {
    const clients: ServerWebSocket<SocketData>[] = [];
    for (const [ws, binding] of this.transportClients) {
      if (binding.accountId === accountId && binding.nodeId === nodeId) {
        clients.push(ws);
      }
    }
    return clients;
  }

  /** Get the total number of active transport bindings. */
  getTransportBindingCount(): number {
    return this.transportClients.size;
  }

  // --- Stats ---

  getAccountStats(accountId: string): AccountStats {
    return {
      nodes: this.getNodeCount(accountId),
      clients: this.getClientCount(accountId),
      transportBindings: [...this.transportClients.values()].filter((b) => b.accountId === accountId).length,
    };
  }

  getGlobalStats(): GlobalStats {
    let totalNodes = 0;
    for (const nodes of this.nodesByAccount.values()) totalNodes += nodes.size;

    let totalClients = 0;
    for (const clients of this.clientsByAccount.values()) totalClients += clients.size;

    return {
      totalNodes,
      totalClients,
      totalTransportBindings: this.transportClients.size,
      accounts: new Set([...this.nodesByAccount.keys(), ...this.clientsByAccount.keys()]).size,
    };
  }

  /** Get all node info for an account (for health endpoint) */
  getAccountNodes(accountId: string): { id: string; registeredAt: number }[] {
    const nodes = this.nodesByAccount.get(accountId);
    if (!nodes) return [];
    return [...nodes.values()].map((n) => ({
      id: n.id,
      registeredAt: n.registeredAt,
    }));
  }
}
