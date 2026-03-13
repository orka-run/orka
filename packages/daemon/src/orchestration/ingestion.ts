import type { ProviderRuntimeEvent } from "@orka/core";
import type { OrchestrationEvent } from "./events";

const UNKNOWN_REQUEST_PREFIX = "unknown-request:";
const UNKNOWN_TURN_PREFIX = "unknown-turn:";
const USER_STOP_REASONS = new Set(["stopped", "cancelled", "canceled"]);

export function mapProviderEvent(sessionId: string, event: ProviderRuntimeEvent): OrchestrationEvent | null {
  switch (event.type) {
    case "session.started":
      return { type: "session.started", sessionId, timestamp: event.createdAt };
    case "session.state.changed":
      return {
        type: "session.state.changed",
        sessionId,
        state: event.payload.state,
        ...(event.payload.reason ? { reason: event.payload.reason } : {}),
        timestamp: event.createdAt,
      };
    case "turn.started":
      return { type: "turn.started", sessionId, turnId: getTurnId(event), timestamp: event.createdAt };
    case "turn.aborted":
      return {
        type: "turn.aborted",
        sessionId,
        turnId: getTurnId(event),
        reason: event.payload.reason,
        timestamp: event.createdAt,
      };
    case "content.delta":
      return {
        type: "content.delta",
        sessionId,
        turnId: getTurnId(event),
        streamKind: event.payload.streamKind,
        delta: event.payload.delta,
        timestamp: event.createdAt,
      };
    case "turn.completed":
      return {
        type: "turn.completed",
        sessionId,
        turnId: getTurnId(event),
        state: event.payload.state,
        ...(event.payload.stopReason ? { stopReason: event.payload.stopReason } : {}),
        ...(event.payload.totalCostUsd !== undefined ? { cost: event.payload.totalCostUsd } : {}),
        ...(event.payload.usage
          ? {
              tokens: {
                input: event.payload.usage.inputTokens,
                output: event.payload.usage.outputTokens,
              },
            }
          : {}),
        timestamp: event.createdAt,
      };
    case "item.started":
      return {
        type: "item.started",
        sessionId,
        turnId: getTurnId(event),
        itemId: getItemId(event),
        itemType: event.payload.itemType,
        ...(event.payload.status ? { status: event.payload.status } : {}),
        ...(event.payload.title ? { title: event.payload.title } : {}),
        ...(event.payload.detail ? { detail: event.payload.detail } : {}),
        ...(event.payload.args !== undefined ? { args: event.payload.args } : {}),
        timestamp: event.createdAt,
      };
    case "item.updated":
      return {
        type: "item.updated",
        sessionId,
        turnId: getTurnId(event),
        itemId: getItemId(event),
        itemType: event.payload.itemType,
        ...(event.payload.status ? { status: event.payload.status } : {}),
        ...(event.payload.title ? { title: event.payload.title } : {}),
        ...(event.payload.detail ? { detail: event.payload.detail } : {}),
        ...(event.payload.args !== undefined ? { args: event.payload.args } : {}),
        timestamp: event.createdAt,
      };
    case "item.completed":
      return {
        type: "item.completed",
        sessionId,
        turnId: getTurnId(event),
        itemId: getItemId(event),
        itemType: event.payload.itemType,
        status: event.payload.status ?? "completed",
        ...(event.payload.title ? { title: event.payload.title } : {}),
        ...(event.payload.detail ? { detail: event.payload.detail } : {}),
        ...(event.payload.args !== undefined ? { args: event.payload.args } : {}),
        timestamp: event.createdAt,
      };
    case "session.exited":
      if (isUserStop(event.payload.reason)) {
        return {
          type: "session.cancelled",
          sessionId,
          ...(event.payload.reason ? { reason: event.payload.reason } : {}),
          timestamp: event.createdAt,
        };
      }

      if (event.payload.exitKind === "error") {
        return {
          type: "session.failed",
          sessionId,
          error: event.payload.reason ?? "Provider session exited with an error",
          timestamp: event.createdAt,
        };
      }

      return { type: "session.completed", sessionId, exitCode: null, timestamp: event.createdAt };
    case "request.opened":
      return {
        type: "request.opened",
        sessionId,
        requestId: getRequestId(event),
        requestType: event.payload.requestType,
        ...(event.payload.detail ? { detail: event.payload.detail } : {}),
        timestamp: event.createdAt,
      };
    case "request.resolved":
      return {
        type: "request.resolved",
        sessionId,
        requestId: getRequestId(event),
        decision: event.payload.decision ?? "unknown",
        timestamp: event.createdAt,
      };
    case "tool.progress":
      return {
        type: "tool.progress",
        sessionId,
        turnId: getTurnId(event),
        ...(event.itemId ? { itemId: event.itemId } : {}),
        ...(event.payload.toolName ? { toolName: event.payload.toolName } : {}),
        ...(event.payload.summary ? { summary: event.payload.summary } : {}),
        ...(event.payload.elapsedSeconds !== undefined ? { elapsedSeconds: event.payload.elapsedSeconds } : {}),
        timestamp: event.createdAt,
      };
    case "runtime.error":
      return {
        type: "runtime.error",
        sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.itemId ? { itemId: event.itemId } : {}),
        error: event.payload.message,
        ...(event.payload.class ? { class: event.payload.class } : {}),
        timestamp: event.createdAt,
      };
    case "runtime.warning":
      return {
        type: "runtime.warning",
        sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.itemId ? { itemId: event.itemId } : {}),
        message: event.payload.message,
        timestamp: event.createdAt,
      };
    default:
      return null;
  }
}

function getItemId(event: ProviderRuntimeEvent): string {
  return event.itemId ?? `unknown-item:${event.eventId}`;
}

function getRequestId(event: ProviderRuntimeEvent): string {
  return event.requestId ?? `${UNKNOWN_REQUEST_PREFIX}${event.eventId}`;
}

function getTurnId(event: ProviderRuntimeEvent): string {
  return event.turnId ?? `${UNKNOWN_TURN_PREFIX}${event.eventId}`;
}

function isUserStop(reason?: string): boolean {
  if (!reason) {
    return false;
  }

  return USER_STOP_REASONS.has(reason.toLowerCase());
}
