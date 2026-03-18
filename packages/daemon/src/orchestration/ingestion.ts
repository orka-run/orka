import type { ProviderRuntimeEvent } from "@orka/core";
import type { OrchestrationEvent } from "./events";

const UNKNOWN_REQUEST_PREFIX = "unknown-request:";
const UNKNOWN_TURN_PREFIX = "unknown-turn:";
const USER_STOP_REASONS = new Set(["stopped", "cancelled", "canceled"]);

export function mapProviderEvent(sessionId: string, event: ProviderRuntimeEvent): OrchestrationEvent {
  switch (event.type) {
    case "session.started":
      return { v: 1, eventId: event.eventId, type: "session.started", sessionId, timestamp: event.createdAt };
    case "session.state.changed":
      return {
        v: 1,
        eventId: event.eventId,
        type: "session.state.changed",
        sessionId,
        state: event.payload.state,
        ...(event.payload.reason ? { reason: event.payload.reason } : {}),
        timestamp: event.createdAt,
      };
    case "turn.started":
      return { v: 1, eventId: event.eventId, type: "turn.started", sessionId, turnId: getTurnId(event), timestamp: event.createdAt };
    case "turn.aborted":
      return {
        v: 1,
        eventId: event.eventId,
        type: "turn.aborted",
        sessionId,
        turnId: getTurnId(event),
        reason: event.payload.reason,
        timestamp: event.createdAt,
      };
    case "content.delta":
      return {
        v: 1,
        eventId: event.eventId,
        type: "content.delta",
        sessionId,
        turnId: getTurnId(event),
        streamKind: event.payload.streamKind,
        delta: event.payload.delta,
        timestamp: event.createdAt,
      };
    case "turn.completed":
      return {
        v: 1,
        eventId: event.eventId,
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
        v: 1,
        eventId: event.eventId,
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
        v: 1,
        eventId: event.eventId,
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
        v: 1,
        eventId: event.eventId,
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
          v: 1,
          eventId: event.eventId,
          type: "session.cancelled",
          sessionId,
          ...(event.payload.reason ? { reason: event.payload.reason } : {}),
          timestamp: event.createdAt,
        };
      }

      if (event.payload.exitKind === "error") {
        return {
          v: 1,
          eventId: event.eventId,
          type: "session.failed",
          sessionId,
          error: event.payload.reason ?? "Provider session exited with an error",
          timestamp: event.createdAt,
        };
      }

      return { v: 1, eventId: event.eventId, type: "session.completed", sessionId, exitCode: null, timestamp: event.createdAt };
    case "request.opened":
      return {
        v: 1,
        eventId: event.eventId,
        type: "request.opened",
        sessionId,
        requestId: getRequestId(event),
        requestType: event.payload.requestType,
        ...(event.payload.detail ? { detail: event.payload.detail } : {}),
        timestamp: event.createdAt,
      };
    case "request.resolved":
      return {
        v: 1,
        eventId: event.eventId,
        type: "request.resolved",
        sessionId,
        requestId: getRequestId(event),
        decision: event.payload.decision ?? "unknown",
        timestamp: event.createdAt,
      };
    case "tool.progress":
      return {
        v: 1,
        eventId: event.eventId,
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
        v: 1,
        eventId: event.eventId,
        type: "runtime.error",
        sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.itemId ? { itemId: event.itemId } : {}),
        error: event.payload.message,
        ...(event.payload.class ? { class: event.payload.class } : {}),
        ...(event.payload.terminal ? { terminal: event.payload.terminal } : {}),
        timestamp: event.createdAt,
      };
    case "runtime.warning":
      return {
        v: 1,
        eventId: event.eventId,
        type: "runtime.warning",
        sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.itemId ? { itemId: event.itemId } : {}),
        message: event.payload.message,
        timestamp: event.createdAt,
      };
    case "rate.limit":
      return {
        v: 1,
        eventId: event.eventId,
        type: "session.rate_limited",
        sessionId,
        status: event.payload.rateLimitInfo.status,
        resetsAt: event.payload.rateLimitInfo.resetsAt,
        rateLimitType: event.payload.rateLimitInfo.rateLimitType,
        ...(event.payload.rateLimitInfo.utilization !== undefined
          ? { utilization: event.payload.rateLimitInfo.utilization }
          : {}),
        ...(event.payload.rateLimitInfo.surpassedThreshold !== undefined
          ? { surpassedThreshold: event.payload.rateLimitInfo.surpassedThreshold }
          : {}),
        isUsingOverage: event.payload.rateLimitInfo.isUsingOverage,
        timestamp: event.createdAt,
      };
    case "api.retry":
      return {
        v: 1,
        eventId: event.eventId,
        type: "session.api_retry",
        sessionId,
        attempt: event.payload.attempt,
        maxAttempts: event.payload.maxAttempts,
        error: event.payload.error,
        delayMs: event.payload.delayMs,
        timestamp: event.createdAt,
      };
    default: {
      const passthroughEvent = event as ProviderRuntimeEvent & {
        type: string;
        payload: unknown;
      };

      return {
        eventId: passthroughEvent.eventId,
        type: "event.passthrough",
        sessionId,
        ...(passthroughEvent.turnId ? { turnId: passthroughEvent.turnId } : {}),
        originalType: passthroughEvent.type,
        ...(passthroughEvent.provider ? { provider: passthroughEvent.provider } : {}),
        rawPayload: {
          payload: passthroughEvent.payload,
          eventId: passthroughEvent.eventId,
          threadId: passthroughEvent.threadId,
          ...(passthroughEvent.itemId ? { itemId: passthroughEvent.itemId } : {}),
          ...(passthroughEvent.requestId ? { requestId: passthroughEvent.requestId } : {}),
          ...(passthroughEvent.v !== undefined ? { v: passthroughEvent.v } : {}),
        },
        timestamp: passthroughEvent.createdAt,
      };
    }
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
