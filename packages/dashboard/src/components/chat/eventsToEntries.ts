import type { OrchestrationEvent } from "@orka/core";
import type { ApprovalEntry } from "../ApprovalCard";
import { formatRelativeTime } from "../../lib/sessionUi";
import { shortenPaths } from "../../lib/pathUtils";

export type ToolIcon = "command" | "file" | "read" | "search" | "web" | "agent";

export interface ToolEntry {
  id: string;
  timestamp: string;
  title: string;
  summary: string;
  icon: ToolIcon;
  details: string[];
  args?: unknown;
  inProgress?: boolean;
}

export interface SystemEntry {
  id: string;
  type: "system";
  timestamp: string;
  title: string;
  body: string;
  tone?: "default" | "warning" | "error" | "info";
}

export interface AssistantEntry {
  id: string;
  type: "assistant";
  timestamp: string;
  body: string;
}

export interface UserEntry {
  id: string;
  type: "user";
  timestamp: string;
  body: string;
  queued?: boolean;
}

export interface ToolCallGroup {
  id: string;
  type: "tool-group";
  timestamp: string;
  tools: ToolEntry[];
}

export interface RateLimitEntry {
  id: string;
  type: "rate-limit";
  timestamp: string;
  title: string;
  body: string;
  tone: "warning" | "error";
  scheduledResumeAt?: string;
}

export interface ApiRetryEntry {
  id: string;
  type: "api-retry";
  timestamp: string;
  body: string;
}

export interface ErrorEntry {
  id: string;
  type: "error";
  timestamp: string;
  title: string;
  body: string;
}

export type ChatEntry =
  | SystemEntry
  | AssistantEntry
  | UserEntry
  | ToolCallGroup
  | RateLimitEntry
  | ApiRetryEntry
  | ErrorEntry
  | ApprovalEntry;

export type ThinkingState = "thinking" | "tools" | "writing" | "idle";

function itemIcon(itemType: string): ToolIcon {
  switch (itemType) {
    case "file_change":
      return "file";
    case "file_read":
      return "read";
    case "search":
      return "search";
    case "web":
      return "web";
    case "agent":
      return "agent";
    case "command_execution":
      return "command";
    default:
      return "command";
  }
}

function shortenPath(text: string, projectPath?: string): string {
  return shortenPaths(text, projectPath ?? null);
}

function formatPercent(value?: number): string | null {
  if (value === undefined || !Number.isFinite(value)) {
    return null;
  }

  return `${Math.round(value * 100)}%`;
}

