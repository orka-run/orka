import type { OrkaConfig } from "./config";
import { loadConfig } from "./config";
import { DatabaseRepository, getOrkaHome, openDb, migrateDb } from "./db";
import { ApprovalManager } from "./approval-manager";
import { ClaudeCodeAdapter, CodexAdapter } from "./adapters";
import { HookApprovalBridge } from "./hook-approval-bridge";
import { OrchestrationEngine } from "./orchestration/engine";
import { ProviderAdapterRegistry } from "./provider-registry";
import { ProviderService } from "./provider-service";
import { PushHub } from "./push-hub";
import { createNodeRegistry, type NodeRegistry } from "./node-registry";
import { createRemoteNodeManager, type RemoteNodeManager } from "./remote-nodes";
import { recoverStaleSessions, cleanupOrphanedWorktrees } from "./orchestrator";

/** Per-session runtime state that lives in-memory (not persisted).
 *  Moved here from module-level singletons for DI/testability. */
export interface SessionRuntimeState {
  /** Per-session idle timers. When a session goes idle, a timer starts.
   *  When it fires, the process is killed and the session is set to "hibernated". */
  idleTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Per-session follow-up messages queued while the agent is still finishing the current turn. */
  pendingMessages: Map<string, string[]>;
  /** Tracks which sessions have already auto-merged (one-shot on first idle). */
  autoMergeFired: Set<string>;
  /** Per-session checkpoint turn counters. */
  turnCounts: Map<string, number>;
  /** Per-session checkpoint chains to serialize git snapshot work. */
  checkpointCaptureChains: Map<string, Promise<void>>;
}

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
  hookApprovalBridge: HookApprovalBridge;
  nodeRegistry: NodeRegistry;
  remoteNodes: RemoteNodeManager;
  sessionRuntime: SessionRuntimeState;
}

/**
 * Create a fully wired DaemonContext.
 * This is the composition root for the daemon — all dependencies are
 * created here and passed down via the context object.
 */
export async function createDaemonContext(orkaHome?: string): Promise<DaemonContext> {
  const home = orkaHome ?? getOrkaHome();
  const config = loadConfig(home);
  const rawDb = openDb(home);
  await migrateDb(rawDb, home);
  const db = new DatabaseRepository(rawDb);
  const pushHub = new PushHub();
  const approvalManager = new ApprovalManager({
    approvalTimeoutMinutes: config.limits.approvalTimeoutMinutes,
  });

  const providerAdapterRegistry = new ProviderAdapterRegistry();
  providerAdapterRegistry.register("claude-code", new ClaudeCodeAdapter());
  providerAdapterRegistry.register("codex", new CodexAdapter());

  const providerService = new ProviderService(providerAdapterRegistry);

  const orchestrationEngine = new OrchestrationEngine({
    pushHub,
    persistEvent: (event) => db.insertOrchestrationEvent(event),
    getSessionTimeline: (sessionId) => db.getOrchestrationEvents(sessionId),
  });

  const hookApprovalBridge = new HookApprovalBridge(
    approvalManager,
    pushHub,
    orchestrationEngine,
    { timeoutMs: (config.limits.approvalTimeoutMinutes ?? 5) * 60_000 },
  );

  const nodeRegistry = createNodeRegistry(home);
  const remoteNodes = createRemoteNodeManager(nodeRegistry, pushHub);

  const sessionRuntime: SessionRuntimeState = {
    idleTimers: new Map(),
    pendingMessages: new Map(),
    autoMergeFired: new Set(),
    turnCounts: new Map(),
    checkpointCaptureChains: new Map(),
  };

  const ctx: DaemonContext = {
    orkaHome: home,
    config,
    db,
    pushHub,
    providerAdapterRegistry,
    providerService,
    orchestrationEngine,
    approvalManager,
    hookApprovalBridge,
    nodeRegistry,
    remoteNodes,
    sessionRuntime,
  };

  // Recover sessions left in running/preparing from a previous daemon process
  recoverStaleSessions(ctx);

  // Clean up orphaned worktrees in the background (don't block startup)
  void cleanupOrphanedWorktrees(ctx).then((cleaned) => {
    if (cleaned > 0) console.log(`cleaned ${cleaned} orphaned worktree(s)`);
  }).catch(() => { /* non-fatal */ });

  return ctx;
}
