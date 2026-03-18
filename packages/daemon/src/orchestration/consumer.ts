import { appendFile } from "node:fs/promises";
import { $ } from "bun";
import type {
  ApprovalRequest,
  ProviderApprovalDecision,
  RawProviderLine,
  ProviderRuntimeEvent,
  ProviderRuntimeEventOf,
  ProviderSessionHandle,
  Session,
  SessionStatus,
  UsageRecord,
} from "@orka/core";
import type { ApprovalManager } from "../approval-manager";
import { evaluatePermission, extractToolInfo, type PermissionRuleSet } from "../permission-rules";
import type { PushHub } from "../push-hub";
import { getDaemonMetrics, withSpan } from "../tracing";
import { deleteBranch, getWorktreeDir, worktreeMerge, worktreeRemove } from "../worktree";
import type { OrchestrationEngine } from "./engine";

const USER_STOP_REASONS = new Set(["stopped", "cancelled", "canceled"]);

export interface ProviderEventConsumerCallbacks {
  updateSessionStatus: (
    sessionId: string,
    status: SessionStatus,
    extra?: { startedAt?: string; finishedAt?: string; exitCode?: number },
  ) => void;
  saveSessionDiff: (sessionId: string, diff: string, status: string, extra?: { commitLog?: string; commitDiff?: string }) => void;
  insertUsageRecord: (record: UsageRecord) => void;
  approvalManager: ApprovalManager;
  logFile?: string;
  rawLogPath?: string;
  pushHub?: PushHub;
  workingDir?: string;
  projectPath?: string;
  autoMerge?: boolean;
  model?: string | null;
  orkaHome?: string;
  cleanupWorktree?: () => Promise<void>;
  getSession?: (sessionId: string) => Session | null;
  permissionRules?: PermissionRuleSet;
  respondToRequest?: (threadId: string, requestId: string, decision: ProviderApprovalDecision) => Promise<void>;
  /** Deny all pending hook-based approvals for a session (called on session exit). */
  denyHookApprovals?: (sessionId: string) => void;
  /** Called when a turn completes and session transitions to idle. Used to start hibernate timer. */
  onSessionIdle?: (sessionId: string) => Promise<void> | void;
  /** Sends follow-up messages queued while the current turn was still running. */
  deliverPendingMessages?: (sessionId: string) => Promise<boolean> | boolean;
  /** Clears any queued follow-up messages for sessions that exit before delivery. */
  clearPendingMessages?: (sessionId: string) => void;
  /** Called when a turn completes and should trigger a git checkpoint capture. */
  onTurnCheckpoint?: (sessionId: string, turnSeq: number, workingDir: string) => void;
  /** Returns the next checkpoint turn sequence for a session. */
  getNextTurnSeq?: (sessionId: string) => number;
  /** Shared set tracking which sessions have already auto-merged (injected from DaemonContext). */
  autoMergeFired?: Set<string>;
}

export async function consumeProviderEvents(
  sessionId: string,
  handle: ProviderSessionHandle,
  engine: OrchestrationEngine,
  callbacks: ProviderEventConsumerCallbacks,
): Promise<void> {
  await withSpan(
    "orka.orchestration.consume_provider_events",
    { "orka.session.id": sessionId, "orka.backend": handle.provider },
    async (span) => {
      // Start raw log writer in parallel (fire-and-forget with error handling)
      if (callbacks.rawLogPath && handle.rawEvents) {
        void writeRawLog(callbacks.rawLogPath, handle.rawEvents).catch((error) => {
          span.addEvent("orka.orchestration.raw_log_write_failed", {
            "orka.error": error instanceof Error ? error.message : String(error),
          });
        });
      }

      try {
        for await (const event of handle.events) {
          span.addEvent("orka.orchestration.provider_event", {
            "orka.provider.event_type": event.type,
          });
          engine.ingest(sessionId, event);
          await handleProviderEvent(sessionId, handle, event, callbacks);
        }
      } catch (error) {
        const finishedAt = new Date().toISOString();
        callbacks.updateSessionStatus(sessionId, "failed", { finishedAt });
        recordSessionTerminalMetrics(callbacks.getSession?.(sessionId)?.startedAt ?? null, finishedAt, "failed");
        callbacks.pushHub?.broadcast("orchestration.sessionUpdated", {
          sessionId,
          status: "failed",
        });
        throw error;
      }
    },
  );
}

