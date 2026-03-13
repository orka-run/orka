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
  activeRequests: number;
  lastHeartbeatAt: number;
}

export interface PendingRequest {
  client: ServerWebSocket<SocketData>;
  nodeId: string;
  accountId: string;
  method: string;
  requestId: string | number;
  bytesIn: number;
  startedAt: number;
}

export interface AccountStats {
  nodes: number;
  clients: number;
  pending: number;
}

export interface GlobalStats {
  totalNodes: number;
  totalClients: number;
  totalPending: number;
  accounts: number;
}

// --- Relay State ---

export class RelayState {
  /** Account → Map<nodeId, NodeConnection> */
  private nodesByAccount = new Map<string, Map<string, NodeConnection>>();
  /** Composite key "accountId:requestId" → PendingRequest */
  private pending = new Map<string, PendingRequest>();
  /** Account → Set<WebSocket> (active client connections) */
  private clientsByAccount = new Map<string, Set<ServerWebSocket<SocketData>>>();

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
      activeRequests: 0,
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

  /** Pick least-loaded node within account scope */
  pickNode(accountId: string, requestedNode?: string): NodeConnection | null {
    const accountNodes = this.nodesByAccount.get(accountId);
    if (!accountNodes || accountNodes.size === 0) return null;

    if (requestedNode) {
      return accountNodes.get(requestedNode) ?? null;
    }

    // Least-loaded
    let best: NodeConnection | null = null;
    for (const node of accountNodes.values()) {
      if (!best || node.activeRequests < best.activeRequests) {
        best = node;
      }
    }
    return best;
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

  // --- Request Tracking ---

  private requestKey(accountId: string, requestId: string): string {
    return `${accountId}:${requestId}`;
  }

  trackRequest(accountId: string, requestId: string, pr: PendingRequest): void {
    this.pending.set(this.requestKey(accountId, requestId), pr);
    // Increment active requests on the node
    const node = this.getNode(accountId, pr.nodeId);
    if (node) node.activeRequests++;
  }

  resolveRequest(accountId: string, requestId: string): PendingRequest | null {
    const key = this.requestKey(accountId, requestId);
    const pr = this.pending.get(key);
    if (!pr) return null;
    this.pending.delete(key);
    // Decrement active requests on the node
    const node = this.getNode(accountId, pr.nodeId);
    if (node) node.activeRequests = Math.max(0, node.activeRequests - 1);
    return pr;
  }

  /** Fail all pending requests for a specific node within an account */
  failRequestsForNode(accountId: string, nodeId: string): PendingRequest[] {
    const failed: PendingRequest[] = [];
    for (const [key, pr] of this.pending) {
      if (pr.accountId === accountId && pr.nodeId === nodeId) {
        this.pending.delete(key);
        failed.push(pr);
      }
    }
    return failed;
  }

  /** Fail all pending requests from a specific client */
  failRequestsForClient(ws: ServerWebSocket<SocketData>): string[] {
    const removedIds: string[] = [];
    for (const [key, pr] of this.pending) {
      if (pr.client === ws) {
        this.pending.delete(key);
        // Decrement active requests on the node
        const node = this.getNode(pr.accountId, pr.nodeId);
        if (node) node.activeRequests = Math.max(0, node.activeRequests - 1);
        removedIds.push(key);
      }
    }
    return removedIds;
  }

  // --- Stats ---

  getAccountStats(accountId: string): AccountStats {
    return {
      nodes: this.getNodeCount(accountId),
      clients: this.getClientCount(accountId),
      pending: [...this.pending.values()].filter((p) => p.accountId === accountId).length,
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
      totalPending: this.pending.size,
      accounts: new Set([...this.nodesByAccount.keys(), ...this.clientsByAccount.keys()]).size,
    };
  }

  /** Get all node info for an account (for health endpoint) */
  getAccountNodes(accountId: string): { id: string; activeRequests: number; registeredAt: number }[] {
    const nodes = this.nodesByAccount.get(accountId);
    if (!nodes) return [];
    return [...nodes.values()].map((n) => ({
      id: n.id,
      activeRequests: n.activeRequests,
      registeredAt: n.registeredAt,
    }));
  }
}