function formatRelativeResetTime(epochSeconds: number, now = Date.now()): string | null {
  const resetAtMs = epochSeconds * 1000;
  if (!Number.isFinite(resetAtMs)) {
    return null;
  }

  const deltaMs = resetAtMs - now;
  if (deltaMs <= 0) {
    return "now";
  }

  const totalMinutes = Math.round(deltaMs / 60_000);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function formatResetAt(epochSeconds: number): string {
  return formatRelativeTime(new Date(epochSeconds * 1000).toISOString());
}

function formatRetryError(error: string): string {
  return error.replace(/_error$/i, "").replace(/_/g, " ");
}

function humanizeInlineLabel(value: string): string {
  return value.replace(/_/g, " ").trim();
}

function formatProgressBody(
  event: Extract<OrchestrationEvent, { type: "tool.progress" }>,
  workDir?: string,
): string {
  const summary = event.summary ? shortenPath(event.summary, workDir) : "";
  if (summary) {
    return summary;
  }

  if (event.toolName) {
    return `${humanizeInlineLabel(event.toolName)}...`;
  }

  return "Working...";
}

function formatTaskStartedBody(
  event: Extract<OrchestrationEvent, { type: "task.started" }>,
  workDir?: string,
): string {
  const title = event.title ? shortenPath(event.title, workDir) : "";
  const detail = event.detail ? shortenPath(event.detail, workDir) : "";
  if (title && detail && detail !== title) {
    return `${title} - ${detail}`;
  }

  return title || detail || "Subtask started.";
}

function formatTaskCompletedBody(
  event: Extract<OrchestrationEvent, { type: "task.completed" }>,
  workDir?: string,
): string {
  const summary = event.summary ? shortenPath(event.summary, workDir) : "";
  const status = event.status ? humanizeInlineLabel(event.status) : "";
  if (summary && status && summary !== status) {
    return `${summary} (${status})`;
  }

  return summary || status || "Subtask completed.";
}

function formatHookBody(
  event: Extract<OrchestrationEvent, { type: "hook.started" | "hook.response" }>,
): string {
  if (event.type === "hook.started") {
    return event.matcher ? `${event.hookName} (${event.matcher}) started` : `${event.hookName} started`;
  }

  const name = event.hookName ?? "Hook";
  const decision = event.decision ? humanizeInlineLabel(event.decision) : "";
  if (decision && event.reason) {
    return `${name} - ${decision}: ${event.reason}`;
  }
  if (decision) {
    return `${name} - ${decision}`;
  }
  if (event.reason) {
    return `${name} - ${event.reason}`;
  }

  return name;
}

function formatCompactionBody(
  event: Extract<OrchestrationEvent, { type: "session.compacted" }>,
): string {
  if (event.tokenCountBefore !== undefined && event.tokenCountAfter !== undefined) {
    return `Trimmed context from ${String(event.tokenCountBefore)} to ${String(event.tokenCountAfter)} tokens.`;
  }

  if (event.tokenCountBefore !== undefined) {
    return `Trimmed context near ${String(event.tokenCountBefore)} tokens.`;
  }

  if (event.reason) {
    return event.reason;
  }

  return "Older context was trimmed.";
}

export function deriveThinkingState(events: OrchestrationEvent[]): ThinkingState {
  const completedItemIds = new Set<string>();
  for (const event of events) {
    if (event.type === "item.completed") {
      completedItemIds.add(event.itemId);
    }
  }

  for (const event of events) {
    if (event.type === "item.started" && !completedItemIds.has(event.itemId)) {
      return "tools";
    }
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) {
      continue;
    }

    switch (event.type) {
      case "content.delta":
        return "writing";
      case "turn.started":
        return "thinking";
      case "tool.progress":
      case "task.started":
      case "task.completed":
        return "tools";
      case "turn.completed":
      case "turn.aborted":
      case "session.completed":
      case "session.failed":
      case "session.cancelled":
        return "idle";
      case "item.completed":
      case "item.updated":
        return "thinking";
      case "event.passthrough":
        continue;
      default:
        continue;
    }
  }

  return "idle";
}