async function handleProviderEvent(
  sessionId: string,
  handle: ProviderSessionHandle,
  event: ProviderRuntimeEvent,
  callbacks: ProviderEventConsumerCallbacks,
): Promise<void> {
  switch (event.type) {
    case "content.delta":
      await appendContentDelta(callbacks.logFile, event);
      callbacks.pushHub?.broadcast("session.logLine", {
        sessionId,
        content: event.payload.delta,
        line: event.payload.delta,
      });
      return;
    case "request.opened":
      await handleRequestOpened(sessionId, handle, event, callbacks);
      return;
    case "turn.completed":
      persistUsageRecord(sessionId, handle, event, callbacks);
      await handleTurnCompleted(sessionId, callbacks);
      return;
    case "session.exited":
      await finalizeSession(sessionId, event, callbacks);
      return;
    default:
      return;
  }
}

async function appendContentDelta(
  logFile: string | undefined,
  event: ProviderRuntimeEventOf<"content.delta">,
): Promise<void> {
  if (!logFile) {
    return;
  }

  await appendFile(logFile, event.payload.delta, "utf8");
}

function toApprovalRequest(
  sessionId: string,
  handle: ProviderSessionHandle,
  event: ProviderRuntimeEventOf<"request.opened">,
): ApprovalRequest {
  return {
    id: event.requestId ?? `unknown-request:${event.eventId}`,
    sessionId,
    threadId: handle.threadId,
    requestType: event.payload.requestType,
    ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
    ...(event.payload.args !== undefined ? { args: event.payload.args } : {}),
    status: "pending",
    createdAt: event.createdAt,
  };
}

async function handleRequestOpened(
  sessionId: string,
  handle: ProviderSessionHandle,
  event: ProviderRuntimeEventOf<"request.opened">,
  callbacks: ProviderEventConsumerCallbacks,
): Promise<void> {
  const request = toApprovalRequest(sessionId, handle, event);

  if (callbacks.permissionRules && callbacks.respondToRequest) {
    const { tool, input } = extractToolInfo(request);
    const decision = evaluatePermission(callbacks.permissionRules, tool, input);

    if (decision === "auto_approve") {
      await callbacks.respondToRequest(handle.threadId, request.id, "approve");
      callbacks.pushHub?.broadcast("orchestration.event", {
        sessionId,
        type: "permission.auto_approved",
        tool,
        detail: event.payload.detail,
      });
      return;
    }

    if (decision === "auto_deny") {
      await callbacks.respondToRequest(handle.threadId, request.id, "deny");
      callbacks.pushHub?.broadcast("orchestration.event", {
        sessionId,
        type: "permission.auto_denied",
        tool,
        detail: event.payload.detail,
      });
      return;
    }
  }

  callbacks.approvalManager.addRequest(request);
}

function persistUsageRecord(
  sessionId: string,
  handle: ProviderSessionHandle,
  event: ProviderRuntimeEventOf<"turn.completed">,
  callbacks: ProviderEventConsumerCallbacks,
): void {
  if (!event.payload.usage && event.payload.totalCostUsd === undefined) {
    return;
  }

  callbacks.insertUsageRecord({
    sessionId,
    backend: handle.provider,
    inputTokens: event.payload.usage?.inputTokens ?? 0,
    outputTokens: event.payload.usage?.outputTokens ?? 0,
    cacheReadTokens: 0,
    costUsd: event.payload.totalCostUsd ?? null,
    model: callbacks.model ?? null,
    recordedAt: event.createdAt,
  });
}

