import { appendFile } from "node:fs/promises";
import { $ } from "bun";
import type {
  ApprovalRequest,
  ProviderRuntimeEvent,
  ProviderRuntimeEventOf,
  ProviderSessionHandle,
  SessionStatus,
  UsageRecord,
} from "@orka/core";
import type { ApprovalManager } from "../approval-manager";
import type { PushHub } from "../push-hub";
import { withSpan } from "../tracing";
import { deleteBranch, getWorktreeDir, worktreeMerge, worktreeRemove } from "../worktree";
import type { OrchestrationEngine } from "./engine";

const USER_STOP_REASONS = new Set(["stopped", "cancelled", "canceled"]);

export interface ProviderEventConsumerCallbacks {
  updateSessionStatus: (
    sessionId: string,
    status: SessionStatus,
    extra?: { startedAt?: string; finishedAt?: string; exitCode?: number },
  ) => void;
  saveSessionDiff: (sessionId: string, diff: string, status: string) => void;
  insertUsageRecord: (record: UsageRecord) => void;
  approvalManager: ApprovalManager;
  logFile?: string;
  pushHub?: PushHub;
  workingDir?: string;
  projectPath?: string;
  autoMerge?: boolean;
  model?: string | null;
  cleanupWorktree?: () => Promise<void>;
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
      callbacks.approvalManager.addRequest(toApprovalRequest(sessionId, handle, event));
      return;
    case "turn.completed":
      persistUsageRecord(sessionId, handle, event, callbacks);
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
    detail: event.payload.detail,
    args: event.payload.args,
    status: "pending",
    createdAt: event.createdAt,
  };
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
    costUsd: event.payload.totalCostUsd,
    model: callbacks.model ?? null,
    recordedAt: event.createdAt,
  });
}

async function finalizeSession(
  sessionId: string,
  event: ProviderRuntimeEventOf<"session.exited">,
  callbacks: ProviderEventConsumerCallbacks,
): Promise<void> {
  const status = getTerminalStatus(event);
  const finishedAt = event.createdAt;

  await captureSessionDiff(sessionId, callbacks);

  callbacks.updateSessionStatus(sessionId, status, { finishedAt });
  callbacks.pushHub?.broadcast("orchestration.sessionUpdated", {
    sessionId,
    status,
  });

  if (status === "completed" && callbacks.autoMerge) {
    await tryAutoMerge(sessionId, callbacks);
    return;
  }

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
        callbacks.saveSessionDiff(sessionId, diffText, statusText);
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

  const worktreeDir = getWorktreeDir();
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