export function eventsToEntries(
  events: OrchestrationEvent[],
  initialPrompt?: string,
  workDir?: string,
): ChatEntry[] {
  const scheduledRateLimitKeys = new Set(
    events
      .filter((event): event is Extract<OrchestrationEvent, { type: "session.rate_limited" }> =>
        event.type === "session.rate_limited" && typeof event.scheduledResumeAt === "string",
      )
      .map((event) => `${event.rateLimitType}:${String(event.resetsAt)}`),
  );
  const completedItemIds = new Set<string>();
  const startedMeta = new Map<string, { title?: string; detail?: string; itemType: string; args?: unknown }>();

  for (const event of events) {
    if (event.type === "item.completed") {
      completedItemIds.add(event.itemId);
    }
    if (event.type === "item.started") {
      startedMeta.set(event.itemId, {
        itemType: event.itemType,
        ...(event.title !== undefined ? { title: event.title } : {}),
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
        ...(event.args !== undefined ? { args: event.args } : {}),
      });
    }
  }

  const resolvedRequests = new Map<string, string>();
  for (const event of events) {
    if (event.type === "request.resolved") {
      resolvedRequests.set(event.requestId, event.decision);
    }
  }

  const entries: ChatEntry[] = [];
  let accum = "";
  let accumTurnId: string | null = null;
  let accumStart: string | null = null;
  let pendingTools: ToolEntry[] = [];
  let queuedMessagesReadyForDelivery = false;
  const pendingQueuedEntryIds = new Set<string>();

  function clearPendingQueuedEntries() {
    if (!queuedMessagesReadyForDelivery || pendingQueuedEntryIds.size === 0) {
      return;
    }

    for (const entry of entries) {
      if (entry.type === "user" && entry.queued && pendingQueuedEntryIds.has(entry.id)) {
        entry.queued = false;
      }
    }

    pendingQueuedEntryIds.clear();
    queuedMessagesReadyForDelivery = false;
  }

  function flushAssistant() {
    if (accum && accumStart) {
      entries.push({
        id: `assistant-${accumTurnId ?? "unknown"}-${accumStart}`,
        type: "assistant",
        timestamp: accumStart,
        body: accum,
      });
    }

    accum = "";
    accumTurnId = null;
    accumStart = null;
  }

  function flushToolGroup() {
    if (pendingTools.length === 0) {
      return;
    }

    const first = pendingTools[0];
    if (!first) {
      return;
    }

    entries.push({
      id: `tool-group-${first.id}`,
      type: "tool-group",
      timestamp: first.timestamp,
      tools: pendingTools,
    });
    pendingTools = [];
  }

  if (initialPrompt) {
    const timestamp = events[0]?.timestamp ?? new Date().toISOString();
    entries.push({
      id: `initial-prompt-${timestamp}`,
      type: "user",
      timestamp,
      body: initialPrompt,
    });
  }

  for (const event of events) {
    if (
      queuedMessagesReadyForDelivery &&
      (
        event.type === "turn.started" ||
        event.type === "content.delta" ||
        event.type === "item.started" ||
        event.type === "item.updated" ||
        event.type === "item.completed" ||
        event.type === "request.opened" ||
        event.type === "tool.progress" ||
        event.type === "task.started" ||
        event.type === "task.completed"
      )
    ) {
      clearPendingQueuedEntries();
    }

    if (event.type === "content.delta") {
      if (event.streamKind === "assistant_text" || event.streamKind === "reasoning_text") {
        if (pendingTools.length > 0) {
          flushToolGroup();
        }
        if (accumTurnId !== event.turnId) {
          flushAssistant();
          accumTurnId = event.turnId;
          accumStart = event.timestamp;
        }
        accum += event.delta;
      }
      continue;
    }

    if (event.type === "item.started") {
      if (completedItemIds.has(event.itemId)) {
        continue;
      }

      flushAssistant();
      const title = shortenPath(event.title ?? event.itemType, workDir);
      const detail = shortenPath(event.detail ?? "", workDir);
      const isInProgress = !completedItemIds.has(event.itemId);
      const summary = detail && detail !== title ? detail : (isInProgress ? "In progress…" : "Completed");

      pendingTools.push({
        id: event.itemId,
        timestamp: event.timestamp,
        title,
        summary,
        icon: itemIcon(event.itemType),
        details: detail && detail !== title ? [detail] : [],
        ...(event.args !== undefined ? { args: event.args } : {}),
        ...(isInProgress ? { inProgress: true } : {}),
      });
      continue;
    }

    if (event.type === "item.completed") {
      flushAssistant();
      const meta = startedMeta.get(event.itemId);
      const itemType = event.itemType !== "unknown" ? event.itemType : (meta?.itemType ?? event.itemType);
      const title = shortenPath(event.title ?? meta?.title ?? itemType, workDir);
      const startedDetail = meta?.detail ? shortenPath(meta.detail, workDir) : "";
      const outputDetail = event.detail ? shortenPath(event.detail, workDir) : "";
      const summary = startedDetail && startedDetail !== title ? startedDetail : "Completed";
      const detailContent = outputDetail || (startedDetail !== title ? startedDetail : "");
      const args = meta?.args ?? event.args;

      pendingTools.push({
        id: event.itemId,
        timestamp: event.timestamp,
        title,
        summary,
        icon: itemIcon(itemType),
        details: detailContent ? [detailContent] : [],
        ...(args !== undefined ? { args } : {}),
      });
      continue;
    }

    if (event.type === "item.updated") {
      continue;
    }

    if (event.type === "request.opened") {
      flushAssistant();
      flushToolGroup();
      const decision = resolvedRequests.get(event.requestId);
      const status: ApprovalEntry["status"] =
        decision === "approve" || decision === "approve_session"
          ? "approved"
          : decision === "deny" || decision === "cancel"
            ? "denied"
            : "pending";

      entries.push({
        id: `approval-${event.requestId}`,
        type: "approval",
        timestamp: event.timestamp,
        requestId: event.requestId,
        requestType: event.requestType,
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
        status,
      });
      continue;
    }

    if (event.type === "request.resolved") {
      continue;
    }

    if (event.type === "event.passthrough") {
      flushAssistant();
      flushToolGroup();
      entries.push({
        id: `passthrough-${event.sessionId}-${event.timestamp}`,
        type: "system",
        timestamp: event.timestamp,
        title: `Unrecognized event: ${event.originalType}`,
        body:
          typeof event.rawPayload === "object"
            ? (JSON.stringify(event.rawPayload, null, 2) ?? "")
            : String(event.rawPayload ?? ""),
      });
      continue;
    }

    if (
      event.type === "turn.completed" ||
      event.type === "turn.aborted" ||
      event.type === "user.input" ||
      event.type === "session.rate_limited" ||
      event.type === "session.api_retry" ||
      event.type === "tool.progress" ||
      event.type === "task.started" ||
      event.type === "task.completed" ||
      event.type === "hook.started" ||
      event.type === "hook.response" ||
      event.type === "session.status" ||
      event.type === "session.compacted"
    ) {
      flushAssistant();
      flushToolGroup();
    }

    if (event.type === "session.created" || event.type === "session.started" || event.type === "turn.started") {
      continue;
    }

    switch (event.type) {
      case "tool.progress":
        entries.push({
          id: `tool-progress-${event.timestamp}-${event.itemId ?? event.turnId}`,
          type: "system",
          timestamp: event.timestamp,
          title: event.toolName ? humanizeInlineLabel(event.toolName) : "Progress",
          body: formatProgressBody(event, workDir),
          tone: "info",
        });
        break;
      case "task.started":
        entries.push({
          id: `task-started-${event.timestamp}-${event.taskId ?? event.itemId ?? event.turnId}`,
          type: "system",
          timestamp: event.timestamp,
          title: "Task started",
          body: formatTaskStartedBody(event, workDir),
          tone: "info",
        });
        break;
      case "task.completed":
        entries.push({
          id: `task-completed-${event.timestamp}-${event.taskId ?? event.itemId ?? event.turnId}`,
          type: "system",
          timestamp: event.timestamp,
          title: "Task completed",
          body: formatTaskCompletedBody(event, workDir),
          tone: "info",
        });
        break;
      case "hook.started":
      case "hook.response":
        entries.push({
          id: `hook-${event.type}-${event.timestamp}-${event.hookName ?? "unknown"}`,
          type: "system",
          timestamp: event.timestamp,
          title: "Hook",
          body: formatHookBody(event),
          tone: "info",
        });
        break;
      case "session.status":
        entries.push({
          id: `session-status-${event.timestamp}-${event.status}`,
          type: "system",
          timestamp: event.timestamp,
          title: "Status",
          body: event.detail ? `${humanizeInlineLabel(event.status)} - ${event.detail}` : humanizeInlineLabel(event.status),
          tone: "info",
        });
        break;
      case "session.compacted":
        entries.push({
          id: `session-compacted-${event.timestamp}`,
          type: "system",
          timestamp: event.timestamp,
          title: "Context compacted",
          body: formatCompactionBody(event),
          tone: "info",
        });
        break;
      case "turn.completed": {
        if (pendingQueuedEntryIds.size > 0) {
          queuedMessagesReadyForDelivery = true;
        }
        const parts: string[] = [];
        if (event.cost != null) {
          parts.push(`$${event.cost.toFixed(4)}`);
        }
        if (event.tokens) {
          parts.push(`${String(event.tokens.input)} in / ${String(event.tokens.output)} out`);
        }
        if (parts.length > 0) {
          entries.push({
            id: `turn-completed-${event.turnId}`,
            type: "system",
            timestamp: event.timestamp,
            title: "Turn completed",
            body: parts.join(" · "),
          });
        }
        break;
      }
      case "turn.aborted":
        entries.push({
          id: `turn-aborted-${event.turnId}`,
          type: "error",
          timestamp: event.timestamp,
          title: "Turn aborted",
          body: event.reason,
        });
        break;
      case "user.input": {
        const entry: UserEntry = {
          id: `user-input-${event.sessionId}-${event.timestamp}`,
          type: "user",
          timestamp: event.timestamp,
          body: event.text,
          ...(event.queued ? { queued: true } : {}),
        };
        entries.push(entry);
        if (event.queued) {
          pendingQueuedEntryIds.add(entry.id);
        }
        break;
      }
      case "session.completed":
        flushToolGroup();
        entries.push({
          id: `${event.sessionId}-completed-${event.timestamp}`,
          type: "system",
          timestamp: event.timestamp,
          title: "Session completed",
          body: event.exitCode != null ? `Exited with code ${String(event.exitCode)}.` : "The agent finished cleanly.",
        });
        break;
      case "session.failed":
        flushToolGroup();
        entries.push({
          id: `${event.sessionId}-failed-${event.timestamp}`,
          type: "error",
          timestamp: event.timestamp,
          title: "Session failed",
          body: event.error,
        });
        break;
      case "session.cancelled":
        flushToolGroup();
        entries.push({
          id: `${event.sessionId}-cancelled-${event.timestamp}`,
          type: "system",
          timestamp: event.timestamp,
          title: "Session cancelled",
          body: event.reason ?? "The session was cancelled.",
        });
        break;
      case "runtime.error":
        entries.push({
          id: `runtime-error-${event.timestamp}-${event.turnId ?? ""}`,
          type: "error",
          timestamp: event.timestamp,
          title: "Runtime error",
          body: event.error,
        });
        break;
      case "runtime.warning":
        entries.push({
          id: `runtime-warning-${event.timestamp}`,
          type: "system",
          timestamp: event.timestamp,
          title: "Warning",
          body: event.message,
          tone: "warning",
        });
        break;
      case "session.rate_limited": {
        if (event.scheduledResumeAt) {
          entries.push({
            id: `rate-limit-${event.timestamp}`,
            type: "rate-limit",
            timestamp: event.timestamp,
            title: "Rate limit reached",
            body: `Rate limit reached - auto-resuming at ${formatResetAt(event.resetsAt)}`,
            tone: "warning",
            scheduledResumeAt: event.scheduledResumeAt,
          });
          break;
        }

        if (!event.status || event.status === "allowed") {
          break;
        }

        if (event.status === "rejected" && scheduledRateLimitKeys.has(`${event.rateLimitType}:${String(event.resetsAt)}`)) {
          break;
        }

        const resetText =
          event.status === "rejected"
            ? `resets at ${formatResetAt(event.resetsAt)}`
            : `resets in ${formatRelativeResetTime(event.resetsAt) ?? formatResetAt(event.resetsAt)}`;

        entries.push({
          id: `rate-limit-${event.timestamp}`,
          type: "rate-limit",
          timestamp: event.timestamp,
          title: event.status === "rejected" ? "Rate limit exceeded" : "Rate limit warning",
          body:
            event.status === "rejected"
              ? `Rate limit exceeded - ${resetText}`
              : `Rate limit: ${formatPercent(event.utilization) ?? "warning"} used (${resetText})`,
          tone: event.status === "rejected" ? "error" : "warning",
          ...(event.scheduledResumeAt ? { scheduledResumeAt: event.scheduledResumeAt } : {}),
        });
        break;
      }
      case "session.api_retry":
        entries.push({
          id: `api-retry-${event.timestamp}-${event.attempt}`,
          type: "api-retry",
          timestamp: event.timestamp,
          body: `API retry (attempt ${String(event.attempt)}/${String(event.maxAttempts)}) - ${formatRetryError(event.error)}, waiting ${String(Math.max(1, Math.round(event.delayMs / 1000)))}s`,
        });
        break;
      default:
        break;
    }
  }

  flushAssistant();
  flushToolGroup();

  const hasTerminalEvent = events.some((event) =>
    event.type === "session.completed" || event.type === "session.failed" || event.type === "session.cancelled",
  );

  if (hasTerminalEvent) {
    for (const entry of entries) {
      if (entry.type === "tool-group") {
        for (const tool of entry.tools) {
          tool.inProgress = false;
        }
      }
    }
  }

  return entries;
}