async function handleTurnCompleted(
  sessionId: string,
  callbacks: ProviderEventConsumerCallbacks,
): Promise<void> {
  const workingDir = callbacks.workingDir;
  const turnSeq = callbacks.getNextTurnSeq?.(sessionId);
  if (workingDir && turnSeq !== undefined) {
    callbacks.onTurnCheckpoint?.(sessionId, turnSeq, workingDir);
  }

  // Transition session to "idle" — the turn is done, process is still alive
  callbacks.updateSessionStatus(sessionId, "idle");
  callbacks.pushHub?.broadcast("orchestration.sessionUpdated", {
    sessionId,
    status: "idle",
  });

  const deliveredPendingMessages = await callbacks.deliverPendingMessages?.(sessionId);
  if (deliveredPendingMessages) {
    return;
  }

  // Auto-merge fires on first idle transition (preserves old "background completes and merges" behavior)
  if (callbacks.autoMerge && !callbacks.autoMergeFired?.has(sessionId)) {
    callbacks.autoMergeFired?.add(sessionId);
    await tryAutoMerge(sessionId, callbacks);
    // After successful auto-merge, mark session as completed
    const session = callbacks.getSession?.(sessionId);
    if (session?.status === "idle") {
      // Auto-merge succeeded — session is done
      callbacks.updateSessionStatus(sessionId, "completed", { finishedAt: new Date().toISOString() });
      callbacks.pushHub?.broadcast("orchestration.sessionUpdated", {
        sessionId,
        status: "completed",
      });
      return;
    }
  }

  // Notify orchestrator to start idle timer
  await callbacks.onSessionIdle?.(sessionId);
}

async function finalizeSession(
  sessionId: string,
  event: ProviderRuntimeEventOf<"session.exited">,
  callbacks: ProviderEventConsumerCallbacks,
): Promise<void> {
  callbacks.clearPendingMessages?.(sessionId);

  // Clean up auto-merge tracking
  callbacks.autoMergeFired?.delete(sessionId);

  // Check current session state — if already hibernated (by idle timer), don't overwrite
  const currentSession = callbacks.getSession?.(sessionId);
  if (currentSession?.status === "hibernated" || currentSession?.status === "completed") {
    // Process was killed for hibernation or session was already closed — don't change status
    return;
  }

  const status = getTerminalStatus(event);
  const finishedAt = event.createdAt;

  await captureSessionDiff(sessionId, callbacks);

  callbacks.updateSessionStatus(sessionId, status, { finishedAt });
  recordSessionTerminalMetrics(currentSession?.startedAt ?? null, finishedAt, status);

  // Auto-deny any pending approvals — session is done, no one can approve anymore
  const pending = callbacks.approvalManager.getPendingForSession(sessionId);
  for (const req of pending) {
    callbacks.approvalManager.resolve(req.id, "deny");
  }
  // Also deny pending hook-based approvals (unblocks long-polling hook scripts)
  callbacks.denyHookApprovals?.(sessionId);

  callbacks.pushHub?.broadcast("orchestration.sessionUpdated", {
    sessionId,
    status,
  });

  if (status === "cancelled") {
    await callbacks.cleanupWorktree?.();
  }
}

function getTerminalStatus(event: ProviderRuntimeEventOf<"session.exited">): SessionStatus {
  if (isUserStop(event.payload.reason)) {
    return "cancelled";
  }

  if (event.payload.exitKind === "error") {
    return "failed";
  }

  return "completed";
}

function isUserStop(reason?: string): boolean {
  if (!reason) {
    return false;
  }

  return USER_STOP_REASONS.has(reason.toLowerCase());
}

