/**
 * RelayCluster — abstraction for relay topology.
 *
 * Current: SingleInstanceCluster (one relay handles everything).
 * Future: ShardedCluster (accounts routed to specific relay instances),
 *         FederatedCluster (relay instances discover each other).
 *
 * This module is a design marker. The interface exists so that relay code
 * can be structured to support future scaling without a rewrite.
 */

export interface RelayInstance {
  id: string;
  url: string;
  /** Number of active accounts on this instance */
  activeAccounts: number;
  /** Number of active connections */
  connections: number;
  /** Health status */
  healthy: boolean;
}

export interface RelayCluster {
  /** Get the relay instance responsible for an account. */
  getInstanceForAccount(accountId: string): RelayInstance;

  /** Register this instance in the cluster. */
  register(instance: RelayInstance): void;

  /** Deregister this instance from the cluster. */
  deregister(instanceId: string): void;

  /** List all known instances. */
  listInstances(): RelayInstance[];

  /** Check if this instance should handle a given account. */
  isLocal(accountId: string): boolean;
}

/**
 * SingleInstanceCluster — trivial implementation where one relay handles all accounts.
 * This is the current production implementation.
 */
export class SingleInstanceCluster implements RelayCluster {
  private instance: RelayInstance;

  constructor(opts?: { id?: string; url?: string }) {
    this.instance = {
      id: opts?.id ?? "local",
      url: opts?.url ?? "ws://localhost:7390",
      activeAccounts: 0,
      connections: 0,
      healthy: true,
    };
  }

  getInstanceForAccount(_accountId: string): RelayInstance {
    return this.instance;
  }

  register(_instance: RelayInstance): void {
    // No-op for single instance
  }

  deregister(_instanceId: string): void {
    // No-op for single instance
  }

  listInstances(): RelayInstance[] {
    return [this.instance];
  }

  isLocal(_accountId: string): boolean {
    return true; // All accounts are local
  }

  /** Update instance stats (called periodically by the relay). */
  updateStats(activeAccounts: number, connections: number): void {
    this.instance.activeAccounts = activeAccounts;
    this.instance.connections = connections;
  }
}
