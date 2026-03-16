import type { OrkaConfig } from "./config";
import { loadConfig } from "./config";
import { DatabaseRepository, getOrkaHome, openDb } from "./db";
import { ApprovalManager } from "./approval-manager";
import { ClaudeCodeAdapter, CodexAdapter, ShellAdapter } from "./adapters";
import { OrchestrationEngine } from "./orchestration/engine";
import { ProviderAdapterRegistry } from "./provider-registry";
import { ProviderService } from "./provider-service";
import { PushHub } from "./push-hub";
import { createNodeRegistry, type NodeRegistry } from "./node-registry";
import { createRemoteNodeManager, type RemoteNodeManager } from "./remote-nodes";
import { recoverStaleSessions, cleanupOrphanedWorktrees } from "./orchestrator";

/**
 * All daemon-scoped dependencies.
 * Created once per daemon process (or per test) at the composition root.
 */
export interface DaemonContext {
  orkaHome: string;
  config: OrkaConfig;
  db: DatabaseRepository;
  pushHub: PushHub;
  providerAdapterRegistry: ProviderAdapterRegistry;
  providerService: ProviderService;
  orchestrationEngine: OrchestrationEngine;
  approvalManager: ApprovalManager;
  nodeRegistry: NodeRegistry;
  remoteNodes: RemoteNodeManager;
}

/**
 * Create a fully wired DaemonContext.
 * This is the composition root for the daemon — all dependencies are
 * created here and passed down via the context object.
 */
export function createDaemonContext(orkaHome?: string): DaemonContext {
  const home = orkaHome ?? getOrkaHome();
  const config = loadConfig(home);
  const rawDb = openDb(home);
  const db = new DatabaseRepository(rawDb);
  const pushHub = new PushHub();
  const approvalManager = new ApprovalManager({
    approvalTimeoutMinutes: config.limits.approvalTimeoutMinutes,
  });

  const providerAdapterRegistry = new ProviderAdapterRegistry();
  providerAdapterRegistry.register("claude-code", new ClaudeCodeAdapter());
  providerAdapterRegistry.register("codex", new CodexAdapter());
  providerAdapterRegistry.register("shell", new ShellAdapter());

  const providerService = new ProviderService(providerAdapterRegistry);

  const orchestrationEngine = new OrchestrationEngine({
    pushHub,
    persistEvent: (event) => db.insertOrchestrationEvent(event),
    getSessionTimeline: (sessionId) => db.getOrchestrationEvents(sessionId),
  });

  const nodeRegistry = createNodeRegistry(home);
  const remoteNodes = createRemoteNodeManager(nodeRegistry, pushHub);

  const ctx: DaemonContext = {
    orkaHome: home,
    config,
    db,
    pushHub,
    providerAdapterRegistry,
    providerService,
    orchestrationEngine,
    approvalManager,
    nodeRegistry,
    remoteNodes,
  };

  // Recover sessions left in running/preparing from a previous daemon process
  recoverStaleSessions(ctx);

  // Clean up orphaned worktrees in the background (don't block startup)
  void cleanupOrphanedWorktrees(ctx).then((cleaned) => {
    if (cleaned > 0) console.log(`cleaned ${cleaned} orphaned worktree(s)`);
  }).catch(() => { /* non-fatal */ });

  return ctx;
}