async function captureSessionDiff(
  sessionId: string,
  callbacks: ProviderEventConsumerCallbacks,
): Promise<void> {
  if (!callbacks.workingDir) {
    return;
  }

  await withSpan(
    "orka.orchestration.capture_diff",
    { "orka.session.id": sessionId, "orka.workdir": callbacks.workingDir },
    async (span) => {
      try {
        const statusText = (await $`git -C ${callbacks.workingDir} status`.text()).trim();
        const diffText = (await $`git -C ${callbacks.workingDir} diff`.text()).trim();

        // Capture committed changes vs parent branch
        let commitLog: string | undefined;
        let commitDiff: string | undefined;
        if (callbacks.projectPath) {
          try {
            const branch = (await $`git -C ${callbacks.workingDir} rev-parse --abbrev-ref HEAD`.quiet().text()).trim();
            if (branch && branch !== "HEAD") {
              const mainHead = (await $`git -C ${callbacks.projectPath} rev-parse HEAD`.quiet().text()).trim();
              const mergeBase = (await $`git -C ${callbacks.workingDir} merge-base ${mainHead} HEAD`.quiet().text()).trim();
              if (mergeBase) {
                const log = (await $`git -C ${callbacks.workingDir} log --oneline ${mergeBase}..HEAD`.quiet().text()).trim();
                if (log) {
                  commitLog = log;
                  commitDiff = (await $`git -C ${callbacks.workingDir} diff ${mergeBase}..HEAD`.quiet().text()).trim();
                }
              }
            }
          } catch {
            // Branch diff is best-effort
          }
        }

        callbacks.saveSessionDiff(sessionId, diffText, statusText, {
          ...(commitLog ? { commitLog } : {}),
          ...(commitDiff ? { commitDiff } : {}),
        });
      } catch {
        span.addEvent("orka.orchestration.capture_diff_skipped");
      }
    },
  );
}

async function tryAutoMerge(
  sessionId: string,
  callbacks: ProviderEventConsumerCallbacks,
): Promise<void> {
  const { projectPath, workingDir } = callbacks;
  if (!projectPath || !workingDir) {
    return;
  }

  if (!callbacks.orkaHome) return;
  const worktreeDir = getWorktreeDir(callbacks.orkaHome);
  if (!workingDir.startsWith(worktreeDir)) {
    return;
  }

  await withSpan(
    "orka.orchestration.auto_merge",
    { "orka.session.id": sessionId, "orka.workdir": workingDir, "orka.project_path": projectPath },
    async (span) => {
      try {
        const { branch, commits } = await worktreeMerge(projectPath, workingDir);
        span.addEvent("orka.orchestration.auto_merged", {
          "orka.branch": branch,
          "orka.commits": commits,
        });

        try {
          await worktreeRemove(projectPath, workingDir);
          await deleteBranch(projectPath, branch);
        } catch {
          span.addEvent("orka.orchestration.auto_merge_cleanup_failed", {
            "orka.branch": branch,
          });
        }
      } catch (error) {
        span.recordException(error as Error);
        span.addEvent("orka.orchestration.auto_merge_failed");
      }
    },
  );
}

function recordSessionTerminalMetrics(
  startedAt: string | null,
  finishedAt: string,
  status: SessionStatus,
): void {
  if (status !== "completed" && status !== "failed" && status !== "cancelled") {
    return;
  }

  const metrics = getDaemonMetrics();

  switch (status) {
    case "completed":
      metrics.sessionsCompleted.add(1);
      break;
    case "failed":
      metrics.sessionsFailed.add(1);
      break;
    case "cancelled":
      metrics.sessionsCancelled.add(1);
      break;
  }

  if (!startedAt) {
    return;
  }

  metrics.sessionsActive.add(-1);

  const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    metrics.sessionDuration.record(durationMs);
  }
}

async function writeRawLog(path: string, rawEvents: AsyncIterable<RawProviderLine>): Promise<void> {
  for await (const line of rawEvents) {
    await appendFile(path, JSON.stringify(line) + "\n", "utf8");
  }
}
